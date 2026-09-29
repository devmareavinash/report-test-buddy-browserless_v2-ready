"""
Snowflake connector sidecar — SSO (external browser) and key-pair (JWT) auth.

SSO login opens in a browser on the machine running this service (VDI/desktop),
not in the end-user's React tab. Key-pair uses a private key file/PEM on this host.
Connections are cached per connector_id.
"""

from __future__ import annotations

import logging
import os
import sys
import tempfile
import threading
from typing import Any

import snowflake.connector
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("snowflake-sso")

app = FastAPI(title="Snowflake Connector", version="1.1.0")

_connections: dict[str, Any] = {}
_lock = threading.Lock()
DEFAULT_LOGIN_TIMEOUT = 120


def is_sso_auth(authenticator: str | None) -> bool:
    a = (authenticator or "password").strip().lower()
    return a in ("sso", "externalbrowser") or a.startswith("http")


def is_keypair_auth(authenticator: str | None, auth_method: str | None = None) -> bool:
    if (auth_method or "").strip().lower() == "keypair":
        return True
    a = (authenticator or "").strip().lower()
    return a in ("snowflake_jwt", "keypair", "key_pair")


def normalize_account(account: str | None, host: str | None) -> str:
    raw = (account or host or "").strip()
    raw = raw.replace("https://", "").replace("http://", "")
    raw = raw.rstrip("/")
    if raw.endswith(".snowflakecomputing.com"):
        raw = raw[: -len(".snowflakecomputing.com")]
    return raw


def normalize_private_key_pem(raw: str) -> str:
    """Accept real PEM or JSON-escaped PEM (literal \\n) pasted from a payload."""
    text = (raw or "").strip()
    if (text.startswith('"') and text.endswith('"')) or (text.startswith("'") and text.endswith("'")):
        text = text[1:-1].strip()
    text = text.replace("\\r\\n", "\n").replace("\\r", "\n").replace("\\n", "\n")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    return text.strip() + "\n"


def require_user(connector: dict[str, Any]) -> str:
    user = (connector.get("username") or connector.get("user") or "").strip()
    if not user:
        raise ValueError(
            "Snowflake username is required (error 251005). "
            "Set Username in Settings → Warehouses for SSO and key-pair login."
        )
    return user


def connect_params(connector: dict[str, Any]) -> dict[str, Any]:
    account = normalize_account(connector.get("account"), connector.get("host"))
    if not account:
        raise ValueError("Snowflake connector is missing 'account'")

    warehouse = (connector.get("warehouse") or "").strip()
    role = (connector.get("role") or "").strip()
    if not warehouse or not role:
        raise ValueError("Snowflake connector requires warehouse and role")

    auth = (connector.get("authenticator") or connector.get("auth_method") or "sso").strip()
    auth_method = (connector.get("auth_method") or "").strip()
    user = require_user(connector)

    params: dict[str, Any] = {
        "account": account,
        "user": user,
        "warehouse": warehouse,
        "role": role,
    }

    database = (connector.get("database") or "").strip()
    schema = (connector.get("schema") or "").strip()
    if database:
        params["database"] = database
    if schema:
        params["schema"] = schema

    auth_lower = auth.lower()
    if is_keypair_auth(auth, auth_method):
        params["authenticator"] = "SNOWFLAKE_JWT"
        key_path = (connector.get("private_key_path") or "").strip()
        key_pem = (connector.get("private_key_pem") or "").strip()
        passphrase = connector.get("private_key_passphrase")
        if passphrase is not None:
            passphrase = str(passphrase).strip() or None

        if key_path:
            if not os.path.isfile(key_path):
                raise ValueError(f"Private key file not found on SSO host: {key_path}")
            params["private_key_file"] = key_path
            if passphrase:
                params["private_key_file_pwd"] = passphrase
        elif key_pem:
            # Write PEM to a temp file — connector prefers file path for encrypted keys.
            key_pem = normalize_private_key_pem(key_pem)
            fd, tmp = tempfile.mkstemp(suffix=".p8", prefix="sf_pk_")
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    f.write(key_pem)
                params["private_key_file"] = tmp
                params["_temp_private_key_file"] = tmp
                if passphrase:
                    params["private_key_file_pwd"] = passphrase
            except Exception:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise
        else:
            raise ValueError(
                "Key-pair auth requires private_key_path (file on this host) or private_key_pem"
            )
    elif auth_lower in ("sso", "externalbrowser"):
        if not sys.stdin.isatty():
            raise ValueError(
                "Snowflake SSO (externalbrowser) needs an interactive desktop. "
                "This host is not a TTY (typical on AWS Fargate). "
                "Use key-pair (private_key_pem) or a Programmatic Access Token instead."
            )
        params["authenticator"] = "externalbrowser"
        params["login_timeout"] = DEFAULT_LOGIN_TIMEOUT
    elif auth_lower.startswith("http"):
        if not sys.stdin.isatty():
            raise ValueError(
                "IdP SSO also needs an interactive desktop. "
                "On AWS Fargate use key-pair (private_key_pem) or a Programmatic Access Token."
            )
        params["authenticator"] = auth
        params["login_timeout"] = DEFAULT_LOGIN_TIMEOUT
    else:
        raise ValueError(
            "This service handles SSO (externalbrowser) and key-pair (SNOWFLAKE_JWT) only"
        )

    # Corp VDI Docker: traffic goes through Skyhigh MITM — hostname/cert mismatch unless
    # the Bayer root CA is installed in the image. Prefer SNOWFLAKE_INSECURE_SSL=true on
    # VDI; leave unset on AWS ECS (direct TLS to Snowflake).
    insecure = os.environ.get("SNOWFLAKE_INSECURE_SSL", "").strip().lower()
    if insecure in ("1", "true", "yes") or (
        insecure != "false"
        and bool(os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY"))
    ):
        params["insecure_mode"] = True

    return params


def get_connection(connector_id: str, connector: dict[str, Any]):
    with _lock:
        conn = _connections.get(connector_id)
        if conn is not None:
            try:
                cur = conn.cursor()
                cur.execute("SELECT 1")
                cur.close()
                return conn
            except Exception:
                logger.info("Dropping stale Snowflake connection for %s", connector_id)
                try:
                    conn.close()
                except Exception:
                    pass
                _connections.pop(connector_id, None)

        auth = connector.get("authenticator") or connector.get("auth_method") or "sso"
        mode = "keypair" if is_keypair_auth(str(auth), connector.get("auth_method")) else "sso"
        logger.info("Opening Snowflake %s connection for %s", mode, connector_id)
        params = connect_params(connector)
        temp_key = params.pop("_temp_private_key_file", None)
        try:
            conn = snowflake.connector.connect(**params)
        finally:
            if temp_key:
                try:
                    os.unlink(temp_key)
                except OSError:
                    pass
        _connections[connector_id] = conn
        return conn


def run_query(connector_id: str, connector: dict[str, Any], sql: str, limit: int) -> dict[str, Any]:
    conn = get_connection(connector_id, connector)
    cur = conn.cursor()
    auth = connector.get("authenticator") or connector.get("auth_method") or "sso"
    auth_mode = "keypair" if is_keypair_auth(str(auth), connector.get("auth_method")) else "sso"
    try:
        cur.execute(sql)
        cols = [d[0] for d in (cur.description or [])]
        rows_raw = cur.fetchmany(limit + 1)
        row_count = len(rows_raw)
        rows_raw = rows_raw[:limit]
        rows = []
        for arr in rows_raw:
            row: dict[str, Any] = {}
            for i, name in enumerate(cols):
                val = arr[i]
                if hasattr(val, "isoformat"):
                    val = val.isoformat()
                row[name] = val
            rows.append(row)
        scalar = None
        if len(rows) == 1 and len(cols) == 1:
            scalar = rows[0][cols[0]]
        return {
            "ok": True,
            "columns": cols,
            "row_count": row_count,
            "rows": rows,
            "scalar": scalar,
            "auth_mode": auth_mode,
        }
    finally:
        cur.close()


class ConnectorPayload(BaseModel):
    id: str | None = None
    account: str | None = None
    host: str | None = None
    database: str | None = None
    schema: str | None = None
    warehouse: str | None = None
    role: str | None = None
    username: str | None = None
    authenticator: str | None = "sso"
    auth_method: str | None = None
    private_key_path: str | None = None
    private_key_pem: str | None = None
    private_key_passphrase: str | None = None


class QueryRequest(BaseModel):
    connector_id: str
    connector: ConnectorPayload
    sql: str
    limit: int = Field(default=5, ge=1, le=100)


class TestRequest(BaseModel):
    connector_id: str
    connector: ConnectorPayload


def _assert_supported(connector: dict[str, Any]) -> str:
    auth = connector.get("authenticator") or connector.get("auth_method") or "sso"
    auth_method = connector.get("auth_method")
    if is_keypair_auth(str(auth), auth_method):
        return "keypair"
    if is_sso_auth(str(auth)):
        return "sso"
    raise HTTPException(
        status_code=400,
        detail="This service only handles SSO (externalbrowser) and key-pair (SNOWFLAKE_JWT)",
    )


@app.get("/healthz")
def healthz() -> dict[str, bool]:
    return {"ok": True}


@app.post("/v1/test")
def test_connection(req: TestRequest) -> dict[str, Any]:
    connector = req.connector.model_dump()
    mode = _assert_supported(connector)

    try:
        result = run_query(req.connector_id, connector, "SELECT CURRENT_VERSION()", 1)
        version = result.get("scalar") or (result["rows"][0] if result["rows"] else None)
        return {
            "ok": True,
            "auth_mode": mode,
            "version": version,
            "message": f"Snowflake {mode} connection successful",
        }
    except Exception as exc:
        logger.exception("%s test failed for %s", mode, req.connector_id)
        return {"ok": False, "auth_mode": mode, "error": str(exc)}


@app.post("/v1/query")
def query(req: QueryRequest) -> dict[str, Any]:
    connector = req.connector.model_dump()
    mode = _assert_supported(connector)

    try:
        return run_query(req.connector_id, connector, req.sql, req.limit)
    except Exception as exc:
        logger.exception("Query failed for %s", req.connector_id)
        return {"ok": False, "auth_mode": mode, "error": str(exc)}


@app.delete("/v1/connections/{connector_id}")
def drop_connection(connector_id: str) -> dict[str, bool]:
    with _lock:
        conn = _connections.pop(connector_id, None)
    if conn:
        try:
            conn.close()
        except Exception:
            pass
    return {"ok": True}

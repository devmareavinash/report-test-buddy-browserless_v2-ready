import { corsHeaders } from "../_shared/cors.ts";
import { getSupabaseForRequest, requireAuth } from "../_shared/auth.ts";
import {
  callSnowflakeSso,
  interpretSnowflakeError,
  normalizeSnowflakeAuth,
  resolveAuthMode,
  snowflakeConfigured,
  snowflakeSidecarConnector,
} from "../_shared/snowflake-auth.ts";

function normalizeHost(v?: string | null): string {
  return (v || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .replace(/\.snowflakecomputing\.com$/i, "");
}

async function testPasswordOrToken(connector: Record<string, unknown>): Promise<Record<string, unknown>> {
  const account = normalizeHost(connector.account as string) || normalizeHost(connector.host as string);
  if (!account) throw new Error("Snowflake connector is missing 'account'");

  const tokenName = connector.token_secret_ref as string | undefined;
  const token = tokenName ? Deno.env.get(tokenName) : undefined;
  const authMode = token ? "token" : "password";

  let authHeader: string;
  let tokenType: string;

  if (token) {
    authHeader = `Bearer ${token}`;
    tokenType = "OAUTH";
  } else {
    const username = connector.username as string | undefined;
    const passRef = connector.password_secret_ref as string | undefined;
    const password = passRef ? (Deno.env.get(passRef) ?? passRef) : undefined;
    if (!username || !password) throw new Error("Username and password required for password auth");

    const loginUrl = `https://${account}.snowflakecomputing.com/session/v1/login-request?` +
      new URLSearchParams({
        ...(connector.warehouse ? { warehouse: String(connector.warehouse) } : {}),
        ...(connector.database ? { databaseName: String(connector.database) } : {}),
        ...(connector.schema ? { schemaName: String(connector.schema) } : {}),
        ...(connector.role ? { roleName: String(connector.role) } : {}),
      }).toString();
    const loginRes = await fetch(loginUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        data: {
          LOGIN_NAME: username,
          PASSWORD: password,
          ACCOUNT_NAME: account,
          CLIENT_APP_ID: "ReportTestBuddyConnectivity",
          CLIENT_APP_VERSION: "1.0",
        },
      }),
    });
    const loginText = await loginRes.text();
    let loginJson: Record<string, unknown> = {};
    try {
      loginJson = loginText ? JSON.parse(loginText) : {};
    } catch { /* */ }
    const loginData = loginJson.data as Record<string, unknown> | undefined;
    if (!loginRes.ok || loginJson?.success === false || !loginData?.token) {
      const msg = String(loginJson?.message || loginData?.errorCode || loginText || `Login HTTP ${loginRes.status}`);
      throw new Error(`Snowflake login failed: ${msg}`);
    }
    authHeader = `Snowflake Token="${loginData.token}"`;
    tokenType = "SESSION";
  }

  const sql = "SELECT CURRENT_VERSION()";
  if (tokenType === "OAUTH") {
    const sfRes = await fetch(`https://${account}.snowflakecomputing.com/api/v2/statements`, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "X-Snowflake-Authorization-Token-Type": "OAUTH",
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        statement: sql,
        timeout: 30,
        ...(connector.database ? { database: connector.database } : {}),
        ...(connector.schema ? { schema: connector.schema } : {}),
        ...(connector.warehouse ? { warehouse: connector.warehouse } : {}),
        ...(connector.role ? { role: connector.role } : {}),
      }),
    });
    const sfText = await sfRes.text();
    let sfJson: Record<string, unknown> = {};
    try {
      sfJson = sfText ? JSON.parse(sfText) : {};
    } catch { /* */ }
    if (!sfRes.ok) throw new Error(String(sfJson?.message || sfText));
    const rows = (sfJson.data as unknown[][]) || [];
    const version = rows[0]?.[0];
    return { ok: true, auth_mode: authMode, version, message: "Snowflake connection successful" };
  }

  const reqId = crypto.randomUUID();
  const qRes = await fetch(
    `https://${account}.snowflakecomputing.com/queries/v1/query-request?requestId=${reqId}`,
    {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
        Accept: "application/snowflake",
      },
      body: JSON.stringify({ sqlText: sql, asyncExec: false, sequenceId: 1, querySubmissionTime: Date.now() }),
    },
  );
  const qJson = await qRes.json();
  if (!qRes.ok || qJson?.success === false) {
    throw new Error(String(qJson?.message || qJson?.data?.errorCode || "Query failed"));
  }
  const rowset = qJson?.data?.rowset as unknown[][] | undefined;
  const version = rowset?.[0]?.[0];
  return { ok: true, auth_mode: authMode, version, message: "Snowflake connection successful" };
}

async function testViaSidecar(connector: Record<string, unknown>): Promise<Record<string, unknown>> {
  const connectorId = String(connector.id || crypto.randomUUID());
  return callSnowflakeSso("/v1/test", {
    connector_id: connectorId,
    connector: snowflakeSidecarConnector(connector),
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const unauthorized = await requireAuth(req);
  if (unauthorized) return unauthorized;

  try {
    const body = await req.json();
    const sb = getSupabaseForRequest(req);

    let connector: Record<string, unknown> | null = null;
    if (body.connector_id) {
      const { data } = await sb.from("warehouse_connectors").select("*").eq("id", body.connector_id).maybeSingle();
      connector = data as Record<string, unknown> | null;
      if (!connector) throw new Error("Warehouse connector not found");
    } else if (body.connector && typeof body.connector === "object") {
      const norm = normalizeSnowflakeAuth({
        auth_method: body.connector.auth_method,
        authenticator: body.connector.authenticator ?? body.connector.extra?.authenticator,
        password_secret_ref: body.connector.password_secret_ref,
        token_secret_ref: body.connector.token_secret_ref,
        extra: body.connector.extra,
      });
      connector = {
        ...body.connector,
        auth_method: norm.auth_method,
        password_secret_ref: norm.password_secret_ref,
        token_secret_ref: norm.token_secret_ref,
        extra: norm.extra,
      };
    } else {
      throw new Error("Provide connector_id or connector payload");
    }

    if (!snowflakeConfigured(connector as any)) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "Incomplete Snowflake configuration. Account, warehouse, role, and username are required. " +
            "Password needs a password; SSO needs username; key-pair needs username + private key path or PEM.",
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const authMode = resolveAuthMode(connector as any);

    try {
      const result = (authMode === "sso" || authMode === "keypair")
        ? await testViaSidecar(connector)
        : await testPasswordOrToken(connector);
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (err: unknown) {
      const raw = String((err as Error)?.message || err);
      return new Response(
        JSON.stringify({
          ok: false,
          auth_mode: authMode,
          error: interpretSnowflakeError(raw, authMode),
          hints: authMode === "sso"
            ? [
              "SSO only works on your VDI desktop, not on AWS Fargate.",
              "On AWS: switch this warehouse to Key pair (paste PEM) or Password + a Snowflake Programmatic Access Token.",
            ]
            : authMode === "keypair"
            ? [
              "Test locally first with scripts/dev-sso.ps1 (sidecar on http://127.0.0.1:8002).",
              "On this VDI a Windows .p8 path works; paste the PEM if the same connector will run on AWS.",
              "Public key must be set on the Snowflake user (ALTER USER … SET RSA_PUBLIC_KEY).",
            ]
            : [],
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e as Error)?.message || e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

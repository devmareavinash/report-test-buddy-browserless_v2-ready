// Snowflake auth helpers — password, OAuth token, SSO (external browser), and key-pair (JWT).

export function isSsoAuth(authenticator?: string | null): boolean {
  const a = (authenticator || "password").trim().toLowerCase();
  return a === "sso" || a === "externalbrowser" || a.startsWith("http");
}

export function isKeypairAuth(authenticator?: string | null, authMethod?: string | null): boolean {
  if ((authMethod || "").trim().toLowerCase() === "keypair") return true;
  const a = (authenticator || "").trim().toLowerCase();
  return a === "snowflake_jwt" || a === "keypair" || a === "key_pair";
}

export function normalizeSnowflakeAuth(input: {
  auth_method?: string | null;
  authenticator?: string | null;
  password_secret_ref?: string | null;
  token_secret_ref?: string | null;
  extra?: Record<string, unknown> | null;
}): {
  auth_method: string;
  authenticator: string;
  password_secret_ref: string | null;
  token_secret_ref: string | null;
  extra: Record<string, unknown>;
} {
  const auth = (input.authenticator || input.auth_method || "password").trim();
  const extra = { ...(input.extra || {}) };

  if (input.token_secret_ref?.trim()) {
    return {
      auth_method: "token",
      authenticator: "token",
      password_secret_ref: null,
      token_secret_ref: input.token_secret_ref.trim(),
      extra: { ...extra, authenticator: "token" },
    };
  }
  if (isKeypairAuth(auth, input.auth_method)) {
    return {
      auth_method: "keypair",
      authenticator: "SNOWFLAKE_JWT",
      password_secret_ref: null,
      token_secret_ref: null,
      extra: { ...extra, authenticator: "SNOWFLAKE_JWT" },
    };
  }
  if (isSsoAuth(auth)) {
    const normalized = auth.toLowerCase().startsWith("http") ? auth : "sso";
    return {
      auth_method: "sso",
      authenticator: normalized,
      password_secret_ref: null,
      token_secret_ref: null,
      extra: { ...extra, authenticator: normalized },
    };
  }
  return {
    auth_method: "password",
    authenticator: "password",
    password_secret_ref: input.password_secret_ref?.trim() || null,
    token_secret_ref: null,
    extra: { ...extra, authenticator: "password" },
  };
}

export function connectorAuthenticator(connector: {
  auth_method?: string | null;
  extra?: Record<string, unknown> | null;
}): string {
  const extra = (connector.extra || {}) as Record<string, unknown>;
  const fromExtra = typeof extra.authenticator === "string" ? extra.authenticator : "";
  return fromExtra || connector.auth_method || "password";
}

export function snowflakeConfigured(connector: {
  account?: string | null;
  host?: string | null;
  warehouse?: string | null;
  role?: string | null;
  username?: string | null;
  password_secret_ref?: string | null;
  token_secret_ref?: string | null;
  auth_method?: string | null;
  extra?: Record<string, unknown> | null;
}): boolean {
  const account = (connector.account || connector.host || "").trim();
  const warehouse = (connector.warehouse || "").trim();
  const role = (connector.role || "").trim();
  if (!account || !warehouse || !role) return false;

  const auth = connectorAuthenticator(connector);
  if (connector.token_secret_ref?.trim()) return true;

  const user = (connector.username || "").trim();
  if (isKeypairAuth(auth, connector.auth_method)) {
    const extra = (connector.extra || {}) as Record<string, unknown>;
    const keyPath = typeof extra.private_key_path === "string" ? extra.private_key_path.trim() : "";
    const keyPem = typeof extra.private_key_pem === "string" ? extra.private_key_pem.trim() : "";
    return Boolean(user && (keyPath || keyPem));
  }
  if (isSsoAuth(auth) || connector.auth_method === "sso") {
    // Snowflake connector requires user even for externalbrowser (error 251005).
    return Boolean(user);
  }
  return Boolean(user && (connector.password_secret_ref || "").trim());
}

export type SnowflakeAuthMode = "sso" | "password" | "token" | "keypair";

export function resolveAuthMode(connector: {
  token_secret_ref?: string | null;
  auth_method?: string | null;
  extra?: Record<string, unknown> | null;
}): SnowflakeAuthMode {
  if (connector.token_secret_ref?.trim()) return "token";
  const auth = connectorAuthenticator(connector);
  if (isKeypairAuth(auth, connector.auth_method) || connector.auth_method === "keypair") return "keypair";
  if (isSsoAuth(auth) || connector.auth_method === "sso") return "sso";
  return "password";
}

export function interpretSnowflakeError(raw: string, authMode: SnowflakeAuthMode): string {
  const lower = raw.toLowerCase();
  if (lower.includes("251005") || lower.includes("user is empty")) {
    return (
      "Snowflake username is required. Enter your Snowflake login name (USER) in Settings → Warehouses. " +
      "SSO and key-pair auth both need a username."
    );
  }
  if (authMode === "sso") {
    if (lower.includes("<!doctype html") || lower.includes("cannot connect") || lower.includes("mwg-internal")) {
      return (
        "Cannot reach the Snowflake SSO service. Corporate proxy is intercepting the call to the SSO sidecar. " +
        "Native Deno: SNOWFLAKE_SSO_URL=http://127.0.0.1:8002 and NO_PROXY=127.0.0.1,localhost. " +
        "Docker Compose: SNOWFLAKE_SSO_URL=http://host.docker.internal:8002 and include host.docker.internal in NO_PROXY; " +
        "run scripts/dev-sso.ps1 on the VDI so externalbrowser can open."
      );
    }
    if (lower.includes("incorrect username or password") || lower.includes("250001")) {
      return (
        "Snowflake SSO login failed. The 'incorrect username or password' message is misleading for SSO — " +
        "complete the browser login on the machine running the Snowflake SSO service (your VDI/backend host), " +
        "confirm account/warehouse/role, and retry within the login timeout (~2 minutes)."
      );
    }
    if (lower.includes("eof when reading a line") || lower.includes("eoferror") || lower.includes("not a tty")) {
      return (
        "Snowflake SSO (external browser) cannot run on AWS Fargate — there is no desktop to complete Bayer login. " +
        "Use Key pair (paste the .p8 PEM in Settings) or a Programmatic Access Token as Password. " +
        "SSO still works on your VDI via scripts/dev-sso.ps1."
      );
    }
    if (lower.includes("login timeout") || lower.includes("timeout")) {
      return (
        "Snowflake SSO login timed out. A browser window should open on the backend host — sign in there and retry."
      );
    }
  }
  if (authMode === "keypair") {
    if (lower.includes("invalid symbol 92") || lower.includes("unable to load pem")) {
      return (
        "The pasted PEM still has JSON escape characters (literal \\n). " +
        "Either use the VDI file path C:\\Users\\EASXP\\.snowflake\\rsa_key.p8 and leave the PEM box empty, " +
        "or paste the key with real line breaks (not the characters backslash-n)."
      );
    }
    if (lower.includes("password was not given") || (lower.includes("encrypted") && lower.includes("password"))) {
      return (
        "This private key is encrypted. Enter the private key passphrase in Settings → Warehouses " +
        "(the field is required for a .p8 that starts with BEGIN ENCRYPTED PRIVATE KEY)."
      );
    }
    if (lower.includes("jwt token is invalid") || lower.includes("390144") || lower.includes("390143")) {
      return (
        "Snowflake rejected the JWT (390144). The .p8 and passphrase are fine. " +
        "User/public-key mismatch: the Username in Settings must be the Snowflake user that has this key's public half " +
        "(ALTER USER <user> SET RSA_PUBLIC_KEY='…'). Ask the admin who issued the key which USER it was registered on."
      );
    }
    if (lower.includes("jwt") || lower.includes("private key")) {
      return (
        "Key-pair auth failed. Confirm the private key (VDI file path or pasted PEM) is valid, " +
        "the public key is registered on the Snowflake user (ALTER USER … SET RSA_PUBLIC_KEY), " +
        "and the username matches that user."
      );
    }
  }
  return raw;
}

/** Avoid corporate proxies intercepting localhost — use loopback IP instead. */
export function resolveSnowflakeSsoUrl(): string {
  const raw = (Deno.env.get("SNOWFLAKE_SSO_URL") || "").trim().replace(/\/$/, "");
  if (!raw) return "";
  try {
    const u = new URL(raw);
    if (u.hostname === "localhost") u.hostname = "127.0.0.1";
    return u.toString().replace(/\/$/, "");
  } catch {
    return raw.replace(/localhost/gi, "127.0.0.1");
  }
}

export async function callSnowflakeSso(
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const ssoUrl = resolveSnowflakeSsoUrl();
  if (!ssoUrl) {
    throw new Error(
      "Snowflake SSO is not configured. Set SNOWFLAKE_SSO_URL (e.g. http://127.0.0.1:8002) on the backend host.",
    );
  }
  const resp = await fetch(`${ssoUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(text || `SSO service HTTP ${resp.status}`);
  }
  if (!resp.ok) {
    throw new Error(String(data.detail || data.error || text || `SSO service HTTP ${resp.status}`));
  }
  if (data.ok === false) {
    throw new Error(String(data.error || "Snowflake SSO request failed"));
  }
  return data;
}

/** Payload fields the Python sidecar needs for SSO / key-pair. */
export function snowflakeSidecarConnector(connector: Record<string, unknown>): Record<string, unknown> {
  const extra = (connector.extra || {}) as Record<string, unknown>;
  return {
    account: connector.account,
    host: connector.host,
    database: connector.database,
    schema: connector.schema,
    warehouse: connector.warehouse,
    role: connector.role,
    username: connector.username,
    authenticator: connectorAuthenticator(connector as any),
    auth_method: connector.auth_method,
    private_key_path: typeof extra.private_key_path === "string" ? extra.private_key_path : null,
    private_key_pem: typeof extra.private_key_pem === "string" ? extra.private_key_pem : null,
    private_key_passphrase: typeof extra.private_key_passphrase === "string"
      ? extra.private_key_passphrase
      : null,
  };
}

import { invokeFunction } from "@/lib/functions";

export type SfAuthMethod = "password" | "sso" | "token" | "keypair";

/** Real PEM, or JSON-escaped PEM with literal \n pasted from a payload. */
export function normalizePrivateKeyPem(raw: string): string {
  let text = raw.trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1).trim();
  }
  return text.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\r/g, "\n").trim() + "\n";
}

export function resolveSfAuthMethod(authenticator?: string | null, authMethod?: string | null): SfAuthMethod {
  if (authMethod === "token" || authMethod === "sso" || authMethod === "keypair") return authMethod;
  const a = (authenticator || authMethod || "password").toLowerCase();
  if (a === "externalbrowser" || a === "sso") return "sso";
  if (a.startsWith("http")) return "sso";
  if (a === "token") return "token";
  if (a === "snowflake_jwt" || a === "keypair" || a === "key_pair") return "keypair";
  return "password";
}

export function snowflakePayload(
  fields: {
    name: string;
    kind: string;
    account: string;
    host: string;
    database: string;
    schema: string;
    warehouse: string;
    role: string;
    username: string;
    password_secret_ref: string;
    token_secret_ref: string;
    private_key_path?: string;
    private_key_pem?: string;
    private_key_passphrase?: string;
  },
  sfAuthMethod: SfAuthMethod,
  idpUrl: string,
) {
  const authenticator = sfAuthMethod === "sso"
    ? (idpUrl.trim() || "sso")
    : sfAuthMethod === "token"
    ? "token"
    : sfAuthMethod === "keypair"
    ? "SNOWFLAKE_JWT"
    : "password";

  const extra: Record<string, string> = { authenticator };
  if (sfAuthMethod === "keypair") {
    if (fields.private_key_path?.trim()) extra.private_key_path = fields.private_key_path.trim();
    if (fields.private_key_pem?.trim()) extra.private_key_pem = normalizePrivateKeyPem(fields.private_key_pem);
    if (fields.private_key_passphrase?.trim()) extra.private_key_passphrase = fields.private_key_passphrase.trim();
  }

  return {
    name: fields.name,
    kind: fields.kind,
    account: fields.account || null,
    host: fields.host || null,
    database: fields.database || null,
    schema: fields.schema || null,
    warehouse: fields.warehouse || null,
    role: fields.role || null,
    username: fields.username || null,
    password_secret_ref: sfAuthMethod === "password" ? (fields.password_secret_ref || null) : null,
    token_secret_ref: sfAuthMethod === "token" ? (fields.token_secret_ref || null) : null,
    auth_method: sfAuthMethod,
    extra,
  };
}

export async function testWarehouseConnectivity(connector: Record<string, unknown>) {
  return invokeFunction("test-warehouse-connectivity", { connector });
}

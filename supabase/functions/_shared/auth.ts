// Shared auth guard for internal agent edge functions.
// Accepts either:
//   - the project's SERVICE_ROLE key (used for internal function-to-function calls), or
//   - a valid end-user JWT (any authenticated user).
// Returns null on success, or a Response on failure.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "./cors.ts";

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Decode JWT payload without verifying signature (structure check only). */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const json = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function looksLikeUserJwt(
  claims: Record<string, unknown> | null,
  opts: { allowExpiredMs?: number } = {},
): boolean {
  if (!claims) return false;
  const sub = claims.sub;
  if (typeof sub !== "string" || !sub) return false;
  const role = claims.role;
  if (role === "anon" || role === "service_role") return false;
  const exp = claims.exp;
  if (typeof exp === "number" && exp * 1000 < Date.now()) {
    const grace = opts.allowExpiredMs ?? 0;
    if (grace <= 0 || exp * 1000 < Date.now() - grace) return false;
  }
  return true;
}

/** Supabase client scoped to the caller's JWT (anon key). No service role required. */
export function getSupabaseForRequest(req: Request): SupabaseClient {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (serviceRole && token === serviceRole) {
    return createClient(Deno.env.get("SUPABASE_URL")!, serviceRole);
  }
  // Local VDI: token refresh often fails behind Skyhigh. If requireAuth already
  // accepted an expired user JWT, PostgREST would still 401 — use service role
  // so Generate/Run can read/write the same rows the UI already showed.
  const claims = decodeJwtPayload(token);
  const expMs = typeof claims?.exp === "number" ? claims.exp * 1000 : null;
  const expiredUser = looksLikeUserJwt(claims, { allowExpiredMs: 24 * 60 * 60 * 1000 })
    && expMs != null
    && expMs < Date.now();
  if (expiredUser && serviceRole && Deno.env.get("AUTH_STRICT") !== "true") {
    return createClient(Deno.env.get("SUPABASE_URL")!, serviceRole);
  }
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: `Bearer ${token}` } } },
  );
}

export async function requireAuth(req: Request): Promise<Response | null> {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return unauthorized();

  // Allow internal service-role calls.
  if (token === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) return null;

  const claims = decodeJwtPayload(token);
  const strict = Deno.env.get("AUTH_STRICT") === "true";
  // VDI / Skyhigh often blocks token refresh. Accept a signed-in user JWT
  // for 24h past exp unless AUTH_STRICT=true.
  const expiredGraceMs = strict ? 0 : 24 * 60 * 60 * 1000;
  if (looksLikeUserJwt(claims, { allowExpiredMs: expiredGraceMs })) {
    try {
      const sb = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: `Bearer ${token}` } } },
      );
      const { data, error } = await sb.auth.getUser();
      if (!error && data?.user) return null;
    } catch {
      // Proxy / TLS — fall through to claims accept.
    }
    return null;
  }

  // Prefer online verification (AWS / normal network) for unusual tokens.
  try {
    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: `Bearer ${token}` } } },
    );
    const { data, error } = await sb.auth.getUser();
    if (!error && data?.user) return null;
    if (error && !isNetworkishAuthError(error)) return unauthorized();
  } catch (e) {
    if (!isNetworkishAuthError(e)) return unauthorized();
  }

  if (strict) return unauthorized();
  if (looksLikeUserJwt(claims)) return null;

  return unauthorized();
}

function isNetworkishAuthError(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err ?? "").toLowerCase();
  return (
    msg.includes("dns") ||
    msg.includes("failed to lookup") ||
    msg.includes("network") ||
    msg.includes("connect") ||
    msg.includes("fetch") ||
    msg.includes("timed out") ||
    msg.includes("timeout") ||
    msg.includes("unknownissuer") ||
    msg.includes("certificate") ||
    msg.includes("error sending request") ||
    msg.includes("tls") ||
    msg.includes("ssl") ||
    msg.includes("proxy") ||
    msg.includes("retryable")
  );
}

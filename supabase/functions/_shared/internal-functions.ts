// Resolve edge-function URLs for server-to-server calls (e.g. agent-orchestrate → run-warehouse-sql).

function cloudFunctionsBase(): string {
  const project = (Deno.env.get("SUPABASE_URL") || "").trim().replace(/\/$/, "");
  return project ? `${project}/functions/v1` : "";
}

function localFunctionsBase(): string {
  const explicit = (Deno.env.get("LOCAL_FUNCTIONS_URL") || Deno.env.get("WAREHOUSE_FUNCTIONS_URL") || "")
    .trim()
    .replace(/\/$/, "");
  if (explicit) return explicit;
  // ECS / local Deno gateway: never fall back to hosted Edge (150s idle timeout).
  if (Deno.env.get("FORCE_CLOUD_FUNCTIONS") === "true") return "";
  // Hosted Edge runtime (Lovable Cloud): there is no local gateway on 127.0.0.1.
  // @ts-ignore EdgeRuntime is a hosted-runtime global
  if (typeof EdgeRuntime !== "undefined") return "";
  return "http://127.0.0.1:8000/functions/v1";
}

export function resolveFunctionUrl(name: string): string {
  const localBase = localFunctionsBase();
  if (localBase) return `${localBase}/${name}`;
  return `${cloudFunctionsBase()}/${name}`;
}

export function shouldUseLocalFunctions(_name: string): boolean {
  return Boolean(localFunctionsBase());
}

/** Which credential internal calls use. "service" is required for long runs. */
export function internalAuthSource(): "service" | "caller" {
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ? "service" : "caller";
}

// Internal function-to-function calls always use server access when available,
// so background work never depends on the (1h) user token of whoever clicked Run.
export function resolveFunctionAuth(_name: string, callerAuthorization?: string | null): string {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (serviceKey) return `Bearer ${serviceKey}`;
  console.warn(JSON.stringify({ evt: "internal_call_auth", auth_source: "caller", warning: "SUPABASE_SERVICE_ROLE_KEY missing; long runs will fail when the user token expires" }));
  return callerAuthorization?.trim() || "";
}

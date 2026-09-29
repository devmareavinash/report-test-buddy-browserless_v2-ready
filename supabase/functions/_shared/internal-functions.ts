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

export function resolveFunctionAuth(name: string, callerAuthorization?: string | null): string {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (shouldUseLocalFunctions(name)) {
    return callerAuthorization?.trim() || (serviceKey ? `Bearer ${serviceKey}` : "");
  }
  return serviceKey ? `Bearer ${serviceKey}` : (callerAuthorization?.trim() || "");
}

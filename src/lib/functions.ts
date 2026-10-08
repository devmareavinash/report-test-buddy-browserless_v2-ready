import { supabase } from "@/integrations/supabase/client";

type InvokeResult<T = any> = { data: T | null; error: Error | null };

const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
const useCloudFunctions = import.meta.env.VITE_USE_CLOUD_FUNCTIONS === "true";
const configuredBase = (import.meta.env.VITE_FUNCTIONS_BASE_URL as string | undefined)?.replace(/\/$/, "");

function shouldUseLocalBackend(_name: string) {
  // Hosted Edge idle-kills Playwright at 150s. Default is same-origin Deno
  // (Vite proxy locally, nginx → :8000 on AWS). Opt back into Edge only with
  // VITE_USE_CLOUD_FUNCTIONS=true.
  if (useCloudFunctions) return false;
  return true;
}

function functionsBaseUrl() {
  if (configuredBase) return configuredBase;
  return "";
}

function jwtExpMs(token: string): number | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const json = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    const exp = (JSON.parse(json) as { exp?: number }).exp;
    return typeof exp === "number" ? exp * 1000 : null;
  } catch {
    return null;
  }
}

async function authHeaders(forceRefresh = false) {
  let { data } = await supabase.auth.getSession();
  let token = data.session?.access_token || "";
  const expMs = token ? jwtExpMs(token) : null;
  if (token && (forceRefresh || (expMs != null && expMs < Date.now() + 60_000))) {
    try {
      const refreshed = await supabase.auth.refreshSession();
      if (refreshed.data.session?.access_token) {
        token = refreshed.data.session.access_token;
      } else if (forceRefresh) {
        throw new Error("Session refresh returned no access token");
      }
    } catch (error) {
      if (forceRefresh) {
        throw new Error(
          `Could not refresh the login session before starting the run: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      // VDI proxy can block refresh; send the existing token (local Deno
      // accepts a recently expired user JWT).
    }
  }
  // Long runs on our own server refresh the sign-in with this token (kept in memory only).
  const refreshToken = forceRefresh && import.meta.env.VITE_RUN_SESSION_REFRESH === "true" ? (await supabase.auth.getSession()).data.session?.refresh_token : undefined;
  token = token || publishableKey || "";
  return {
    ...(refreshToken ? { "X-Refresh-Token": refreshToken } : {}),
    "Content-Type": "application/json",
    ...(publishableKey ? { apikey: publishableKey } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export async function invokeFunction<T = any>(name: string, body: any): Promise<InvokeResult<T>> {
  if (!shouldUseLocalBackend(name)) {
    const { data, error } = await supabase.functions.invoke(name, { body });
    return { data: (data as T) ?? null, error: error ? new Error(error.message) : null };
  }

  try {
    const path = `/functions/v1/${name}`;
    const response = await fetch(`${functionsBaseUrl()}${path}`, {
      method: "POST",
      // Long workstream runs must begin with a full token lifetime. Internal
      // child calls inherit this token, and no service-role key is required.
      headers: await authHeaders(name === "agent-orchestrate"),
      body: JSON.stringify(body ?? {}),
    });
    const text = await response.text();
    let payload: any = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        const snippet = text.replace(/\s+/g, " ").slice(0, 180);
        return {
          data: null,
          error: new Error(
            response.ok
              ? `Expected JSON from ${name}, got: ${snippet}`
              : `Edge function returned ${response.status} (non-JSON): ${snippet}`,
          ),
        };
      }
    }
    if (!response.ok) {
      const activeRun = payload?.active_run_id
        ? ` Active run: ${String(payload.active_run_id).slice(0, 8)}.`
        : "";
      const message =
        payload?.message ||
        payload?.error ||
        `Edge function returned ${response.status}: ${response.statusText}`;
      return {
        data: payload,
        error: new Error(`${message}${activeRun}`),
      };
    }
    return { data: payload as T, error: null };
  } catch (error: any) {
    return { data: null, error: new Error(error?.message || String(error)) };
  }
}
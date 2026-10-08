// Keeps a long run signed in when no service-role key is available
// (self-hosted Docker/AWS). The browser sends its refresh token once when the
// run starts; it is kept in memory only (never stored in the database) and
// swapped for a fresh access token shortly before the current one expires.
//
// CAUTION: the auth server rotates refresh tokens. If the browser later
// refreshes with the same token after the server already did, reuse detection
// can revoke the whole session (user signed out, run loses access). Opt-in only
// via VITE_RUN_SESSION_REFRESH=true on the frontend.
//
// Child report orchestrations run in the same Deno process (backend/server.ts),
// so they borrow the parent's session via the in-memory registry by run id.

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

function jwtExpMs(token: string): number | null {
  try {
    const p = token.split(".")[1];
    const json = JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof json.exp === "number" ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

export class RunSession {
  private accessToken: string;
  private refreshToken: string | null;
  private inflight: Promise<string> | null = null;

  constructor(accessToken: string, refreshToken: string | null) {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
  }

  get canRefresh(): boolean {
    return Boolean(this.refreshToken);
  }

  /** Current valid access token, refreshing first if it expires soon. */
  async token(): Promise<string> {
    const exp = jwtExpMs(this.accessToken);
    if (!this.refreshToken || exp == null || exp - Date.now() > REFRESH_MARGIN_MS) {
      return this.accessToken;
    }
    if (!this.inflight) {
      this.inflight = this.refresh().finally(() => { this.inflight = null; });
    }
    return this.inflight;
  }

  private async refresh(): Promise<string> {
    const url = `${(Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "")}/auth/v1/token?grant_type=refresh_token`;
    const anon = Deno.env.get("SUPABASE_ANON_KEY") || "";
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: anon },
        body: JSON.stringify({ refresh_token: this.refreshToken }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.access_token) {
        console.error(JSON.stringify({ evt: "run_session_refresh_failed", status: r.status, error: j?.error_description || j?.msg || j?.error }));
        return this.accessToken;
      }
      this.accessToken = j.access_token;
      if (j.refresh_token) this.refreshToken = j.refresh_token;
      console.log(JSON.stringify({ evt: "run_session_refreshed", auth_source: "caller_refreshed", exp: jwtExpMs(this.accessToken) }));
      return this.accessToken;
    } catch (e) {
      console.error(JSON.stringify({ evt: "run_session_refresh_failed", error: String(e) }));
      return this.accessToken;
    }
  }
}

const registry = new Map<string, RunSession>();

export function registerRunSession(runId: string, s: RunSession) {
  registry.set(runId, s);
}
export function getRunSession(runId: string | null | undefined): RunSession | undefined {
  return runId ? registry.get(runId) : undefined;
}
export function releaseRunSession(runId: string) {
  registry.delete(runId);
}

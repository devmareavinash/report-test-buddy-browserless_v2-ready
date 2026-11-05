/**
 * Lightweight Browserless health probe for orchestrate terminalization.
 * Does not restart containers — only reports reachability.
 */

export type BrowserlessHealth = {
  ok: boolean;
  reason: string | null;
  status: number | null;
  checked_at: string;
};

function browserlessBase(): string {
  const host = (Deno.env.get("BROWSERLESS_HOST") || "http://127.0.0.1:3000").replace(/\/$/, "");
  return host;
}

function browserlessToken(): string {
  return Deno.env.get("BROWSERLESS_TOKEN") || "local-dev-token";
}

export async function checkBrowserlessHealth(
  opts?: { timeoutMs?: number },
): Promise<BrowserlessHealth> {
  const timeoutMs = Math.max(1000, Math.min(15_000, opts?.timeoutMs ?? 4000));
  const base = browserlessBase();
  const token = browserlessToken();
  const url = `${base}/pressure?token=${encodeURIComponent(token)}`;
  const checked_at = new Date().toISOString();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { method: "GET", signal: ctrl.signal });
    if (!resp.ok) {
      return {
        ok: false,
        reason: `browserless_pressure_http_${resp.status}`,
        status: resp.status,
        checked_at,
      };
    }
    return { ok: true, reason: null, status: resp.status, checked_at };
  } catch (e) {
    const msg = String((e as any)?.message || e || "browserless_unreachable");
    const aborted = /abort/i.test(msg);
    return {
      ok: false,
      reason: aborted ? "browserless_pressure_timeout" : `browserless_unreachable:${msg.slice(0, 160)}`,
      status: null,
      checked_at,
    };
  } finally {
    clearTimeout(timer);
  }
}

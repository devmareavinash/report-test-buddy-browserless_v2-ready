/** Browserless OSS debugger UI (live screencast is Cloud/Enterprise only). */
const DEFAULT_DEBUG_URL = "http://127.0.0.1:3000/debugger/?token=local-dev-token";

/** Absolute URL for the Browserless debugger tab opened by "Run headed". */
export function browserlessDebuggerUrl(): string {
  const raw = String(import.meta.env.VITE_BROWSERLESS_DEBUG_URL || "").trim();
  if (raw) return normalizeDebuggerUrl(raw);
  return DEFAULT_DEBUG_URL;
}

/** Ensure the path is /debugger/ — root `/` 404s on Browserless Chromium v2 OSS. */
export function normalizeDebuggerUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const path = (u.pathname || "/").replace(/\/+$/, "") || "/";
    // Bare host or accidental `/` → debugger UI. Keep other explicit paths.
    if (path === "/") u.pathname = "/debugger/";
    else if (/^\/debugger$/i.test(path)) u.pathname = "/debugger/";
    if (!u.searchParams.has("token") && /127\.0\.0\.1|localhost/i.test(u.hostname)) {
      u.searchParams.set("token", "local-dev-token");
    }
    return u.toString();
  } catch {
    return DEFAULT_DEBUG_URL;
  }
}

/**
 * Open the Browserless debugger in the user's Chrome/default browser so they can
 * watch the headed CDP session. Returns false if the popup was blocked.
 */
export function openHeadedLiveBrowser(url = browserlessDebuggerUrl()): boolean {
  const href = normalizeDebuggerUrl(url);
  const win = window.open(href, "rtb-headed-browser", "noopener,noreferrer");
  return Boolean(win);
}

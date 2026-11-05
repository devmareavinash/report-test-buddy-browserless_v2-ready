// Persist Playwright storageState (cookies + origin localStorage) per credential
// profile so Browserless /chromium/function runs can skip MicroStrategy login
// on subsequent executions. Cookie values are never logged.

import { authSessionLog } from "./auth-session-log.ts";

export type PlaywrightStorageState = {
  cookies?: Array<Record<string, unknown>>;
  origins?: Array<{
    origin?: string;
    localStorage?: Array<{ name?: string; value?: string }>;
  }>;
};

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000; // 12h — MSTR sessions usually die sooner
const ERROR_TRUNCATE = 240;

export function sanitizeProfileId(profileId: string): string | null {
  const id = String(profileId || "").trim();
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(id)) return null;
  return id;
}

export function isValidStorageState(state: unknown): state is PlaywrightStorageState {
  if (!state || typeof state !== "object") return false;
  const s = state as PlaywrightStorageState;
  const hasCookies = Array.isArray(s.cookies) && s.cookies.length > 0;
  const hasOrigins = Array.isArray(s.origins) && s.origins.some(
    (o) => o && typeof o.origin === "string" && Array.isArray(o.localStorage) && o.localStorage.length > 0,
  );
  return hasCookies || hasOrigins;
}

/** Pathname only — never includes query/hash (may hold session tokens). */
export function pathnameOnly(url: unknown): string | null {
  if (typeof url !== "string" || !url.trim()) return null;
  try {
    return new URL(url, "http://localhost").pathname || null;
  } catch {
    return null;
  }
}

/** Truncate and strip query-like fragments from error text before logging. */
export function sanitizeErrorMessage(err: unknown): string | null {
  if (err == null) return null;
  let s = String(err).replace(/\s+/g, " ").trim();
  if (!s) return null;
  s = s.replace(/[?&]([^=\s]+)=([^&\s]*)/g, "[redacted]");
  if (s.length > ERROR_TRUNCATE) s = `${s.slice(0, ERROR_TRUNCATE)}…`;
  return s;
}

export function ioErrorCategory(error: unknown): string {
  const name = String((error as { name?: string })?.name || "");
  const msg = String((error as { message?: string })?.message || error || "");
  const blob = `${name} ${msg}`;
  if (/NotFound/i.test(name) || /os error 2|ENOENT/i.test(blob)) return "not_found";
  if (/SyntaxError|JSON|Unexpected token|parse/i.test(blob)) return "parse_error";
  if (/Permission|EACCES|EPERM|AccessDenied/i.test(blob)) return "permission_error";
  if (/Busy|locked|EBUSY|EAGAIN|Sharing/i.test(blob)) return "file_busy";
  if (/ENOSPC|No space/i.test(blob)) return "disk_full";
  return "io_error";
}

/**
 * Conservative login-page signal from a final URL pathname (no query).
 * Matches path *segments* only so report titles like AuthenticationReport do not clear.
 */
export function looksLikeLoginPageUrl(url: unknown): boolean {
  const path = pathnameOnly(url);
  if (!path) return false;
  return /(?:^|\/)(?:login|signin|sign-in|logon|auth|authentication)(?:\/|$)/i.test(path);
}

export function shouldClearAuthSession(extracted: unknown): boolean {
  const walk = (v: unknown, depth = 0): boolean => {
    if (!v || typeof v !== "object" || depth > 6) return false;
    const o = v as Record<string, unknown>;
    const err = String(o.error || o.message || "");
    // Dead/expired MicroStrategy sessions often surface as login failures.
    if (/LOGIN_FAILED|AUTH_REQUIRED|session\s*expir/i.test(err)) return true;
    if (looksLikeLoginPageUrl(o.url) || looksLikeLoginPageUrl(o.final_url)) return true;
    if (o.result && walk(o.result, depth + 1)) return true;
    if (o.extracted && walk(o.extracted, depth + 1)) return true;
    return false;
  };
  return walk(extracted);
}

/**
 * Fresh-login retry + session clear is allowed only on explicit auth failure.
 * Generic empty/partial KPI extraction must NOT clear a reusable session.
 */
export function shouldRetryAuthSessionFresh(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  return shouldClearAuthSession(p) || shouldClearAuthSession(p.extracted);
}

function isNoiseExtractionKey(k: string): boolean {
  const n = String(k || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!n || String(k || "").startsWith("__")) return true;
  return [
    "filtersapplied", "screenshot", "ok", "error", "url", "title", "note",
    "result", "extracted", "navigation", "message", "value",
  ].includes(n);
}

function hasUsefulExtractedValue(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === "number" || typeof v === "boolean") return true;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  // Chart/grid shaped payloads.
  if (Array.isArray(o.columns) || Array.isArray(o.rows) || Array.isArray(o.data)) {
    return Boolean((o.columns as unknown[])?.length || (o.rows as unknown[])?.length || (o.data as unknown[])?.length);
  }
  return Object.entries(o).some(([k, nested]) => {
    if (isNoiseExtractionKey(k)) return false;
    return hasUsefulExtractedValue(nested);
  });
}

function countExtractionKeys(v: unknown, depth = 0): { useful: number; empty: number } {
  if (depth > 5 || v == null) return { useful: 0, empty: 0 };
  if (typeof v === "number" || typeof v === "boolean") return { useful: 1, empty: 0 };
  if (typeof v === "string") return v.trim() ? { useful: 1, empty: 0 } : { useful: 0, empty: 1 };
  if (Array.isArray(v)) {
    return v.length ? { useful: 1, empty: 0 } : { useful: 0, empty: 1 };
  }
  if (typeof v !== "object") return { useful: 0, empty: 0 };
  const o = v as Record<string, unknown>;
  if (Array.isArray(o.columns) || Array.isArray(o.rows) || Array.isArray(o.data)) {
    const n = (o.columns as unknown[])?.length || (o.rows as unknown[])?.length || (o.data as unknown[])?.length || 0;
    return n ? { useful: 1, empty: 0 } : { useful: 0, empty: 1 };
  }
  let useful = 0;
  let empty = 0;
  for (const [k, nested] of Object.entries(o)) {
    if (isNoiseExtractionKey(k)) continue;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const inner = countExtractionKeys(nested, depth + 1);
      useful += inner.useful;
      empty += inner.empty;
    } else if (hasUsefulExtractedValue(nested)) {
      useful += 1;
    } else {
      empty += 1;
    }
  }
  return { useful, empty };
}

/** Shape-only summary for logs — never includes KPI values. */
export function summarizeExtractionShape(payload: unknown): {
  extracted_ok: boolean | null;
  error: string | null;
  url_path: string | null;
  useful_key_count: number;
  empty_key_count: number;
  unusable: boolean;
  partial: boolean;
} {
  const p = (payload && typeof payload === "object") ? payload as Record<string, unknown> : null;
  const extracted = (p?.extracted && typeof p.extracted === "object")
    ? p.extracted as Record<string, unknown>
    : p;
  const result = extracted && typeof extracted === "object"
    ? ((extracted as Record<string, unknown>).result
      ?? (extracted as Record<string, unknown>).extracted
      ?? extracted)
    : null;
  const counts = countExtractionKeys(result);
  const unusable = extractionLooksUnusable(payload);
  return {
    extracted_ok: extracted && typeof extracted === "object" && "ok" in extracted
      ? Boolean((extracted as Record<string, unknown>).ok)
      : (p && "ok" in p ? Boolean(p.ok) : null),
    error: sanitizeErrorMessage(
      (extracted && typeof extracted === "object" && (extracted as any).error)
        || (p && p.error)
        || null,
    ),
    url_path: pathnameOnly(
      (extracted && typeof extracted === "object" && ((extracted as any).url || (extracted as any).final_url))
        || p?.url
        || null,
    ),
    useful_key_count: counts.useful,
    empty_key_count: counts.empty,
    unusable,
    // Partial: some KPI keys present and useful, others empty, without auth failure.
    partial: !shouldClearAuthSession(payload) && counts.useful > 0 && counts.empty > 0,
  };
}

/**
 * True when a playwright-runtime payload has no usable KPI/grid values.
 * Used for diagnostics and save gating — NOT for clearing a reusable session.
 */
export function extractionLooksUnusable(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return true;
  const p = payload as Record<string, unknown>;
  if (p.error || p.ok === false) return true;
  if (shouldClearAuthSession(p) || shouldClearAuthSession(p.extracted)) return true;
  const extracted = (p.extracted && typeof p.extracted === "object")
    ? p.extracted as Record<string, unknown>
    : p;
  if (extracted.ok === false || extracted.error) return true;
  const result = extracted.result ?? extracted.extracted ?? extracted;
  if (result == null) return true;
  if (typeof result !== "object") return !hasUsefulExtractedValue(result);
  const note = String((result as Record<string, unknown>).note || "");
  if (/invalid JavaScript and was skipped|regenerate the script/i.test(note)) return true;
  return !hasUsefulExtractedValue(result);
}

export function shouldSaveAuthSession(extracted: unknown, capturedState: unknown): boolean {
  // Never refresh a session from an auth failure or empty/failed scrape — that
  // extends the TTL of expired MicroStrategy cookies and keeps brand runs empty.
  if (shouldClearAuthSession(extracted)) return false;
  if (extractionLooksUnusable(
    extracted && typeof extracted === "object" && "extracted" in (extracted as object)
      ? extracted
      : { extracted },
  )) return false;
  return isValidStorageState(capturedState);
}

function sessionTtlMs(): number {
  const n = Number(Deno.env.get("AUTH_SESSION_TTL_MS") || DEFAULT_TTL_MS);
  return Number.isFinite(n) && n >= 60_000 ? n : DEFAULT_TTL_MS;
}

function defaultSessionDir(): string {
  // Prefer repo-root .auth-sessions (stable) over Deno.cwd() (backend/).
  try {
    const u = new URL("../../../.auth-sessions", import.meta.url);
    if (u.protocol === "file:") {
      let p = decodeURIComponent(u.pathname);
      if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
      return p;
    }
  } catch { /* fall through */ }
  return `${Deno.cwd()}/.auth-sessions`;
}

function sessionDir(): string {
  const fromEnv = (Deno.env.get("AUTH_SESSION_DIR") || "").trim();
  if (fromEnv) return fromEnv.replace(/[/\\]+$/, "");
  return defaultSessionDir();
}

function sessionPath(profileId: string): string | null {
  const id = sanitizeProfileId(profileId);
  if (!id) return null;
  return `${sessionDir()}/${id}.json`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (e) {
    if ((e as { name?: string })?.name === "NotFound") return false;
    throw e;
  }
}

async function uniqueCorruptPath(activePath: string): Promise<string> {
  let candidate = `${activePath}.corrupt`;
  if (!(await pathExists(candidate))) return candidate;
  for (let i = 0; i < 50; i++) {
    candidate = `${activePath}.corrupt.${Date.now()}.${i}`;
    if (!(await pathExists(candidate))) return candidate;
  }
  return `${activePath}.corrupt.${crypto.randomUUID()}`;
}

/** Promote tmp → active without deleting the previous file until replace succeeds. */
async function replaceActiveSessionFile(tmp: string, path: string): Promise<void> {
  try {
    await Deno.rename(tmp, path);
    return;
  } catch {
    // Windows: rename onto existing dest fails. Move active aside first.
  }
  const bak = `${path}.${crypto.randomUUID()}.bak`;
  let movedAside = false;
  try {
    try {
      await Deno.rename(path, bak);
      movedAside = true;
    } catch (e) {
      if ((e as { name?: string })?.name !== "NotFound") throw e;
    }
    await Deno.rename(tmp, path);
    if (movedAside) {
      try {
        await Deno.remove(bak);
      } catch { /* bak left behind is safer than losing the session */ }
    }
  } catch (e) {
    if (movedAside) {
      try {
        await Deno.rename(bak, path);
      } catch { /* best effort restore */ }
    }
    throw e;
  }
}

async function quarantineSessionFile(
  profileId: string,
  activePath: string,
  category: string,
): Promise<string | null> {
  try {
    if (!(await pathExists(activePath))) return null;
    const dest = await uniqueCorruptPath(activePath);
    await Deno.rename(activePath, dest);
    authSessionLog("auth_session_quarantined", {
      profile: sanitizeProfileId(profileId),
      reason: category,
      // Basename only — never the full synced folder path with user identity.
      quarantine_name: dest.split(/[/\\]/).pop() || "corrupt",
    });
    return dest;
  } catch (e) {
    authSessionLog("auth_session_quarantine_failed", {
      profile: sanitizeProfileId(profileId),
      error_category: ioErrorCategory(e),
    });
    return null;
  }
}

type StoredEnvelope = {
  savedAt: string;
  storageState: PlaywrightStorageState;
};

export async function loadAuthSession(profileId: string): Promise<PlaywrightStorageState | null> {
  const path = sessionPath(profileId);
  if (!path) return null;
  try {
    const raw = await Deno.readTextFile(path);
    let parsed: StoredEnvelope;
    try {
      parsed = JSON.parse(raw) as StoredEnvelope;
    } catch (e) {
      authSessionLog("auth_session_load_failed", {
        profile: sanitizeProfileId(profileId),
        error_category: "parse_error",
      });
      await quarantineSessionFile(profileId, path, "parse_error");
      return null;
    }
    if (!parsed?.savedAt || !isValidStorageState(parsed.storageState)) {
      authSessionLog("auth_session_load_failed", {
        profile: sanitizeProfileId(profileId),
        error_category: "invalid_envelope",
      });
      await quarantineSessionFile(profileId, path, "invalid_envelope");
      return null;
    }
    const age = Date.now() - Date.parse(parsed.savedAt);
    if (!Number.isFinite(age) || age < 0 || age > sessionTtlMs()) {
      await clearAuthSession(profileId, "ttl_expired");
      return null;
    }
    return parsed.storageState;
  } catch (e) {
    if ((e as { name?: string })?.name === "NotFound") return null;
    const category = ioErrorCategory(e);
    authSessionLog("auth_session_load_failed", {
      profile: sanitizeProfileId(profileId),
      error_category: category,
    });
    await quarantineSessionFile(profileId, path, category);
    return null;
  }
}

export async function saveAuthSession(profileId: string, storageState: unknown): Promise<boolean> {
  const path = sessionPath(profileId);
  if (!path || !isValidStorageState(storageState)) return false;
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await Deno.mkdir(sessionDir(), { recursive: true });
    const envelope: StoredEnvelope = {
      savedAt: new Date().toISOString(),
      storageState: {
        cookies: storageState.cookies || [],
        origins: storageState.origins || [],
      },
    };
    const body = JSON.stringify(envelope);
    await Deno.writeTextFile(tmp, body);
    // Write temp fully, then rename into place. Previous active file is only
    // moved aside on Windows after tmp exists; restore bak if promote fails.
    await replaceActiveSessionFile(tmp, path);
    authSessionLog("auth_session_saved", {
      profile: sanitizeProfileId(profileId),
      cookies: envelope.storageState.cookies?.length || 0,
      origins: envelope.storageState.origins?.length || 0,
    });
    return true;
  } catch (e) {
    try {
      await Deno.remove(tmp);
    } catch { /* best-effort temp cleanup */ }
    authSessionLog("auth_session_save_failed", {
      profile: sanitizeProfileId(profileId),
      error_category: ioErrorCategory(e),
    });
    return false;
  }
}

export async function clearAuthSession(
  profileId: string,
  reason: string = "explicit_clear",
): Promise<void> {
  const path = sessionPath(profileId);
  if (!path) return;
  try {
    await Deno.remove(path);
    authSessionLog("auth_session_cleared", {
      profile: sanitizeProfileId(profileId),
      reason,
    });
  } catch (e) {
    if ((e as { name?: string })?.name !== "NotFound") {
      authSessionLog("auth_session_clear_failed", {
        profile: sanitizeProfileId(profileId),
        error_category: ioErrorCategory(e),
        reason,
      });
    }
  }
}

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

export function shouldClearAuthSession(extracted: unknown): boolean {
  const walk = (v: unknown): boolean => {
    if (!v || typeof v !== "object") return false;
    const o = v as Record<string, unknown>;
    const err = String(o.error || o.message || "");
    // Dead/expired MicroStrategy sessions often surface as login failures.
    if (/LOGIN_FAILED|AUTH_REQUIRED|session\s*expir/i.test(err)) return true;
    if (o.result && walk(o.result)) return true;
    if (o.extracted && walk(o.extracted)) return true;
    return false;
  };
  return walk(extracted);
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

/**
 * True when a playwright-runtime payload has no usable KPI/grid values.
 * Used to invalidate a reused browser session and retry with a fresh login.
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
  // Never refresh a session from an empty/failed scrape — that extends the
  // TTL of expired MicroStrategy cookies and keeps brand runs empty.
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

type StoredEnvelope = {
  savedAt: string;
  storageState: PlaywrightStorageState;
};

export async function loadAuthSession(profileId: string): Promise<PlaywrightStorageState | null> {
  const path = sessionPath(profileId);
  if (!path) return null;
  try {
    const raw = await Deno.readTextFile(path);
    const parsed = JSON.parse(raw) as StoredEnvelope;
    if (!parsed?.savedAt || !isValidStorageState(parsed.storageState)) return null;
    const age = Date.now() - Date.parse(parsed.savedAt);
    if (!Number.isFinite(age) || age < 0 || age > sessionTtlMs()) {
      await clearAuthSession(profileId);
      return null;
    }
    return parsed.storageState;
  } catch (e) {
    if ((e as { name?: string })?.name === "NotFound") return null;
    authSessionLog("auth_session_load_failed", { profile: sanitizeProfileId(profileId) });
    return null;
  }
}

export async function saveAuthSession(profileId: string, storageState: unknown): Promise<boolean> {
  const path = sessionPath(profileId);
  if (!path || !isValidStorageState(storageState)) return false;
  try {
    await Deno.mkdir(sessionDir(), { recursive: true });
    const envelope: StoredEnvelope = {
      savedAt: new Date().toISOString(),
      storageState: {
        cookies: storageState.cookies || [],
        origins: storageState.origins || [],
      },
    };
    await Deno.writeTextFile(path, JSON.stringify(envelope));
    authSessionLog("auth_session_saved", {
      profile: sanitizeProfileId(profileId),
      cookies: envelope.storageState.cookies?.length || 0,
      origins: envelope.storageState.origins?.length || 0,
    });
    return true;
  } catch {
    authSessionLog("auth_session_save_failed", { profile: sanitizeProfileId(profileId) });
    return false;
  }
}

export async function clearAuthSession(profileId: string): Promise<void> {
  const path = sessionPath(profileId);
  if (!path) return;
  try {
    await Deno.remove(path);
    authSessionLog("auth_session_cleared", { profile: sanitizeProfileId(profileId) });
  } catch (e) {
    if ((e as { name?: string })?.name !== "NotFound") {
      authSessionLog("auth_session_clear_failed", { profile: sanitizeProfileId(profileId) });
    }
  }
}

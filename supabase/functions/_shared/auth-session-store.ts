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
    if (/LOGIN_FAILED/i.test(err)) return true;
    if (o.result && walk(o.result)) return true;
    if (o.extracted && walk(o.extracted)) return true;
    return false;
  };
  return walk(extracted);
}

export function shouldSaveAuthSession(extracted: unknown, capturedState: unknown): boolean {
  // Save whenever we have cookies and login did not fail — even if the KPI
  // script returned ok:false after auth (session is still reusable).
  if (shouldClearAuthSession(extracted)) return false;
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

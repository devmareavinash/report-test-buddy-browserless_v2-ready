/** Pure helpers mirroring supabase/functions/_shared/auth-session-store.ts (testable in vitest). */

export type PlaywrightStorageState = {
  cookies?: Array<Record<string, unknown>>;
  origins?: Array<{
    origin?: string;
    localStorage?: Array<{ name?: string; value?: string }>;
  }>;
};

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

/** Decide whether a captured Browserless storageState should be persisted. */
export function shouldSaveAuthSession(
  extracted: unknown,
  capturedState: unknown,
): boolean {
  if (shouldClearAuthSession(extracted)) return false;
  return isValidStorageState(capturedState);
}

/** Mirror of gateway extract — storageState rides on the script result. */
export function extractCapturedStorageState(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, any>;
  return p?.extracted?.result?.__storageState
    ?? p?.extracted?.__storageState
    ?? p?.result?.__storageState
    ?? null;
}

export function wrapCodeWithAuthSession(code: string, hasSession: boolean): string {
  // Shape-only check for vitest (full JS wrap lives in auth-session-wrap.ts).
  const src = (code || "").trim();
  if (!src) return src;
  const marked = src.includes("export default") ? src : `export default async ({ page }) => {\n${src}\n};`;
  return `/* auth-session:${hasSession ? "reuse" : "fresh"} */\n${marked}`;
}

/**
 * Pure decision helpers mirroring supabase/functions/_shared/auth-session-store.ts
 * for vitest. FS/atomic/quarantine/diagnostics live backend-only (Deno tests).
 */

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

export function pathnameOnly(url: unknown): string | null {
  if (typeof url !== "string" || !url.trim()) return null;
  try {
    return new URL(url, "http://localhost").pathname || null;
  } catch {
    return null;
  }
}

/** Path-segment login/auth pages only — avoids matching report titles containing "login". */
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
    if (/LOGIN_FAILED|AUTH_REQUIRED|session\s*expir/i.test(err)) return true;
    if (looksLikeLoginPageUrl(o.url) || looksLikeLoginPageUrl(o.final_url)) return true;
    if (o.result && walk(o.result, depth + 1)) return true;
    if (o.extracted && walk(o.extracted, depth + 1)) return true;
    return false;
  };
  return walk(extracted);
}

/** Fresh-login retry only on explicit auth failure — not generic empty KPI extraction. */
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
  if (Array.isArray(o.columns) || Array.isArray(o.rows) || Array.isArray(o.data)) {
    return Boolean((o.columns as unknown[])?.length || (o.rows as unknown[])?.length || (o.data as unknown[])?.length);
  }
  return Object.entries(o).some(([k, nested]) => {
    if (isNoiseExtractionKey(k)) return false;
    return hasUsefulExtractedValue(nested);
  });
}

/** True when a playwright-runtime payload has no usable KPI/grid values. */
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

export function shouldSaveAuthSession(
  extracted: unknown,
  capturedState: unknown,
): boolean {
  if (shouldClearAuthSession(extracted)) return false;
  if (extractionLooksUnusable(
    extracted && typeof extracted === "object" && "extracted" in (extracted as object)
      ? extracted
      : { extracted },
  )) return false;
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
  const src = (code || "").trim();
  if (!src) return src;
  const marked = src.includes("export default") ? src : `export default async ({ page }) => {\n${src}\n};`;
  return `/* auth-session:${hasSession ? "reuse" : "fresh"} */\n${marked}`;
}

// Wraps Playwright script source so Browserless can reuse a persisted
// storageState without changing playwright-runtime. The gateway embeds
// cookies before the user script and returns __storageState on the result.
// Supports both Playwright (context.storageState) and Puppeteer (page.cookies).

import type { PlaywrightStorageState } from "./auth-session-store.ts";

export function wrapCodeWithAuthSession(
  code: string,
  storageState: PlaywrightStorageState | null,
): string {
  let src = (code || "").trim();
  if (!src) return src;
  if (!/export\s+default/.test(src)) {
    src = `export default async ({ page }) => {\n${src}\n};`;
  }
  const stateLit = storageState ? JSON.stringify(storageState) : "null";
  const inner = src.replace(/^[ \t]*export\s+default\s+/m, "const __sessionInnerFn = ");
  // Capture storage even when the user script throws. playwright-runtime wraps
  // __userFn in try/catch and keeps only the message on throw — so we return a
  // failed envelope (ok:false + original error text + __storageState) instead of
  // rethrowing, which would drop captured cookies at the runtime boundary.
  return `const __persistedStorageState = ${stateLit};
${inner}
export default async (ctx) => {
  const page = ctx && ctx.page;
  const browserContext = (ctx && ctx.context)
    || (page && typeof page.context === 'function' ? page.context() : null);

  const restoreCookies = async () => {
    const cookies = __persistedStorageState && Array.isArray(__persistedStorageState.cookies)
      ? __persistedStorageState.cookies
      : [];
    if (!cookies.length) return;
    if (browserContext && typeof browserContext.addCookies === 'function') {
      await browserContext.addCookies(cookies);
      return;
    }
    if (page && typeof page.setCookie === 'function') {
      await page.setCookie(...cookies);
    }
  };

  const restoreOriginStorage = async (navUrl) => {
    if (!page || !__persistedStorageState || !__persistedStorageState.origins || !navUrl) return;
    try {
      const origin = new URL(String(navUrl), 'http://localhost').origin;
      const entry = (__persistedStorageState.origins || []).find((o) => o && o.origin === origin);
      const items = entry && Array.isArray(entry.localStorage) ? entry.localStorage : [];
      if (!items.length) return;
      await page.evaluate((entries) => {
        for (const item of entries) {
          if (!item || item.name == null) continue;
          try { localStorage.setItem(String(item.name), String(item.value == null ? '' : item.value)); } catch {}
        }
      }, items);
    } catch {}
  };

  const captureStorageState = async () => {
    let __storageState = null;
    let captureAttempted = true;
    let captureSucceeded = false;
    try {
      if (browserContext && typeof browserContext.storageState === 'function') {
        const state = await browserContext.storageState();
        const cookieCount = state && Array.isArray(state.cookies) ? state.cookies.length : 0;
        if (state && cookieCount > 0) {
          __storageState = state;
          captureSucceeded = true;
        }
      }
    } catch {}
    if (!__storageState) {
      try {
        if (page && typeof page.cookies === 'function') {
          const cookies = await page.cookies();
          if (cookies && cookies.length) {
            __storageState = { cookies: cookies, origins: [] };
            captureSucceeded = true;
          }
        }
      } catch {}
    }
    return { __storageState, captureAttempted, captureSucceeded };
  };

  try { await restoreCookies(); } catch {}

  if (page && typeof page.goto === 'function') {
    try {
      const _goto = page.goto.bind(page);
      page.goto = async (...args) => {
        const r = await _goto(...args);
        try { await restoreOriginStorage(args && args[0]); } catch {}
        return r;
      };
    } catch {}
  }

  let result = null;
  let extractionError = null;
  try {
    result = await __sessionInnerFn(ctx);
  } catch (e) {
    extractionError = e;
  }

  const captured = await captureStorageState();
  const meta = {
    __authSessionCaptureAttempted: captured.captureAttempted,
    __authSessionCaptureSucceeded: captured.captureSucceeded,
  };

  if (extractionError) {
    const message = String(
      (extractionError && extractionError.message) || extractionError || 'extraction_threw',
    );
    return Object.assign({
      ok: false,
      error: message,
      __storageState: captured.__storageState,
    }, meta);
  }

  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return Object.assign({}, result, { __storageState: captured.__storageState }, meta);
  }
  return Object.assign({ value: result, __storageState: captured.__storageState }, meta);
};
`;
}

export function extractCapturedStorageState(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return null;
  const seen = new Set<unknown>();
  const walk = (v: unknown): unknown => {
    if (!v || typeof v !== "object" || seen.has(v)) return null;
    seen.add(v);
    const o = v as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(o, "__storageState") && o.__storageState) {
      return o.__storageState;
    }
    for (const child of Object.values(o)) {
      const hit = walk(child);
      if (hit) return hit;
    }
    return null;
  };
  return walk(payload);
}

/** Best-effort read of capture flags embedded by the wrap (never logged as secrets). */
export function extractCaptureMeta(payload: unknown): {
  capture_attempted: boolean | null;
  capture_succeeded: boolean | null;
} {
  if (!payload || typeof payload !== "object") {
    return { capture_attempted: null, capture_succeeded: null };
  }
  const seen = new Set<unknown>();
  const walk = (v: unknown): { a: boolean | null; s: boolean | null } | null => {
    if (!v || typeof v !== "object" || seen.has(v)) return null;
    seen.add(v);
    const o = v as Record<string, unknown>;
    if (
      Object.prototype.hasOwnProperty.call(o, "__authSessionCaptureAttempted") ||
      Object.prototype.hasOwnProperty.call(o, "__authSessionCaptureSucceeded")
    ) {
      return {
        a: typeof o.__authSessionCaptureAttempted === "boolean"
          ? o.__authSessionCaptureAttempted
          : null,
        s: typeof o.__authSessionCaptureSucceeded === "boolean"
          ? o.__authSessionCaptureSucceeded
          : null,
      };
    }
    for (const child of Object.values(o)) {
      const hit = walk(child);
      if (hit) return hit;
    }
    return null;
  };
  const hit = walk(payload);
  return {
    capture_attempted: hit?.a ?? null,
    capture_succeeded: hit?.s ?? null,
  };
}

/** Remove cookie payloads and capture flags before the response reaches the browser UI. */
export function stripCapturedStorageState<T>(payload: T): T {
  if (!payload || typeof payload !== "object") return payload;
  const clone = JSON.parse(JSON.stringify(payload)) as any;
  const scrub = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (Object.prototype.hasOwnProperty.call(node, "__storageState")) delete node.__storageState;
    if (Object.prototype.hasOwnProperty.call(node, "__authSessionCaptureAttempted")) {
      delete node.__authSessionCaptureAttempted;
    }
    if (Object.prototype.hasOwnProperty.call(node, "__authSessionCaptureSucceeded")) {
      delete node.__authSessionCaptureSucceeded;
    }
    for (const v of Object.values(node)) scrub(v);
  };
  scrub(clone);
  return clone as T;
}

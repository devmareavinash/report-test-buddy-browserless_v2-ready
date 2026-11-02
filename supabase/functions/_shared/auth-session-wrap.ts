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

  const result = await __sessionInnerFn(ctx);

  let __storageState = null;
  try {
    if (browserContext && typeof browserContext.storageState === 'function') {
      __storageState = await browserContext.storageState();
    }
  } catch {}
  if (!__storageState) {
    try {
      if (page && typeof page.cookies === 'function') {
        const cookies = await page.cookies();
        if (cookies && cookies.length) __storageState = { cookies: cookies, origins: [] };
      }
    } catch {}
  }

  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return Object.assign({}, result, { __storageState: __storageState });
  }
  return { value: result, __storageState: __storageState };
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

/** Remove cookie payloads before the response reaches the browser UI. */
export function stripCapturedStorageState<T>(payload: T): T {
  if (!payload || typeof payload !== "object") return payload;
  const clone = JSON.parse(JSON.stringify(payload)) as any;
  const scrub = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (Object.prototype.hasOwnProperty.call(node, "__storageState")) delete node.__storageState;
    for (const v of Object.values(node)) scrub(v);
  };
  scrub(clone);
  return clone as T;
}

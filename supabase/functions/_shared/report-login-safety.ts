/** Correct known legacy login blocks on execution copies, never database scripts.
 * No browser/runtime dependency: shared by Cloud, local and browser callers.
 */
export function prepareReportLogin(code: string): string {
    if (!code || code.includes("RTB_LOGIN_WAIT_V1")) return code;
    // Only the generated auth race (not filter/data waits) is eligible.
    const race = /await Promise\.race\(\[\s*page\.waitForNavigation\(\{\s*waitUntil:\s*['"]domcontentloaded['"],\s*timeout:\s*15000\s*\}\)\.catch\(\(\)\s*=>\s*null\),\s*(__sleep|sleep)\(3000\),?\s*\]\);/g;
    if (!race.test(code)) return code;
    race.lastIndex = 0;
    let next = code.replace(race, `// RTB_LOGIN_WAIT_V1: observe completion, never navigate or submit again while pending.
      await (async () => {
        const deadline = Date.now() + 15000;
        let clearSince = null;
        while (Date.now() < deadline) {
          let state;
          try {
            state = await page.evaluate(() => {
              const visible = el => Boolean(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
              const inputs = Array.from(document.querySelectorAll('input[type="password"], #Pwd, #Uid, input[placeholder*="user name" i]'));
              const form = inputs.some(visible);
              const rejected = /login\\s*failure|error\\s*in\\s*login|invalid (user|credentials|password)|incorrect (user|password)|account.*(locked|disabled|expired)/i.test(document.body ? document.body.innerText : '');
              const loginPath = /(?:^|\\/)(?:login|signin|sign-in|logon|auth|authentication)(?:\\/|$)/i.test(location.pathname);
              return { form, rejected, loginPath, ready: document.readyState !== 'loading' };
            });
          } catch (_) { state = null; } // Redirects can temporarily destroy the evaluation context.
          if (state && state.rejected) throw new Error('LOGIN_FAILED: report login rejected; no retry permitted');
          if (state && state.ready && !state.form && !state.loginPath) {
            if (clearSince === null) clearSince = Date.now();
            if (Date.now() - clearSince >= 1000) return;
          } else { clearSince = null; }
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        throw new Error('LOGIN_FAILED: sign-in completion not confirmed within 15000ms; no retry permitted');
      })();`);
    // Replace, rather than append to prefilled fields; verify both fields before submit.
    next = next.replace(/await page\.type\((__userSel|userSel|__pwdSel|pwdSel),\s*([^;\n]+?)\)\.catch\(\(\)\s*=>\s*\{\}\);/g,
      (_match, selector: string, value: string) => `await page.evaluate((selector) => {
        const field = document.querySelector(selector);
        if (!field) throw new Error('LOGIN_FAILED: login field unavailable');
        field.value = '';
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
      }, ${selector}).catch(() => { throw new Error('LOGIN_FAILED: login field could not be cleared'); });
      await page.type(${selector}, ${value}).catch(() => { throw new Error('LOGIN_FAILED: login field could not be filled'); });
      const __filled${selector} = await page.evaluate((selector) => {
        const field = document.querySelector(selector); return field ? field.value : null;
      }, ${selector}).catch(() => null);
      if (__filled${selector} !== ${value}) throw new Error('LOGIN_FAILED: login field verification failed');`);
    // Known submit callbacks returned false or swallowed a click failure. Fail before waiting.
    next = next.replace(/\}, (__pwdSel|pwdSel)\)\.catch\(\(\)\s*=>\s*(?:\{\}|false)\);/g,
      "}, $1).catch(() => { throw new Error('LOGIN_FAILED: login submission failed'); }).then(submitted => { if (!submitted) throw new Error('LOGIN_FAILED: login submit control unavailable'); return submitted; });");
    return next;
  }
  
  /** Prevent the runtime's invalid-script login fallback without changing runtime. */
  export function prepareReportExecution(code: string, parse: (source: string, options: any) => unknown): string {
    const next = prepareReportLogin(code);
    if (!next.trim()) return next;
    try {
      parse(/export\s+default/.test(next) ? next : `export default async ({ page }) => {\n${next}\n};`, { ecmaVersion: "latest", sourceType: "module" });
      return next;
    } catch {
      return "export default async () => { throw new Error('LOGIN_FAILED: invalid script; no report login attempted'); };";
    }
  }
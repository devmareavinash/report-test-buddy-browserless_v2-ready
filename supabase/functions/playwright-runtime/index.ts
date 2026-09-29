// Playwright runtime adapter — executes generated scripts via Browserless /function API.
// Configure with BROWSERLESS_TOKEN + BROWSERLESS_HOST (self-hosted OSS or Browserless cloud).

import { corsHeaders } from "../_shared/cors.ts";
import { getSupabase } from "../_shared/llm.ts";
import { getSupabaseForRequest, requireAuth } from "../_shared/auth.ts";
import { fetchCanonicalScript } from "../_shared/canonical-script.ts";

type Mode = "headed" | "headless";

const DEFAULT_OSS_HOST = "http://127.0.0.1:3000";
const DEFAULT_CLOUD_HOST = "production-sfo.browserless.io";
const DEFAULT_BROWSERLESS_TIMEOUT_MS = 420000;

function browserlessTimeoutMs(): number {
  const n = Number(Deno.env.get("BROWSERLESS_TIMEOUT_MS") || DEFAULT_BROWSERLESS_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 60_000 ? n : DEFAULT_BROWSERLESS_TIMEOUT_MS;
}

type BrowserlessRuntime = {
  provider: "browserless";
  token: string;
  baseUrl: string;
  functionPath: string;
  isOss: boolean;
};

function resolveBrowserlessConfig(token: string): BrowserlessRuntime {
  const rawHost = (Deno.env.get("BROWSERLESS_HOST") || "").trim();
  const explicitOss = Deno.env.get("BROWSERLESS_OSS");
  let baseUrl: string;
  let isOss: boolean;

  if (/^https?:\/\//i.test(rawHost)) {
    baseUrl = rawHost.replace(/\/$/, "");
    isOss = explicitOss === "true"
      ? true
      : explicitOss === "false"
        ? false
        : !baseUrl.includes("browserless.io");
  } else if (rawHost) {
    const host = rawHost.replace(/\/$/, "");
    isOss = explicitOss === "true"
      ? true
      : explicitOss === "false"
        ? false
        : !host.includes("browserless.io");
    const useHttps = isOss
      ? Deno.env.get("BROWSERLESS_USE_HTTPS") === "true"
      : Deno.env.get("BROWSERLESS_USE_HTTPS") !== "false";
    baseUrl = `${useHttps ? "https" : "http"}://${host}`;
  } else {
    // No host set: default to local OSS (self-hosted stack / dev).
    baseUrl = DEFAULT_OSS_HOST;
    isOss = explicitOss !== "false";
  }

  const functionPath = isOss ? "/chromium/function" : "/function";
  return { provider: "browserless", token, baseUrl, functionPath, isOss };
}

async function getRuntime(_sb: any): Promise<BrowserlessRuntime | null> {
  const browserlessToken = Deno.env.get("BROWSERLESS_TOKEN");
  if (!browserlessToken) return null;
  return resolveBrowserlessConfig(browserlessToken);
}

const CAPTURE_VIEWPORT = { width: 1920, height: 1080, deviceScaleFactor: 1 };
const CAPTURE_LAUNCH_ARGS = [
  "--ignore-certificate-errors",
  "--window-size=1920,1080",
  "--force-device-scale-factor=1",
];

function launchArgList(): string[] {
  const args = [...CAPTURE_LAUNCH_ARGS];
  const extra = (Deno.env.get("BROWSERLESS_CHROMIUM_ARGS") || "").trim();
  if (extra) {
    for (const raw of extra.split(",")) {
      const flag = raw.trim();
      if (!flag || /^--proxy-server(?:=|$)/i.test(flag)) continue;
      args.push(flag);
    }
  }
  return args;
}

function buildBrowserlessFunctionUrl(rt: BrowserlessRuntime): string {
  const params = new URLSearchParams();
  params.set("token", rt.token);
  params.set("timeout", String(browserlessTimeoutMs()));
  // Browserless v2 only allows token/timeout/launch (JSON) on /chromium/function.
  // Passing `--ignore-certificate-errors=` as an empty query key produces a
  // malformed Chromium flag and can hang launch (WS endpoint timeout → HTTP 500).
  params.set("launch", JSON.stringify({
    args: launchArgList(),
    defaultViewport: CAPTURE_VIEWPORT,
  }));
  return `${rt.baseUrl}${rt.functionPath}?${params.toString()}`;
}

function formatFetchError(err: unknown, label: string): string {
  const e = err as { message?: string; cause?: { message?: string } };
  const cause = e?.cause?.message || e?.message || String(err);
  if (/unknownissuer|certificate|cert/i.test(cause)) {
    return (
      `${label} failed (TLS: ${cause}). ` +
      "On this VDI the corp proxy rewrites HTTPS certs. Restart the backend with scripts/dev-backend.ps1 " +
      "so Deno ignores Skyhigh MITM certificates."
    );
  }
  return `${label} failed: ${cause}`;
}

async function postBrowserless(url: string, token: string, contentType: string, body: string) {
  const budget = browserlessTimeoutMs();
  return await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      Authorization: `Bearer ${token}`,
    },
    body,
    // Slightly above the Browserless session budget so a 408 can surface first.
    signal: AbortSignal.timeout(budget + 15_000),
  });
}

async function callBrowserlessFunction(rt: BrowserlessRuntime, jsCode: string) {
  const url = buildBrowserlessFunctionUrl(rt);
  // OSS /chromium/function schema is only { code, context }. Extra viewport/args/launch
  // fields are rejected (400) and used to 500 on some hosts.
  const jsonBody = JSON.stringify({ code: jsCode, context: {} });
  console.log(
    `playwright-runtime: POST ${rt.functionPath} bytes=${jsonBody.length} timeoutMs=${browserlessTimeoutMs()}`,
  );
  let resp: Response;
  try {
    resp = await postBrowserless(url, rt.token, "application/json", jsonBody);
    if (resp.status === 400 || resp.status === 415 || resp.status === 422) {
      resp = await postBrowserless(url, rt.token, "application/javascript", jsCode);
    }
  } catch (e) {
    throw new Error(formatFetchError(e, `Browserless ${rt.baseUrl}${rt.functionPath}`));
  }
  const text = await resp.text();
  if (!resp.ok) {
    let detail = text;
    if (resp.status === 500 && /internal server error/i.test(text.trim())) {
      detail =
        "Internal Server Error — Chromium failed to launch or crashed. " +
        "Usually a bad launch query flag, OOM from an oversized viewport, or a stuck Browserless container.";
    }
    const looksLikeCodespace = /github\.dev|github\.com|codespace|forwarded port/i.test(rt.baseUrl + " " + text);
    if (resp.status === 401 && (!text || /github|codespace|forwarded port/i.test(text))) {
      detail =
        "401 from the Browserless URL (empty body usually means GitHub Codespaces, not Browserless). " +
        "In the Codespace Ports tab set 3000 to Public, then retry. " +
        `Host: ${rt.baseUrl}`;
    } else if (resp.status === 404 && looksLikeCodespace && !text.trim()) {
      detail =
        `404 from ${rt.baseUrl} (empty body). This VDI cannot reach the Codespace port-forward URL ` +
        "(GitHub returns 404 even when Ports shows 3000 Public). " +
        "Use Docker Desktop Browserless OSS on http://127.0.0.1:3000 instead " +
        "(scripts/dev-browserless.ps1 or docker compose). Restart the local backend after that.";
    } else if (resp.status === 404 && !text.trim()) {
      detail =
        `404 from ${rt.baseUrl}${rt.functionPath} with an empty body. ` +
        "The host is up but this path is missing — confirm BROWSERLESS_OSS=true (OSS uses /chromium/function) " +
        "and that Browserless is running.";
    }
    const err: any = new Error(`browserless ${resp.status}: ${detail}`);
    err.status = resp.status;
    err.body = text;
    throw err;
  }
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

/** Saved scripts waited for Overview "NBRx Total" / grid headers before tab nav. */
function fixEarlyLabelWait(code: string) {
  let out = code;
  // Combo i>0 only: goto → waitForDashboard (grid/KPI labels) → runNav.
  // After a fresh dossier load that wait hits Overview "NBRx Total" or stalls
  // 25s looking for "Performance Trend" / Employee Name before clicking tabs.
  out = out.replace(
    /^([ \t]*)(await page\.goto\(reportUrl,\s*\{[^}]*\}\)\.catch\(\(\)\s*=>\s*\{\}\);)[ \t]*\r?\n(?:[ \t]*await waitForLoadingToFinish\(\);[ \t]*\r?\n)?[ \t]*await waitForDashboard\(\)(?:\.catch\(\(\)\s*=>\s*\{\}\))?;[ \t]*\r?\n([ \t]*)await runNav\(\);/gm,
    "$1$2\n$3await runNav();\n$3await waitForDashboard();",
  );
  // Overview/grid templates: waitForDashboard() then runNav() → nav first, then target-screen wait.
  out = out.replace(
    /^([ \t]*)await waitForDashboard\(\)(?:\.catch\(\(\)\s*=>\s*\{\}\))?;[ \t]*\r?\n([ \t]*)await runNav\(\);/gm,
    "$1await runNav();\n$2await waitForDashboard();",
  );
  // LLM / reference style: waitForDashboard() immediately before NAV_STEPS loop.
  // Keep a load wait only; target-label wait belongs after the loop (callers already have one).
  out = out.replace(
    /^([ \t]*)await waitForDashboard\(\)(?:\.catch\(\(\)\s*=>\s*\{\}\))?;[ \t]*\r?\n([ \t]*)for \(const step of NAV_STEPS\)/gm,
    "$1await waitForLoadingToFinish();\n$2for (const step of NAV_STEPS)",
  );
  // Hardcoded Overview KPI as the only ready signal — also matches login/landing/wrong tab.
  out = out.replace(
    /\.some\(\s*el\s*=>\s*\/NBRx Total\/i\.test\(\s*getDirectText\(\s*el\s*\)\s*\)\s*\)/g,
    `.some(el => /^(Area|Overview|Performance)$/i.test(getDirectText(el)))`,
  );
  // Old grid wait: title OR /employee name|nbrx total/ → Overview tiles count as ready.
  // Require title + Employee Name (or Geography + Employee Name). Keep EXPECTED_COLUMNS
  // checks inside extractOnPageGrid / hasExpected — those run after nav.
  out = out.replace(
    /return blob\.includes\(String\(title \|\| ''\)\.toLowerCase\(\)\) \|\| \/employee name\|nbrx total\/\.test\(blob\);/g,
    "const want = String(title || '').toLowerCase(); " +
    "const hasTitle = !!(want && blob.includes(want)); " +
    "const hasGridHeader = /employee name/.test(blob); " +
    "return (hasTitle && hasGridHeader) || (/geography/.test(want) && hasGridHeader);",
  );
  // Still weaker: title words only ("Performance Trend" tab text). Require Employee Name.
  out = out.replace(
    /return blob\.includes\(String\(title \|\| ''\)\.toLowerCase\(\)\);/g,
    "const want = String(title || '').toLowerCase(); " +
    "const hasTitle = !!(want && blob.includes(want)); " +
    "const hasGridHeader = /employee name/.test(blob); " +
    "return (hasTitle && hasGridHeader) || (/geography/.test(want) && hasGridHeader);",
  );
  // Geography/Trend wait that treated Overview "NBRx Total" as "grid is ready".
  out = out.replace(
    /\/employee name\|nbrx total\//gi,
    "/employee name/",
  );
  // clickByText used to wait for KPI/grid labels after every tab click (wrong tab).
  out = out.replace(
    /^([ \t]*)await waitForLoadingToFinish\(\);[ \t]*\r?\n[ \t]*await waitForDashboard\(\)\.catch\(\(\)\s*=>\s*\{\}\);[ \t]*\r?\n([ \t]*)return res;/gm,
    "$1await waitForLoadingToFinish();\n$2return res;",
  );
  // selectByLabel success paths: spinner only. A full waitForDashboard after every
  // Area/Region/Territory pick stacks 25s+ waits and blows the Browserless budget.
  out = out.replace(
    /^([ \t]*)await waitForLoadingToFinish\(\)(?:\([^)]*\))?;[ \t]*\r?\n[ \t]*await waitForDashboard\(\)(?:\.catch\(\(\)\s*=>\s*\{\}\))?;[ \t]*\r?\n([ \t]*)return \{ ok: true/gm,
    "$1await waitForLoadingToFinish();\n$2return { ok: true",
  );
  out = out.replace(
    /^([ \t]*)await waitForDashboard\(\)(?:\.catch\(\(\)\s*=>\s*\{\}\))?;[ \t]*\r?\n([ \t]*)return \{ ok: true/gm,
    "$2return { ok: true",
  );
  // Cap long ready-wait defaults in saved scripts (45s/25s → 20s/15s).
  out = out.replace(
    /const waitForLoadingToFinish = async \(maxMs = 45000\)/g,
    "const waitForLoadingToFinish = async (maxMs = 20000)",
  );
  out = out.replace(
    /const waitForDossierReady = async \(maxMs = 45000\)/g,
    "const waitForDossierReady = async (maxMs = 25000)",
  );
  out = out.replace(
    /const waitForDashboard = async \(maxMs = 25000\)/g,
    "const waitForDashboard = async (maxMs = 15000)",
  );
  out = out.replace(
    /const waitForDashboard = async \(maxMs = 20000\)/g,
    "const waitForDashboard = async (maxMs = 15000)",
  );
  // Trend wait: tab label + Quarterly radio is not "grid is ready".
  out = out.replace(/\s*if\s*\(\s*hasTitle\s*&&\s*hasGrain\s*\)\s*return\s*true;\s*/g, "\n        ");
  // "Performance" must not click "Performance Trend" (includes + length slack).
  out = out.replace(
    /if \(t !== want && !\(t\.length <= want\.length \+ 16 && t\.includes\(want\)\)\) continue;/g,
    "if (t !== want && !(t.length <= want.length + 16 && t.includes(want) && !(t.startsWith(want) && t.length > want.length && /\\s/.test(t.slice(want.length))))) continue;",
  );
  // Title locator: skip footer/nav tabs so region.top is not below the tab.
  out = out.replace(
    /if \(r\.top > vh \* 0\.88\) continue; \/\/ skip footer(?: nav)? tabs/g,
    "if (r.top > vh * 0.88) continue; // skip footer nav tabs\n" +
      "        if (el.closest && el.closest('[role=\"tab\"], [role=\"tablist\"], [role=\"navigation\"]')) continue;",
  );
  return out;
}

/** Net brace/paren/bracket counts, ignoring quoted strings. */
function braceSignature(code: string): string {
  let curly = 0, paren = 0, square = 0;
  let quote: '"' | "'" | "`" | null = null;
  let escape = false;
  for (const ch of code) {
    if (quote) {
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "{") curly++;
    else if (ch === "}") curly--;
    else if (ch === "(") paren++;
    else if (ch === ")") paren--;
    else if (ch === "[") square++;
    else if (ch === "]") square--;
  }
  return `${curly}:${paren}:${square}`;
}

function sanitizeBrowserlessCode(code: string) {
  const rewritten = fixEarlyLabelWait(code)
    // Remove markdown fences if a generated script was saved verbatim.
    .replace(/^\s*```(?:javascript|js)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    // Saved scripts previously forced CSS zoom 67% (operator-view hack).
    .replace(/style\.zoom\s*=\s*['"]67%['"]/g, "style.zoom = '100%'")
    // Browserless /function rejects Playwright's networkidle lifecycle value.
    // Normalize legacy saved scripts without risking malformed option objects.
    .replace(/waitUntil\s*:\s*(["'])networkidle\1/g, 'waitUntil: "domcontentloaded"')
    .replace(/page\.waitForLoadState\(\s*(["'])networkidle\1\s*\)/g, 'page.waitForLoadState("domcontentloaded")')
    // Replace common LLM placeholders with runtime credentials so saved scripts
    // cannot leak or depend on literal report passwords.
    .replace(/(["'])YOUR_USERNAME_HERE\1/g, "__creds?.username || ''")
    .replace(/(["'])YOUR_PASSWORD_HERE\1/g, "__creds?.password || ''")
    // Neutralize legacy generated scripts that bail with AUTH_REQUIRED instead of
    // attempting login. When __creds is available the auto-injected preamble has
    // already handled auth, so we skip this early-return.
    .replace(
      /return\s*\{\s*ok:\s*false\s*,\s*error:\s*['"]AUTH_REQUIRED['"][^}]*\}\s*;?/g,
      "if (typeof __creds === 'undefined' || !__creds || !__creds.username) { return { ok: false, error: 'AUTH_REQUIRED', message: 'Login form detected but no credentials provided' }; }"
    )
    // Saved Geography Details / xtab scrapers skipped the thin MSTR/AG Grid
    // horizontal scrollbar (height ~15px) and clipped cells to the viewport,
    // so only the first ~8 metric columns were collected.
    .replace(/r\.width\s*<\s*80\s*\|\|\s*r\.height\s*<\s*40/g, "r.width < 8 || r.height < 4")
    .replace(
      /right:\s*\(window\.innerWidth\s*\|\|\s*1920\)\s*-\s*8/g,
      "right: 100000"
    )
    .replace(
      /right:\s*\(window\.innerWidth\s*\|\|\s*900\)\s*-\s*8/g,
      "right: 100000"
    )
    .replace(
      /'\[class\*="Xtab" i\], \[class\*="xtab" i\], \[role="grid"\], table, \[class\*="Grid" i\], \[class\*="scroll" i\], div'/g,
      "'.ag-body-horizontal-scroll-viewport, .ag-center-cols-viewport, .mstrmojo-scrollNode, [class*=\"Xtab\" i], [class*=\"xtab\" i], [role=\"grid\"], table, [class*=\"Grid\" i], [class*=\"scroll\" i], div'"
    );
  if (braceSignature(rewritten) !== braceSignature(code)) {
    console.error("playwright-runtime: sanitizer skipped — rewrite would unbalance braces");
    return code;
  }
  return rewritten;
}



function validateWrappedCodeSyntax(code: string) {
  // Only rewrite real module entries (start-of-line). Do not touch "export default"
  // mentions inside block comments (chart/overview reference headers).
  const parseable = code
    .replace(/^[ \t]*export\s+default\s+async\s*\(/gm, "const __browserlessEntrypoint = async (")
    .replace(/^[ \t]*export\s+default\s+/gm, "const __browserlessEntrypoint = ");
  try {
    new Function(parseable);
    return null;
  } catch (e: any) {
    return String(e?.message || e);
  }
}

function safeNavigationScript(creds: any, reportUrl?: string) {
  const urlLiteral = JSON.stringify(reportUrl || "about:blank");
  return `
const __creds = ${creds ? JSON.stringify(creds) : "null"};
export default async ({ page }) => {
  try { page.setDefaultTimeout(15000); } catch {}
  try { page.setDefaultNavigationTimeout(30000); } catch {}
  const reportUrl = ${urlLiteral};
  let ok = true, error = null;
  try {
    // 1) Session check — go straight to the report. If the report loads
    //    without a login form, the existing session is valid; skip login.
    await page.goto(reportUrl, { waitUntil: 'domcontentloaded' });
    const hasLoginForm = await page.evaluate(() => {
      return !!(document.querySelector('input[type="password"], #Pwd, #loginsection, form[action*="login" i]'));
    }).catch(() => false);
    if (hasLoginForm && __creds && __creds.username) {
      if (__creds.loginUrl) await page.goto(__creds.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      const userSel = '#Uid, input[placeholder*="user name" i], input[name*="user" i], input[id*="user" i], input[type="text"]';
      const pwdSel = '#Pwd, input[type="password"], input[placeholder*="password" i]';
      if (typeof page.type === 'function') {
        await page.type(userSel, __creds.username).catch(() => {});
        await page.type(pwdSel, __creds.password || '').catch(() => {});
      } else if (typeof page.fill === 'function') {
        await page.fill(userSel, __creds.username).catch(() => {});
        await page.fill(pwdSel, __creds.password || '').catch(() => {});
      }
      await page.evaluate(() => {
        const norm = s => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
        const cands = Array.from(document.querySelectorAll('button, input[type="submit"], div[role="button"], a'));
        let btn = cands.find(el => /log ?in/.test(norm(el.innerText || el.value || '')));
        if (btn) { btn.click(); return; }
        const form = document.querySelector('form');
        if (form) { (form.requestSubmit ? form.requestSubmit() : form.submit()); }
      }).catch(() => {});
      await Promise.race([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null),
        new Promise(r => setTimeout(r, 3000)),
      ]);
      const loginFailed = await page.evaluate(() =>
        /login\\s*failure|error\\s*in\\s*login|invalid (user|credentials|password)/i.test(document.body && document.body.innerText || '')
      ).catch(() => false);
      if (loginFailed) {
        ok = false; error = 'LOGIN_FAILED: credentials rejected by the report login page';
      } else {
        await page.goto(reportUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      }
    }
  } catch (e) { ok = false; error = String(e && e.message || e); }
  let screenshot = null, currentUrl = null, title = null;
  try { currentUrl = page.url(); } catch {}
  try { title = await page.title(); } catch {}
  try { screenshot = await page.screenshot({ encoding: 'base64', fullPage: true }); } catch {}
  return { ok, error, result: { note: 'Original generated script had invalid JavaScript and was skipped. Regenerate the script to restore KPI extraction.', title }, url: currentUrl, screenshot };
};`;
}

async function resolveCreds(sb: any, scenarioId?: string, target: "main" | "reference" = "main") {
  if (!scenarioId) return null;
  // For target=reference: prefer script.reference_credential_profile_id, then
  // report.reference_credential_profile_id, then fall back to the main credentials.
  // For target=main: prefer script.credential_profile_id, then report.credential_profile_id.
  const { data: script } = await fetchCanonicalScript(
    sb,
    scenarioId,
    "credential_profile_id, reference_credential_profile_id",
  );
  const { data: scenario } = await sb.from("scenarios")
    .select("reports(credential_profile_id, reference_credential_profile_id)")
    .eq("id", scenarioId).maybeSingle();
  const report: any = scenario?.reports || {};
  let credId: string | null = null;
  if (target === "reference") {
    credId = script?.reference_credential_profile_id
      || report.reference_credential_profile_id
      || script?.credential_profile_id
      || report.credential_profile_id
      || null;
  } else {
    credId = script?.credential_profile_id || report.credential_profile_id || null;
  }
  if (!credId) return null;
  const { data: cred } = await sb.from("credential_profiles").select("username,login_url,password_secret_ref").eq("id", credId).maybeSingle();
  if (!cred) return null;
  // password_secret_ref may be either the NAME of a secret/env var, OR the literal
  // password (Settings UI stores whatever the user typed). Resolve via env first;
  // if no such env var exists, fall back to the literal value.
  const ref = cred.password_secret_ref || "";
  const password = ref ? (Deno.env.get(ref) ?? ref) : "";
  return { username: cred.username || "", password, loginUrl: cred.login_url || "" };
}

async function resolveReportUrl(sb: any, scenarioId?: string, target: "main" | "reference" = "main") {
  if (!scenarioId) return "";
  const { data: scenario } = await sb.from("scenarios").select("reports(url, reference_url)").eq("id", scenarioId).maybeSingle();
  const r: any = scenario?.reports || {};
  if (target === "reference") return r.reference_url || r.url || "";
  // Main target may be configured (by agent-scripts) to scrape the reference URL
  // when the scenario description points the frontend source at the reference URL.
  const { data: script } = await fetchCanonicalScript(sb, scenarioId, "assertion_spec");
  const spec: any = (script as any)?.assertion_spec || {};
  if (spec.__main_uses_reference_source) return r.reference_url || r.url || "";
  return r.url || "";
}

async function resolveFilterCombinations(sb: any, scenarioId?: string) {
  if (!scenarioId) return [];
  const { data } = await sb
    .from("scenario_filter_matrix")
    .select("label,filters")
    .eq("scenario_id", scenarioId)
    .order("created_at", { ascending: true });
  return (data || []).map((r: any, i: number) => ({
    label: r.label || `combo_${i + 1}`,
    filters: r.filters || {},
  }));
}

function headedModeError(rt: BrowserlessRuntime): string {
  if (rt.isOss) {
    return (
      "Headed (live browser) mode is not available in self-hosted Browserless OSS. " +
      "Live debugging and /live iframe streaming require Browserless Enterprise or Cloud. " +
      "Use headless mode — scripts still run via POST /chromium/function and return screenshots."
    );
  }
  return (
    "Headed (Live URL) mode requires a Browserless paid plan that includes Live URLs. " +
    "Your current token's plan does not support this feature. Use headless mode, or upgrade your Browserless plan."
  );
}

async function runOnBrowserless(rt: BrowserlessRuntime, mode: Mode, code: string, creds: any, reportUrl?: string, filterCombinations: any[] = []) {
  if (mode === "headed") {
    throw new Error(headedModeError(rt));
  }

  // Headless: /function executes JS Playwright only. Auto-wrap if needed.
  let jsCode = (code || "").trim();
  const looksPython = /^\s*(import|from |def |async def |class )/m.test(jsCode) || jsCode.includes("playwright.async_api");
  if (looksPython || !jsCode) {
    jsCode = `export default async ({ page }) => {
      await page.goto('about:blank');
      return { ok: true, note: 'Legacy/empty script — regenerate via agent-scripts for JS Playwright code.' };
    };`;
  } else if (!/export\s+default/.test(jsCode)) {
    jsCode = `export default async ({ page }) => {\n${jsCode}\n};`;
  }
  const originalJs = jsCode;
  jsCode = sanitizeBrowserlessCode(jsCode);

  const assembleWrapped = (userSource: string) => {
    // Inject __creds and __filterCombinations globals so generated scripts can authenticate and iterate filters without hardcoding.
    // Browserless /chromium/function has no Node `process` — shim it so saved chart templates
    // that still read process.env.REPORT_URL do not throw "process is not defined".
    const credsLiteral = `const __creds = ${creds ? JSON.stringify(creds) : "null"};`;
    const filtersLiteral = `const __filterCombinations = ${JSON.stringify(filterCombinations || [])};`;
    const processShim = `var process = { env: { REPORT_URL: ${JSON.stringify(reportUrl || "")} } };`;

    // Convert the real module entry only (start-of-line). Reference file headers
    // mention "export default" inside comments — a global replace would steal that
    // and leave the true entry as `export`, which fails syntax validation and
    // silently falls back to the login-page stub.
    let userFnCode = userSource.replace(/^[ \t]*export\s+default\s+/m, "const __userFn = ");
    // Prefer a literal URL when we know it (also clears leftover process.env reads).
    if (reportUrl) {
      userFnCode = userFnCode.replace(
        /const __reportUrl\s*=\s*process\.env\.REPORT_URL\s*\|\|\s*("[^"]*"|'[^']*')\s*;/,
        `const __reportUrl = ${JSON.stringify(reportUrl)};`,
      );
    }

    // Match Chromium launch (1920x1080). A 3840x8000 fullPage screenshot OOMs
    // Browserless and surfaces as HTTP 500 Internal Server Error.
    return `
${credsLiteral}
${filtersLiteral}
${processShim}
${userFnCode}
export default async (ctx) => {
  try { ctx.page.setDefaultTimeout(15000); } catch {}
  try { ctx.page.setDefaultNavigationTimeout(30000); } catch {}
  try { if (typeof ctx.page.setViewport === 'function') await ctx.page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 }); } catch {}
  try { await ctx.page.setViewportSize({ width: 1920, height: 1080 }); } catch {}
  const applyZoom100 = async () => {
    try {
      await ctx.page.evaluate(() => {
        document.documentElement.style.zoom = '100%';
        if (document.body) document.body.style.zoom = '100%';
      });
    } catch {}
  };
  try {
    const _goto = ctx.page.goto.bind(ctx.page);
    ctx.page.goto = async (...args) => {
      const r = await _goto(...args);
      await applyZoom100();
      return r;
    };
  } catch {}
  await applyZoom100();
  let result = null, ok = true, error = null;
  try { result = await __userFn(ctx); } catch (e) { ok = false; error = String(e && e.message || e); }
  let screenshot = null, url = null;
  try { url = ctx.page.url(); } catch {}
  try {
    const dims = await ctx.page.evaluate(() => ({
      w: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0, document.documentElement.clientWidth),
      h: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0, document.documentElement.clientHeight),
    }));
    const targetW = Math.min(Math.max(dims.w || 1920, 1920), 1920);
    const targetH = Math.min(Math.max(dims.h || 1080, 1080), 2160);
    try { if (typeof ctx.page.setViewport === 'function') await ctx.page.setViewport({ width: targetW, height: targetH, deviceScaleFactor: 1 }); } catch {}
    await ctx.page.setViewportSize({ width: targetW, height: targetH });
    await ctx.page.waitForTimeout(500);
  } catch {}
  await applyZoom100();
  try { await ctx.page.evaluate(() => window.scrollTo(0, 0)); } catch {}
  try { screenshot = await ctx.page.screenshot({ encoding: 'base64', fullPage: true }); } catch {}
  return { ok, error, result, url, screenshot };
};`;
  };

  let wrapped = assembleWrapped(jsCode);
  let syntaxError = validateWrappedCodeSyntax(wrapped);
  if (syntaxError && jsCode !== originalJs) {
    console.error("playwright-runtime: sanitizer produced invalid JS, using original:", syntaxError);
    wrapped = assembleWrapped(originalJs);
    syntaxError = validateWrappedCodeSyntax(wrapped);
  }
  if (syntaxError) {
    console.error("playwright-runtime: generated script failed syntax check:", syntaxError);
    wrapped = safeNavigationScript(creds, reportUrl);
  }

  const payload = await callBrowserlessFunction(rt, wrapped);
  const data = payload?.data ?? payload;
  const screenshot_b64 = data?.screenshot || null;
  if (data && typeof data === "object") delete (data as any).screenshot;
  return { extracted: data, screenshot_b64, provider: "browserless" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const unauthorized = await requireAuth(req);
  if (unauthorized) return unauthorized;
  let jobId: string | null = null;
  let jobSb: any = null;
  try {
    const {
      mode = "headless",
      scenario_id,
      code = "",
      target = "main",
      filter_combinations: filterComboOverride,
    } = await req.json() as {
      mode: Mode;
      scenario_id?: string;
      code?: string;
      target?: "main" | "reference";
      filter_combinations?: { label?: string; filters?: Record<string, unknown> }[];
    };
    const sb = (() => {
      const serviceRole = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "").trim();
      // Prefer caller JWT (same as UI). Only use service role when it looks like a real JWT.
      if (serviceRole.length > 40) return getSupabase();
      return getSupabaseForRequest(req);
    })();
    jobSb = sb;
    const rt = await getRuntime(sb);

    const { data: job, error: jobError } = await sb.from("playwright_jobs").insert({
      scenario_id: scenario_id || null,
      mode, status: "running",
    }).select().single();
    if (jobError || !job) {
      throw new Error(`Could not create Playwright job: ${jobError?.message || "unknown error"}`);
    }
    jobId = job.id;

    if (!rt) {
      const message =
        "No browser runtime configured. Set BROWSERLESS_TOKEN and BROWSERLESS_HOST " +
        `(e.g. BROWSERLESS_HOST=${DEFAULT_OSS_HOST}, BROWSERLESS_TOKEN=local-dev-token). ` +
        `Cloud fallback host: ${DEFAULT_CLOUD_HOST}.`;
      await sb.from("playwright_jobs").update({
        status: "failed", finished_at: new Date().toISOString(), last_event: { error: message },
      }).eq("id", job.id);
      return new Response(JSON.stringify({ error: message, job_id: job.id }), {
        status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const tgt: "main" | "reference" = target === "reference" ? "reference" : "main";
    const creds = await resolveCreds(sb, scenario_id, tgt);
    const reportUrl = await resolveReportUrl(sb, scenario_id, tgt);
    const requestedCombos = (filterComboOverride || [])
      .filter((c) => c && typeof c === "object")
      .map((c, i) => ({
        label: String(c.label || `combo_${i + 1}`),
        filters: (c.filters || {}) as Record<string, unknown>,
      }));
    const filterCombinations = requestedCombos.length
      ? requestedCombos
      : await resolveFilterCombinations(sb, scenario_id);

    // Cloud plans without Live URLs: silently run headless instead of failing.
    let effectiveMode: Mode = mode;
    let fallbackReason: string | undefined;
    if (rt.provider === "browserless" && !rt.isOss && mode === "headed") {
      effectiveMode = "headless";
      fallbackReason = "Browserless Live URLs are not available on this plan, so the script ran headless instead.";
    }

    const result = await runOnBrowserless(rt, effectiveMode, code, creds, reportUrl, filterCombinations);
    if (fallbackReason) {
      result.mode = effectiveMode;
      result.requested_mode = mode;
      result.fallback_reason = fallbackReason;
    }

    const executionFailed =
      result?.extracted?.ok === false ||
      !!result?.extracted?.error;
    await sb.from("playwright_jobs").update({
      status: executionFailed ? "failed" : "completed",
      finished_at: new Date().toISOString(),
      live_url: result.live_url || null, last_event: result,
    }).eq("id", job.id);

    return new Response(JSON.stringify({ job_id: job.id, ...result }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (jobId && jobSb) {
      try {
        await jobSb.from("playwright_jobs").update({
          status: "failed",
          finished_at: new Date().toISOString(),
          last_event: { error: msg },
        }).eq("id", jobId);
      } catch {}
    }
    // Browserless 408 = script exceeded the runtime budget. Return 200 with a
    // structured fallback so the UI shows a friendly message instead of blank screen.
    if (e?.status === 408 || e?.name === "TimeoutError" || /\b408\b|timed out|aborted due to timeout/i.test(msg)) {
      const minutes = Math.round(browserlessTimeoutMs() / 60000);
      return new Response(JSON.stringify({
        ok: false,
        error: "BROWSERLESS_TIMEOUT",
        message: `The browser script took too long (Browserless budget is ${minutes} minutes). The report may be slow or a selector is waiting indefinitely — try simplifying or shortening waits.`,
        fallback: true,
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

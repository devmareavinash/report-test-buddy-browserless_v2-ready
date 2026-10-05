/** Deterministic MSTR grid/crosstab Playwright script (Geography Details and similar). */

export const DEFAULT_GEOGRAPHY_COLUMNS = [
  "Area",
  "Employee Name",
  "NBRx Total",
  "NRx Total",
  "TRx Total",
  "Blink TRx",
  "NBRx New Writers",
  "Total Writers",
  "Total Calls",
  "Total HCP Calls",
  "F2F HCP Calls",
  "Virtual HCP Calls",
  "Reach (%)",
  "NBRx Breadth (%)",
  "NBRx Depth",
  "Calls to Target (%)",
  "Calls/Day HCP",
  "Frequency",
  "Speaker Programs Attended",
];

/**
 * Column presets are per-grid HINTS, keyed by grid title — not a universal default.
 * A grid whose title matches nothing here contributes no preset: EXPECTED_COLUMNS
 * is then whatever the scenario actually declares (possibly empty), and the runtime
 * falls back to structural grid detection rather than this Bayer metric vocabulary.
 * Add a new grid by adding a key here, or by populating reports.kpi_config.
 */
export const GRID_COLUMN_PRESETS: Record<string, string[]> = {
  "geography details": DEFAULT_GEOGRAPHY_COLUMNS,
  "geography comparison": DEFAULT_GEOGRAPHY_COLUMNS,
  "performance trend": DEFAULT_GEOGRAPHY_COLUMNS,
};

/** Titles that share the Bayer metric column set even when worded differently. */
const GEO_LIKE_RE = /\b(geography|geo|territory|performance\s*trend)\b/i;

export function presetColumnsForGrid(gridTitle: string): string[] {
  const t = String(gridTitle || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!t) return [];
  for (const [key, cols] of Object.entries(GRID_COLUMN_PRESETS)) {
    if (t === key || t.includes(key)) return cols;
  }
  // A differently-worded Geography/Trend grid still uses the same metrics.
  // Extraction no longer depends on this list (Show Data is taken verbatim);
  // it only strengthens the "grid has rendered" check.
  if (GEO_LIKE_RE.test(t)) return DEFAULT_GEOGRAPHY_COLUMNS;
  return [];
}

const GRID_NOISE = new Set([
  "extract_via", "grid", "show_data", "showdata", "tabledata", "table_data",
  "filters_applied", "navigation", "ok", "error", "via", "metric", "time_bucket",
]);

import { parseNavStepsFromScenario, parseVizTitleFromScenario, scenarioTextBlob } from "./mstr-nav-parse.ts";
import { FILTER_CORE_JS } from "./mstr-filter-core.ts";

export function scenarioBlob(scenario: any): string {
  return scenarioTextBlob(scenario);
}

export function isGridScenario(scenario: any, existingScript?: any): boolean {
  if (String(scenario?.type || "").toLowerCase() === "trend") return false;
  const blob = scenarioBlob(scenario).toLowerCase();
  if (/\bgeography details\b/.test(blob) && /\bgrid\b/.test(blob)) return true;
  // Performance Trend Grid / Trends Grid (on-page crosstab — not Overall Performance chart Show Data)
  if (/\bperformance\s*trends?\s*grid\b/.test(blob) || (/\bperformance\s*trend\b/.test(blob) && /\bgrid\b/.test(blob))) {
    return true;
  }
  if (/\b(grid data|crosstab|xtab grid|on-page grid|all grid columns|grid rows)\b/.test(blob)) return true;
  if (/\bgrid\b/.test(blob) && /\b(employee name|area\b|columns?:)\b/.test(blob) && !/\boverview\b/.test(blob)) {
    return true;
  }
  if (/\bgrid\b/.test(blob) && /\brecord\s*count\b/.test(blob)) return true;
  if (/\bgrid\b/.test(blob) && /\brow\s*count\b/.test(blob)) return true;
  if (/\bsub\s*tabs?\b/.test(blob) && /\bgrid\b/.test(blob)) return true;
  const code = String(
    existingScript?.playwright_code ||
    existingScript?.assertion_spec?.__reference_playwright_code ||
    "",
  );
  if (/extractOnPageGrid|row\.grid\s*=/.test(code) && /Geography Details|Employee Name|Performance Trend/.test(code)) return true;
  return false;
}

export function parseGridTitle(scenario: any): string {
  return parseVizTitleFromScenario(scenario, "grid");
}

export function parseGridNavSteps(scenario: any): string[] {
  // Description / title / report name only — never invent Performance → Performance Trend.
  return parseNavStepsFromScenario(scenario, { allowGeography: true });
}

/** Weekly/Monthly/Quarterly on Performance Trend — null for Geography (Time Bucket only). */
export function parseGridTimeGrain(scenario: any, target: "main" | "reference" = "main"): string | null {
  const blob = scenarioBlob(scenario).toLowerCase().replace(/\bquaterly\b/g, "quarterly");
  if (!/performance\s*trends?/.test(blob)) return null;
  if (!/\b(weekly|monthly|quarterly)\b/.test(blob)) return null;

  const canon = (g: string | undefined | null): string | null => {
    const v = String(g || "").toLowerCase();
    if (v === "weekly") return "Weekly";
    if (v === "quarterly") return "Quarterly";
    if (v === "monthly") return "Monthly";
    return null;
  };

  const toggles = [...blob.matchAll(/\b(?:for\s+|on\s+)?(weekly|monthly|quarterly)\s+toggle\b/g)].map((x) => x[1]);
  if (toggles.length) {
    if (target === "reference") return canon(toggles[toggles.length - 1]);
    return canon(toggles[0]);
  }
  const all = blob.match(/\b(weekly|monthly|quarterly)\b/g) || [];
  if (target === "reference") return canon(all[all.length - 1]);
  return canon(all[0]);
}

export function parseGridColumns(scenario: any, existingScript?: any, gridTitle?: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: any) => {
    const s = typeof raw === "string"
      ? raw.trim()
      : String(raw?.label || raw?.name || raw?.kpi || "").trim();
    if (!s || s.length > 80 || GRID_NOISE.has(s.toLowerCase().replace(/\s+/g, "_"))) return;
    // KPI container labels are not column headers
    if (/^(performance\s*trends?\s*grid|overall performance|geography details)$/i.test(s)) return;
    const key = s.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };
  const desc = String(scenario?.description || "");
  for (const line of desc.split(/\r?\n/)) {
    const t = line.replace(/^[-*•\d.)\s]+/, "").trim();
    if (t && t.length <= 60 && /nbrx|nrx|trx|writers|calls|reach|frequency|breadth|depth|speaker|employee|area|blink/i.test(t)) {
      add(t);
    }
  }
  const spec = existingScript?.assertion_spec;
  if (Array.isArray(spec?.kpis)) spec.kpis.forEach(add);
  const cfg = scenario?.reports?.kpi_config;
  if (Array.isArray(cfg)) cfg.forEach(add);
  else if (cfg && typeof cfg === "object") {
    if (Array.isArray(cfg.kpis)) cfg.kpis.forEach(add);
    else if (Array.isArray(cfg.labels)) cfg.labels.forEach(add);
    else Object.keys(cfg).forEach(add);
  }
  // Preset is keyed by the grid we are actually scraping. Unknown grids get no
  // preset — a Geography column list must never be handed to an unrelated grid.
  if (out.length < 8) {
    const title = String(gridTitle || parseVizTitleFromScenario(scenario, "grid") || "");
    presetColumnsForGrid(title).forEach(add);
  }
  return out;
}

export function isRecordCountScenario(scenario: any): boolean {
  const blob = scenarioBlob(scenario).toLowerCase();
  const asksForCount =
    /\b(record|row|rows)\s*count\b/.test(blob)
    || /\bcount\s+(?:the\s+)?(?:record|row|rows)s?\b/.test(blob);
  return asksForCount
    && /\b(show\s*data|sub[-\s]?tab|tab|grid|table)\b/.test(blob);
}

export function parseSubTabs(scenario: any): string[] {
  // Scenario authors commonly put the quoted sub-tab in the title and leave
  // the description empty. Parse both so deterministic record-count
  // generation does not incorrectly fall through to the generic KPI template.
  const desc = [scenario?.title, scenario?.description]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join("\n");
  const tabs: string[] = [];
  const seen = new Set<string>();
  for (const m of desc.matchAll(/[''‘’""“”]([^''‘’""“”]{3,80})[''‘’""“”]/g)) {
    const t = m[1].trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    if (/prod|pre-prod|reference|main|url/i.test(t)) continue;
    seen.add(t.toLowerCase());
    tabs.push(t);
  }
  return tabs;
}

export function assembleRecordCountScript(opts: {
  reportUrl: string;
  navSteps: string[];
  subTabs: string[];
  kpiPrefix?: string;
}): string {
  const reportUrl = String(opts.reportUrl || "").trim();
  const navSteps = (opts.navSteps || []).filter((s) => typeof s === "string" && s.trim());
  const subTabs = (opts.subTabs || []).filter((s) => typeof s === "string" && s.trim());
  const kpiPrefix = String(opts.kpiPrefix || "Row Count").trim();
  const urlLit = JSON.stringify(reportUrl);
  const navLit = JSON.stringify(navSteps, null, 4).replace(/\n/g, "\n    ");
  const tabsLit = JSON.stringify(subTabs, null, 4).replace(/\n/g, "\n    ");
  const prefixLit = JSON.stringify(kpiPrefix);

  return `/**
 * RTB skill template: MSTR sub-tab record count via Show Data popup "Rows: N" header.
 * Navigates to each sub-tab, opens Show Data, reads the row count, closes popup.
 * Filters come from runtime __filterCombinations (never hardcode filter values).
 * Runtime: Browserless /chromium/function — export default async ({ page }) => { ... }
 */
export default async ({ page }) => {

  // === AUTO-INJECTED SESSION-AWARE AUTH CHECK (do not remove) ===
  const __sleep = ms => new Promise(r => setTimeout(r, ms));
  const __reportUrl = ${urlLit};
  const __tryWidenViewport = async () => {
    try { if (typeof page.setViewport === 'function') await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 }); } catch (_) {}
    try { if (typeof page.setViewportSize === 'function') await page.setViewportSize({ width: 1920, height: 1080 }); } catch (_) {}
    try {
      await page.evaluate(() => {
        document.documentElement.style.zoom = '100%';
        if (document.body) document.body.style.zoom = '100%';
      });
    } catch (_) {}
  };
  await __tryWidenViewport();
  const __detectLoginForm = () => page.evaluate(() => {
    const norm = s => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const hasUserField = !!document.querySelector(
      'input[placeholder*="user name" i], input[name*="user" i], input[id*="user" i], #Uid'
    );
    const hasPwdField = !!document.querySelector('input[type="password"], #Pwd');
    const hasLoginBtn = Array.from(document.querySelectorAll('button, input[type="submit"], div[role="button"], a'))
      .some(el => /log ?in/.test(norm(el.innerText || el.value || '')));
    return hasUserField || hasPwdField || hasLoginBtn;
  }).catch(() => false);
  await page.goto(__reportUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await __sleep(2000);
  let __hasLoginForm = await __detectLoginForm();
  if (__hasLoginForm && typeof __creds !== 'undefined' && __creds && __creds.username) {
    const __onLoginPage = await page.evaluate(() => /\\/auth\\/ui\\/loginPage/i.test(location.href)).catch(() => false);
    if (!__onLoginPage && __creds.loginUrl) {
      await page.goto(__creds.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await __sleep(1000);
    }
    const __userSel = '#Uid, input[placeholder*="user name" i], input[name*="user" i], input[id*="user" i], input[type="text"]';
    const __pwdSel  = '#Pwd, input[type="password"], input[placeholder*="password" i]';
    await page.type(__userSel, __creds.username).catch(() => {});
    await page.type(__pwdSel, __creds.password).catch(() => {});
    await page.evaluate((pSel) => {
      const norm = s => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const cands = Array.from(document.querySelectorAll('button, input[type="submit"], div[role="button"], a'));
      let btn = cands.find(el => norm(el.innerText || el.value || '') === 'log in with credentials');
      if (!btn) btn = cands.find(el => /log ?in/.test(norm(el.innerText || el.value || '')));
      if (btn) { btn.click(); return true; }
      const pwd = document.querySelector(pSel);
      const form = pwd && pwd.closest('form');
      if (form) { (form.requestSubmit ? form.requestSubmit() : form.submit()); return true; }
      return false;
    }, __pwdSel).catch(() => {});
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null),
      __sleep(3000),
    ]);
    await __sleep(1500);
    const __loginFailed = await page.evaluate(() =>
      /login\\s*failure|error\\s*in\\s*login|invalid (user|credentials|password)|incorrect (user|password)/i.test(document.body.innerText || '')
    ).catch(() => false);
    if (__loginFailed) {
      return { ok: false, error: 'LOGIN_FAILED', message: 'Credentials rejected by the report login page' };
    }
    await page.goto(__reportUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await __sleep(2000);
    __hasLoginForm = await __detectLoginForm();
    if (__hasLoginForm) {
      return { ok: false, error: 'LOGIN_FAILED', message: 'Still on login page after submitting credentials' };
    }
    await __tryWidenViewport();
  } else if (__hasLoginForm) {
    return { ok: false, error: 'AUTH_REQUIRED', message: 'Login form present but no credentials provided' };
  }
  // === END AUTO-INJECTED AUTH CHECK ===

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const reportUrl = ${urlLit};

  const NAV_STEPS = ${navLit};
  const SUB_TABS = ${tabsLit};
  const KPI_PREFIX = ${prefixLit};

  const waitForLoadingToFinish = async (maxMs = 45000) => {
    const start = Date.now();
    await sleep(400);
    const isLoading = () => page.evaluate(() => {
      const bodyText = document.body ? document.body.innerText : '';
      if (/Loading\\s*Data/i.test(bodyText)) {
        for (const el of Array.from(document.querySelectorAll('*'))) {
          let direct = '';
          for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) direct += n.textContent;
          if (!/Loading\\s*Data/i.test(direct)) continue;
          const r = el.getBoundingClientRect();
          const st = window.getComputedStyle(el);
          if (r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none')
            return true;
        }
      }
      const spin = document.querySelector(
        '.mstrmojo-WaitBox, .mstrmojo-Wait, .mstrWaitBox, [class*="WaitBox" i], [class*="loading" i][class*="overlay" i]'
      );
      if (spin) {
        const r = spin.getBoundingClientRect();
        const st = window.getComputedStyle(spin);
        if (r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none')
          return true;
      }
      return false;
    }).catch(() => false);
    while (Date.now() - start < maxMs) {
      const loading = await isLoading();
      if (!loading) {
        await sleep(800);
        if (!(await isLoading())) return;
      }
      await sleep(400);
    }
  };

  const waitForDashboard = async (maxMs = 30000) => {
    await waitForLoadingToFinish(maxMs);
  };

  const dismissGenericErrorDialog = async () => {
    await page.evaluate(() => {
      const norm = s => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      for (const btn of Array.from(document.querySelectorAll('button, [role="button"], a, span'))) {
        const t = norm(btn.innerText || btn.textContent || '');
        if (t === 'ok' || t === 'close' || t === 'dismiss') {
          const parent = btn.closest('[class*="error" i], [class*="alert" i], [class*="dialog" i], [class*="modal" i], [role="dialog"], [role="alertdialog"]');
          if (parent) { btn.click(); return true; }
        }
      }
      return false;
    }).catch(() => false);
    await sleep(200);
  };

  const closeAnyOpenDropdown = async () => {
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Escape', code: 'Escape', bubbles: true }));
    }).catch(() => {});
    await sleep(300);
  };

  const clickByText = async (text) => {
    const result = await page.evaluate((label) => {
      function getDirectText(el) {
        let t = '';
        for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) t += n.textContent;
        return t.trim();
      }
      const norm = s => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const target = norm(label);
      const isVisible = el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const st = el.ownerDocument.defaultView.getComputedStyle(el);
        return st.visibility !== 'hidden' && st.display !== 'none';
      };
      const roots = [document];
      for (const f of Array.from(document.querySelectorAll('iframe, frame'))) {
        try { roots.push(f.contentDocument); } catch (_) {}
      }
      const exact = [], contains = [];
      for (const root of roots) {
        for (const el of Array.from(root.querySelectorAll('*'))) {
          if (!isVisible(el)) continue;
          const direct = getDirectText(el);
          if (direct && norm(direct) === target) {
            const r = el.getBoundingClientRect();
            exact.push({ el, area: r.width * r.height });
            continue;
          }
        }
        for (const el of Array.from(root.querySelectorAll('a, button, li, div, span, td, [role="tab"], [role="menuitem"], [role="button"]'))) {
          if (!isVisible(el)) continue;
          const it = norm(el.innerText || el.textContent || '');
          if (!it || !it.includes(target)) continue;
          const r = el.getBoundingClientRect();
          if (r.width * r.height > 200000) continue;
          contains.push({ el, area: r.width * r.height, len: it.length });
        }
      }
      exact.sort((a, b) => a.area - b.area);
      contains.sort((a, b) => (a.len - b.len) || (a.area - b.area));
      const best = exact[0] || contains[0];
      if (best) { best.el.click(); return { clicked: true, via: 'text', text: label }; }
      return { error: 'navigation target not found: ' + label };
    }, text).catch(() => ({ error: 'evaluate failed: ' + text }));
    await waitForLoadingToFinish();
    await waitForDashboard().catch(() => {});
    return result;
  };

${FILTER_CORE_JS}


  // Extract the "Rows: N" text from the Show Data popup header.
  const extractShowDataRowCount = async () => {
    const POPUP_SEL = '.mstrmojo-Popup, .mstrmojo-popup, .mstrmojo-RootPopup, [class*="Popup"], [class*="popup"], [class*="modal" i], [class*="dialog" i], [role="dialog"]';
    return await page.evaluate((popupSel) => {
      const norm = s => (s || '').replace(/\\s+/g, ' ').trim();
      const isVisible = el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const st = getComputedStyle(el);
        return st.visibility !== 'hidden' && st.display !== 'none';
      };
      // Search popup containers first, then the full document
      const roots = [
        ...Array.from(document.querySelectorAll(popupSel)).filter(isVisible),
        document,
      ];
      for (const root of roots) {
        for (const el of Array.from(root.querySelectorAll('*'))) {
          if (!isVisible(el)) continue;
          let direct = '';
          for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) direct += n.textContent;
          const text = norm(direct);
          // Match "Rows: 1234" or "Rows : 1,234"
          const m = text.match(/Rows\\s*:\\s*([\\d,]+)/i);
          if (m) {
            const count = parseInt(m[1].replace(/,/g, ''), 10);
            if (!isNaN(count)) return { count, via: 'show-data-header', raw: text };
          }
        }
      }
      // Fallback: count visible table rows
      const tables = Array.from(document.querySelectorAll('table')).filter(isVisible);
      if (tables.length) {
        let bestTable = null, bestArea = 0;
        for (const t of tables) {
          const r = t.getBoundingClientRect();
          if (r.width * r.height > bestArea) { bestArea = r.width * r.height; bestTable = t; }
        }
        if (bestTable) {
          const allRows = Array.from(bestTable.querySelectorAll('tr')).filter(isVisible);
          const headerRows = Array.from(bestTable.querySelectorAll('thead tr')).filter(isVisible);
          const dataRows = allRows.length - headerRows.length;
          if (dataRows > 0) return { count: dataRows, via: 'table-row-count' };
        }
      }
      return { count: null, via: 'not-found' };
    }, POPUP_SEL).catch(() => ({ count: null, via: 'evaluate-failed' }));
  };

  // Open the Show Data popup on the current widget via right-click context menu.
  const openShowData = async () => {
    // Right-click in the center of the largest visible grid/table/visualization
    const target = await page.evaluate(() => {
      const isVisible = el => {
        const r = el.getBoundingClientRect();
        if (r.width < 10 || r.height < 10) return false;
        const st = getComputedStyle(el);
        return st.visibility !== 'hidden' && st.display !== 'none';
      };
      const sels = [
        'table', '[class*="grid" i]', '[class*="xtab" i]', '[role="grid"]',
        '[class*="mstrmojo"][class*="Table" i]', '[class*="mstrmojo"][class*="Grid" i]',
        '[class*="visualization" i]', '[class*="widget" i]',
      ];
      let best = null, bestArea = 0;
      for (const sel of sels) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          if (!isVisible(el)) continue;
          const r = el.getBoundingClientRect();
          const area = r.width * r.height;
          if (area > bestArea) { bestArea = area; best = { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
        }
      }
      return best || { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    }).catch(() => ({ x: 600, y: 400 }));

    await page.mouse.click(target.x, target.y, { button: 'right' });
    await sleep(800);

    // Click "Show Data" in the context menu
    const clicked = await page.evaluate(() => {
      const norm = s => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const isVisible = el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const st = getComputedStyle(el);
        return st.visibility !== 'hidden' && st.display !== 'none';
      };
      for (const el of Array.from(document.querySelectorAll('li, button, a, span, div, [role="menuitem"], [role="option"]'))) {
        if (!isVisible(el)) continue;
        const raw = (el.innerText || el.textContent || '').trim();
        if (!raw || raw.length > 40) continue;
        const t = norm(raw);
        if (t === 'show data' || t === 'export data') {
          el.click();
          return { clicked: true, text: raw };
        }
      }
      return { error: 'Show Data menu item not found' };
    }).catch(() => ({ error: 'evaluate failed' }));

    if (clicked.error) {
      // Fallback: try in iframes
      for (const frame of page.frames()) {
        try {
          const r = await frame.evaluate(() => {
            const norm = s => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
            for (const el of Array.from(document.querySelectorAll('li, button, a, span, div, [role="menuitem"]'))) {
              const r = el.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) continue;
              const t = norm(el.innerText || el.textContent || '');
              if (t === 'show data' || t === 'export data') { el.click(); return { clicked: true }; }
            }
            return null;
          });
          if (r && r.clicked) return r;
        } catch (_) {}
      }
    }
    return clicked;
  };

  const closeShowDataPopup = async () => {
    const closed = await page.evaluate(() => {
      const norm = s => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      for (const el of Array.from(document.querySelectorAll('button, [role="button"], span, a'))) {
        const t = norm(el.innerText || el.textContent || '');
        if (t === 'close') { el.click(); return true; }
      }
      return false;
    }).catch(() => false);
    if (!closed) await page.keyboard.press('Escape').catch(() => {});
    await sleep(400);
  };

  const waitForDossierReady = async () => {
    const start = Date.now();
    while (Date.now() - start < 30000) {
      const ready = await page.evaluate(() => {
        const b = document.body ? document.body.innerText : '';
        return b.length > 100 && !/Loading\\s*Data/i.test(b);
      }).catch(() => false);
      if (ready) break;
      await sleep(500);
    }
    await waitForLoadingToFinish();
  };

  await waitForDossierReady();

  // Navigate to the screen (e.g. "HCP Customer")
  const navDebug = [];
  for (const step of NAV_STEPS) {
    const r = await clickByText(step);
    navDebug.push({ step, ...r });
    if (r.error) break;
  }
  await waitForDashboard();

  const filterCombinations = (typeof __filterCombinations !== 'undefined' && Array.isArray(__filterCombinations) && __filterCombinations.length > 0)
    ? __filterCombinations : [];

  const scrapeOnce = async (filters) => {
    const debug = {};
    const GEO_ORDER = ['Area', 'Region', 'Territory', 'Time Bucket'];
    const allKeys = Object.keys(filters || {});
    const geoKeys = GEO_ORDER.filter(k => allKeys.includes(k));
    const otherKeys = allKeys.filter(k => !GEO_ORDER.includes(k));
    for (const key of geoKeys) {
      debug[key] = await selectByLabel(key, filters[key]);
      await dismissGenericErrorDialog();
      await closeAnyOpenDropdown();
    }
    for (const key of otherKeys) {
      debug[key] = await selectByLabel(key, filters[key]);
      await dismissGenericErrorDialog();
      await closeAnyOpenDropdown();
    }
    await waitForLoadingToFinish(15000);
    await waitForDashboard();

    const row = { filters_applied: debug };

    // Visit each sub-tab and extract the row count from Show Data
    for (const tab of SUB_TABS) {
      const kpiKey = KPI_PREFIX + ' - ' + tab;
      const tabClick = await clickByText(tab);
      if (tabClick.error) {
        row[kpiKey] = null;
        row[kpiKey + '_debug'] = { error: 'tab not found: ' + tab, ...tabClick };
        continue;
      }
      await waitForLoadingToFinish();
      await sleep(1000);

      const showDataResult = await openShowData();
      if (showDataResult.error) {
        row[kpiKey] = null;
        row[kpiKey + '_debug'] = { error: 'Show Data failed', ...showDataResult };
        continue;
      }
      await waitForLoadingToFinish(10000);
      await sleep(1500);

      const countResult = await extractShowDataRowCount();
      row[kpiKey] = countResult.count;
      row[kpiKey + '_debug'] = countResult;

      await closeShowDataPopup();
      await sleep(500);
    }

    return row;
  };

  if (filterCombinations.length === 0) {
    const row = await scrapeOnce({});
    return { navigation: navDebug, ...row };
  }

  const results = {};
  for (let i = 0; i < filterCombinations.length; i++) {
    const { label = String(i), filters = {} } = filterCombinations[i];
    if (i > 0) {
      await page.goto(reportUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await waitForDossierReady();
      for (const step of NAV_STEPS) {
        await clickByText(step);
      }
      await waitForDashboard();
    }
    results[label] = await scrapeOnce(filters);
  }
  return { navigation: navDebug, results };
};
`;
}

export function assembleGridScript(opts: {
  reportUrl: string;
  gridTitle: string;
  navSteps?: string[];
  expectedColumns?: string[];
  timeGrain?: string | null;
  kpiLabel?: string | null;
}): string {
  const reportUrl = String(opts.reportUrl || "").trim();
  // Title/nav come from scenario text — never invent Performance / Geography screens.
  const gridTitle = String(opts.gridTitle || "").trim() || "Grid";
  const navSteps = (opts.navSteps || []).filter((s) => typeof s === "string" && s.trim());
  const expected = (opts.expectedColumns || []).filter((s) => typeof s === "string" && s.trim());
  const timeGrain = opts.timeGrain ? String(opts.timeGrain).trim() : "";
  const kpiLabel = String(opts.kpiLabel || gridTitle).trim() || gridTitle;
  const urlLit = JSON.stringify(reportUrl);
  const titleLit = JSON.stringify(gridTitle);
  const kpiLit = JSON.stringify(kpiLabel);
  const grainLit = JSON.stringify(timeGrain);
  const navLit = JSON.stringify(navSteps, null, 4).replace(/\n/g, "\n    ");
  const colsLit = JSON.stringify(
    expected.length ? expected : presetColumnsForGrid(gridTitle),
    null,
    4,
  ).replace(/\n/g, "\n    ");

  return `/**
 * RTB skill template: MSTR grid / crosstab (Geography Details or Performance Trend Grid).
 * Filled from UI: report URL, GRID_TITLE, NAV_STEPS, TIME_GRAIN (Trend only), EXPECTED_COLUMNS.
 * Filters come from runtime __filterCombinations (never hardcode Area/Region values).
 * Extract: Menu → Show Data popup first; on-page scroll merge only as fallback.
 * Never keep Overview "Performance KPIs" / "Line copy" scrapes as the grid.
 * Runtime: Browserless /chromium/function — export default async ({ page }) => { ... }
 */
export default async ({ page }) => {

  // === AUTO-INJECTED SESSION-AWARE AUTH CHECK (do not remove) ===
  const __sleep = ms => new Promise(r => setTimeout(r, ms));
  const __reportUrl = ${urlLit};
  const __tryWidenViewport = async () => {
    try { if (typeof page.setViewport === 'function') await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 }); } catch (_) {}
    try { if (typeof page.setViewportSize === 'function') await page.setViewportSize({ width: 1920, height: 1080 }); } catch (_) {}
    try {
      await page.evaluate(() => {
        document.documentElement.style.zoom = '100%';
        if (document.body) document.body.style.zoom = '100%';
      });
    } catch (_) {}
  };
  await __tryWidenViewport();
  const __detectLoginForm = () => page.evaluate(() => {
    const norm = s => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const hasUserField = !!document.querySelector(
      'input[placeholder*="user name" i], input[name*="user" i], input[id*="user" i], #Uid'
    );
    const hasPwdField = !!document.querySelector('input[type="password"], #Pwd');
    const hasLoginBtn = Array.from(document.querySelectorAll('button, input[type="submit"], div[role="button"], a'))
      .some(el => /log ?in/.test(norm(el.innerText || el.value || '')));
    return hasUserField || hasPwdField || hasLoginBtn;
  }).catch(() => false);
  await page.goto(__reportUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await __sleep(2000);
  let __hasLoginForm = await __detectLoginForm();
  if (__hasLoginForm && typeof __creds !== 'undefined' && __creds && __creds.username) {
    const __onLoginPage = await page.evaluate(() => /\\/auth\\/ui\\/loginPage/i.test(location.href)).catch(() => false);
    if (!__onLoginPage && __creds.loginUrl) {
      await page.goto(__creds.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await __sleep(1000);
    }
    const __userSel = '#Uid, input[placeholder*="user name" i], input[name*="user" i], input[id*="user" i], input[type="text"]';
    const __pwdSel  = '#Pwd, input[type="password"], input[placeholder*="password" i]';
    await page.type(__userSel, __creds.username).catch(() => {});
    await page.type(__pwdSel, __creds.password).catch(() => {});
    await page.evaluate((pSel) => {
      const norm = s => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const cands = Array.from(document.querySelectorAll('button, input[type="submit"], div[role="button"], a'));
      let btn = cands.find(el => norm(el.innerText || el.value || '') === 'log in with credentials');
      if (!btn) btn = cands.find(el => /log ?in/.test(norm(el.innerText || el.value || '')));
      if (btn) { btn.click(); return true; }
      const pwd = document.querySelector(pSel);
      const form = pwd && pwd.closest('form');
      if (form) { (form.requestSubmit ? form.requestSubmit() : form.submit()); return true; }
      return false;
    }, __pwdSel).catch(() => {});
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null),
      __sleep(3000),
    ]);
    await __sleep(1500);
    const __loginFailed = await page.evaluate(() =>
      /login\\s*failure|error\\s*in\\s*login|invalid (user|credentials|password)|incorrect (user|password)/i.test(document.body.innerText || '')
    ).catch(() => false);
    if (__loginFailed) {
      return { ok: false, error: 'LOGIN_FAILED', message: 'Credentials rejected by the report login page' };
    }
    await page.goto(__reportUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await __sleep(2000);
    __hasLoginForm = await __detectLoginForm();
    if (__hasLoginForm) {
      return { ok: false, error: 'LOGIN_FAILED', message: 'Still on login page after submitting credentials' };
    }
    await __tryWidenViewport();
  } else if (__hasLoginForm) {
    return { ok: false, error: 'AUTH_REQUIRED', message: 'Login form present but no credentials provided' };
  }
  // === END AUTO-INJECTED AUTH CHECK ===

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const reportUrl = ${urlLit};
  const GRID_TITLE = ${titleLit};
  const KPI_LABEL = ${kpiLit};
  const TIME_GRAIN = ${grainLit};
  const EXPECTED_COLUMNS = ${colsLit};
  const NAV_STEPS = ${navLit};
  const NAV_OPENERS = ['Menu', 'Navigation', 'More', 'Open menu', 'Main menu', '☰'];
  // Trend viz title is often "Performance Trend Grid"; GRID_TITLE is the shorter tab label.
  const gridTitleHints = () => {
    const hints = [];
    const add = (s) => {
      const t = String(s || '').trim();
      if (!t) return;
      if (hints.some(h => h.toLowerCase() === t.toLowerCase())) return;
      if (/nbrx|nrx|trx|writers|calls|reach|frequency/i.test(t) && !/grid|trend|geography/i.test(t)) return;
      hints.push(t);
    };
    add(GRID_TITLE);
    if (/trend/i.test(GRID_TITLE)) {
      add(KPI_LABEL);
      add('Performance Trend Grid');
    }
    hints.sort((a, b) => b.length - a.length);
    return hints;
  };
  await __tryWidenViewport();

  const waitForLoadingToFinish = async (maxMs = 20000) => {
    const start = Date.now();
    await sleep(400);
    const isLoading = () => page.evaluate(() => {
      const bodyText = document.body ? document.body.innerText : '';
      if (/Loading\\s*Data/i.test(bodyText)) {
        for (const el of Array.from(document.querySelectorAll('*'))) {
          let direct = '';
          for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) direct += n.textContent;
          if (!/Loading\\s*Data/i.test(direct)) continue;
          const r = el.getBoundingClientRect();
          const st = window.getComputedStyle(el);
          if (r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none')
            return true;
        }
      }
      const spin = document.querySelector(
        '.mstrmojo-WaitBox, .mstrmojo-Wait, .mstrWaitBox, [class*="WaitBox" i], [class*="loading" i][class*="overlay" i]'
      );
      if (spin) {
        const r = spin.getBoundingClientRect();
        const st = window.getComputedStyle(spin);
        if (r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none')
          return true;
      }
      return false;
    }).catch(() => false);
    while (Date.now() - start < maxMs) {
      const loading = await isLoading();
      if (!loading) {
        await sleep(800);
        if (!(await isLoading())) return;
      }
      await sleep(400);
    }
  };

  // Ready BEFORE tab nav: filter chrome / footer tabs. Do not wait for grid
  // titles or "NBRx Total" here — those live on Geography / Trend, not Overview.
  const waitForDossierReady = async (maxMs = 25000) => {
    await waitForLoadingToFinish(Math.min(maxMs, 15000));
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const found = await page.evaluate(() => {
        const norm = s => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
        const isVisible = el => {
          const r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) return false;
          const st = getComputedStyle(el);
          return st.visibility !== 'hidden' && st.display !== 'none';
        };
        if (document.querySelector('input[type="password"], #Pwd')) return false;
        if (document.querySelector('.mstrmojo-DocSelector, [class*="DocSelector"], [class*="FilterPanel" i]')) return true;
        for (const el of Array.from(document.querySelectorAll('label, span, div, td, th, button, a, [role="tab"]'))) {
          if (!isVisible(el)) continue;
          let t = '';
          for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) t += n.textContent;
          const nrm = norm(t);
          if (nrm === 'area' || nrm === 'overview' || nrm === 'performance') return true;
        }
        return false;
      }).catch(() => false);
      if (found) {
        await waitForLoadingToFinish(8000);
        return true;
      }
      await sleep(600);
    }
    return false;
  };

  // Ready AFTER tab nav: require real grid evidence, not the tab/radio words
  // "Performance Trend" / "Quarterly" that exist before the crosstab paints.
  // One call after nav and one before scrape — never after every filter pick.
  const waitForDashboard = async (maxMs = 15000) => {
    await waitForLoadingToFinish(Math.min(maxMs, 15000));
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const found = await page.evaluate((expectedCols) => {
        const norm = s => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
        const isVisible = el => {
          const r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) return false;
          const st = getComputedStyle(el);
          return st.visibility !== 'hidden' && st.display !== 'none';
        };
        const getDirectText = el => {
          let t = '';
          for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) t += n.textContent;
          return t.trim();
        };
        const isNavChrome = el => {
          if (!el || !el.closest) return false;
          if (el.closest('[role="tab"], [role="tablist"], [role="navigation"]')) return true;
          const r = el.getBoundingClientRect();
          const vh = window.innerHeight || 900;
          return r.top > vh * 0.82 && r.height < 52 && r.width < 320;
        };
        const looksLikeHeader = el => {
          const r = el.getBoundingClientRect();
          return r.width >= 16 && r.width < 360 && r.height >= 8 && r.height < 56;
        };
        const headerTexts = [];
        const sels = 'th, [role="columnheader"], [class*="ag-header-cell"], [class*="Xtab" i] span, [class*="xtab" i] span, [class*="Xtab" i] div, [class*="xtab" i] div';
        for (const el of Array.from(document.querySelectorAll(sels))) {
          if (!isVisible(el) || isNavChrome(el) || !looksLikeHeader(el)) continue;
          const d = norm(getDirectText(el) || el.innerText || '');
          if (d && d.length < 60) headerTexts.push(d);
        }
        if (!headerTexts.length) {
          for (const el of Array.from(document.querySelectorAll('span, div, label'))) {
            if (!isVisible(el) || isNavChrome(el) || !looksLikeHeader(el)) continue;
            const d = norm(getDirectText(el));
            if (d && d.length < 40) headerTexts.push(d);
          }
        }
        if (headerTexts.some(t => t === 'employee name')) return true;
        const metrics = (expectedCols || []).map(c => norm(c)).filter(c => c && c !== 'area' && c !== 'employee name');
        const metricHits = metrics.filter(m => headerTexts.some(t => t === m));
        if (metricHits.length >= 2) return true;
        const xtab = Array.from(document.querySelectorAll('[class*="Xtab" i], [class*="xtab" i], [role="grid"], table, [class*="ag-root" i]'))
          .some(el => {
            if (!isVisible(el) || isNavChrome(el)) return false;
            const r = el.getBoundingClientRect();
            return r.width > 220 && r.height > 90;
          });
        if (xtab && headerTexts.some(t => t === 'area' || t === 'employee name' || /nbrx total|nrx total|trx total/.test(t))) return true;
        return false;
      }, EXPECTED_COLUMNS).catch(() => false);
      if (found) break;
      await sleep(500);
    }
    await waitForLoadingToFinish(5000);
  };

  const closeAnyOpenDropdown = async () => {
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Escape', code: 'Escape', bubbles: true }));
    }).catch(() => {});
    await sleep(250);
  };

  const clickByText = async (step, opts = {}) => {
    const openers = (opts && opts.openers) || NAV_OPENERS;
    const tryClick = async () => page.evaluate((label) => {
      const norm = s => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const want = norm(label);
      const isVisible = el => {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        const st = getComputedStyle(el);
        return st.visibility !== 'hidden' && st.display !== 'none';
      };
      const getDirectText = el => {
        let t = '';
        for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) t += n.textContent;
        return t.trim();
      };
      const isLongerPhrase = (s) => s.startsWith(want) && s.length > want.length && /\\s/.test(s.slice(want.length));
      const nodes = Array.from(document.querySelectorAll('button, a, [role="tab"], [role="button"], span, div, li'));
      const exact = [], fuzzy = [];
      for (const el of nodes) {
        if (!isVisible(el)) continue;
        const t = norm(el.innerText || el.textContent || '');
        const d = norm(getDirectText(el));
        const r = el.getBoundingClientRect();
        const area = r.width * r.height;
        if (area >= 80000) continue;
        if (t === want || d === want) { exact.push({ el, area }); continue; }
        // "Performance" must not click "Performance Trend"
        if (t.length <= want.length + 16 && t.includes(want) && !isLongerPhrase(t) && !isLongerPhrase(d)) {
          fuzzy.push({ el, area });
        }
      }
      const pool = exact.length ? exact : fuzzy;
      if (!pool.length) return { error: 'not found: ' + label };
      pool.sort((a, b) => a.area - b.area);
      const best = pool[0].el;
      best.click();
      return { clicked: true, text: (best.innerText || '').trim().slice(0, 60) };
    }, step).catch(() => ({ error: 'evaluate failed' }));
    let res = await tryClick();
    if (res && res.error) {
      for (const op of openers) {
        await page.evaluate((label) => {
          const norm = s => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
          const want = norm(label);
          for (const el of Array.from(document.querySelectorAll('button, [role="button"], span, div'))) {
            const t = norm(el.innerText || el.textContent || '');
            if (t === want || t === '☰') { el.click(); return true; }
          }
          return false;
        }, op).catch(() => false);
        await sleep(400);
        res = await tryClick();
        if (res && !res.error) break;
      }
    }
    await waitForLoadingToFinish(15000);
    return res;
  };

${FILTER_CORE_JS}


  const prettyCol = (s) => String(s || '')
    .replace(/\\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\\b([a-z])/g, (c) => c.toUpperCase());

  const isJunkCol = (k) => {
    const s = String(k || '');
    if (!s.trim()) return true;
    if (/^col_\\d+$/i.test(s)) return true;
    if (/line\\s*copy/i.test(s)) return true;
    if (/performance\\s*kpis/i.test(s)) return true;
    // KPI tile text glued into a header: "NBRx Total 3,391.0"
    if (/\\d/.test(s) && /nbrx|nrx|trx|writers|blink|calls|reach|frequency/i.test(s)) return true;
    // Territory ids mistaken for columns
    if (/^\\d{3}[a-z]\\b/i.test(s)) return true;
    return false;
  };

  const looksLikeRealGridHeaders = (headers) => {
    // Must work for ANY grid, not just Geography/Trend. Three independent signals,
    // strongest first; the Bayer metric vocabulary is the last resort, not the gate.
    const nh = (h) => String(h || '').toLowerCase().replace(/\\s+/g, ' ').trim();
    const clean = (headers || []).map(nh).filter((t) => t && !/performance\\s*kpis|line\\s*copy/.test(t));
    if (clean.length < 2) return false;

    // 1) Scenario-driven: the columns this scenario actually declared.
    const expectedNorm = (EXPECTED_COLUMNS || []).map(nh).filter(Boolean);
    if (expectedNorm.length && clean.filter((t) => expectedNorm.includes(t)).length >= 2) return true;

    // 2) Structural: a row of time periods means a crosstab, whatever the metrics are.
    const isPeriodHdr = (t) =>
      /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[-/ ]?\\d{2,4}$/.test(t)
      || /^q[1-4][-/ ]?(fy)?\\d{2,4}$/.test(t)
      || /^(fy|cy)[-/ ]?\\d{2,4}$/.test(t)
      || /^\\d{4}[-/]\\d{1,2}$/.test(t)
      || /^(ytd|qtd|mtd|wtd|r4w|r12w|r13w|r26w|r52w)$/.test(t)
      || /^latest (week|month|quarter)$/.test(t);
    if (clean.filter(isPeriodHdr).length >= 2) return true;

    // 3) Legacy vocabulary (keeps existing Geography / Trend scrapes working).
    const vocab = /employee name|^area$|territory|nbrx total|nrx total|trx total|total calls|reach \\(%\\)|frequency|latest month|qtd|metric/;
    return clean.filter((t) => vocab.test(t)).length >= 2;
  };

  const isGarbageGridRaw = (raw) => {
    if (!raw || raw.error) return true;
    const headers = raw.headers || raw.columns || [];
    // Geography / Trend grids often share the page with Overview KPI chrome.
    // Keep the scrape when real grid columns are present; toGrid drops junk headers.
    if (looksLikeRealGridHeaders(headers)) return false;
    const records = Array.isArray(raw.data) ? raw.data
      : (Array.isArray(raw.rows) && raw.rows[0] && !Array.isArray(raw.rows[0]) ? raw.rows : null);
    const blob = JSON.stringify({ headers, sample: (records || raw.rows || []).slice(0, 8) }).toLowerCase();
    if (/performance\\s*kpis\\s*-/.test(blob)) return true;
    if ((headers || []).filter((h) => /line\\s*copy/i.test(String(h))).length >= 2) return true;
    if ((headers || []).filter((h) => isJunkCol(h)).length >= Math.max(3, Math.floor((headers || []).length / 2))) return true;
    const clean = (headers || []).filter((h) => !isJunkCol(h));
    if ((headers || []).length && clean.length < 2) return true;
    return false;
  };

  const looksLikeMetricLabel = (t) => /nbrx|nrx|trx|blink|writer|call|reach|frequency|speaker|breadth|depth|paid|sample/i.test(String(t || ''));

  const promoteRowLabelColumn = (columns, rows) => {
    const cols = (columns || []).map((c, i) => String(c || '').trim() || ('col_' + i));
    const body = Array.isArray(rows) ? rows : [];
    if (cols.length < 2 || !body.length) return { columns: cols, rows: body };
    const stub = !String(columns[0] || '').trim() || /^col_\\d+$/i.test(String(columns[0] || ''));
    const hits = body.filter((r) => looksLikeMetricLabel(r && r[0])).length;
    if (stub && hits >= 1) cols[0] = 'Metric';
    return { columns: cols, rows: body };
  };

  const dropRepeatedLabelRows = (rows) => (rows || []).filter((line) => {
    const vals = (line || []).map((c) => String(c || '').replace(/\\s+/g, ' ').trim()).filter(Boolean);
    if (vals.length < 2) return true;
    const uniq = Array.from(new Set(vals.map((v) => v.toLowerCase())));
    if (uniq.length === 1 && /^(latest month|current time period|prior month)$/i.test(uniq[0])) return false;
    return true;
  });

  // Show Data renders the grid exactly as the dossier computed it. Take it AS IS:
  // no column filtering, no row dropping, no label promotion, no header renaming.
  // (isJunkCol used to delete the metric-label column, whose header is blank.)
  const isShowDataVia = (v) => /^show-data/.test(String(v || ''));
  const isChromeScrape = (raw) => {
    const hdrs = (raw.headers || raw.columns || []).map((h) => String(h || '').toLowerCase());
    if (hdrs.filter((h) => /line\\s*copy/.test(h)).length >= 2) return true;
    const blob = JSON.stringify({ h: hdrs, s: (raw.rows || []).slice(0, 4) }).toLowerCase();
    return /performance\\s*kpis\\s*-/.test(blob);
  };
  // MSTR flattens a crosstab's corner/axis titles ("Time Period", "Latest Month")
  // into the header row. They carry no data, so every value lands one or two columns
  // to the right of its real period and the last columns come back blank.
  // Self-correcting: the number of all-blank trailing columns == the number of
  // surplus axis titles, so trim that many from the front (after the label column).
  const isDataPeriodCol = (t) => {
    const x = String(t || '').toLowerCase().replace(/\\s+/g, ' ').trim();
    return /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[-/ ]?\\d{2,4}$/.test(x)
      || /^q[1-4][-/ ]?(fy)?\\d{2,4}$/.test(x)
      || /^\\d{4}[-/ ]?q[1-4]$/.test(x)
      || /^(fy|cy)[-/ ]?\\d{2,4}[-/ ]?q?[1-4]?$/.test(x)
      || /^\\d{4}[-/]\\d{1,2}$/.test(x);
  };
  const alignVerbatim = (headers, rows) => {
    const w = headers.length;
    if (!rows.length || w < 3) return { headers, rows, dropped: [] };
    const blank = (v) => String(v == null ? '' : v).trim() === '';
    let trail = 0;
    while (trail < w - 2 && rows.every((r) => blank(r[w - 1 - trail]))) trail++;
    if (!trail) return { headers, rows, dropped: [] };
    const cand = headers.slice(1, 1 + trail);
    if (cand.some(isDataPeriodCol)) {
      // Real period columns that happen to be empty — just drop them, do not shift.
      return { headers: headers.slice(0, w - trail), rows: rows.map((r) => r.slice(0, w - trail)), dropped: [] };
    }
    return {
      headers: [headers[0]].concat(headers.slice(1 + trail)),
      rows: rows.map((r) => [r[0]].concat(r.slice(1, w - trail))),
      dropped: cand,
    };
  };


  const toVerbatimGrid = (raw) => {
    const srcHdrs = (raw.headers || raw.columns || []);
    const headers = srcHdrs.map((h, i) => {
      const t = String(h == null ? '' : h).trim();
      return t || ('col_' + i);   // keep the blank metric-label column, never drop it
    });
    let rows;
    if (Array.isArray(raw.rows) && Array.isArray(raw.rows[0])) {
      rows = raw.rows.map((r) => headers.map((_, i) => (r && r[i] != null ? String(r[i]) : '')));
    } else {
      const recs = Array.isArray(raw.data) ? raw.data : (Array.isArray(raw.rows) ? raw.rows : []);
      rows = recs.map((rec) => srcHdrs.map((k) => (rec && rec[k] != null ? String(rec[k]) : '')));
    }
    const aligned = alignVerbatim(headers, rows);
    return {
      columns: aligned.headers,
      rows: aligned.rows,
      via: 'show-data-verbatim',
      verbatim: true,
      column_count: aligned.headers.length,
      row_count: aligned.rows.length,
      dropped_axis_titles: aligned.dropped,
    };
  };

  const toGrid = (raw) => {
    if (!raw || raw.error) return raw || { error: 'no table' };
    if (isShowDataVia(raw.via)) return toVerbatimGrid(raw);
    if (isGarbageGridRaw(raw)) return { error: 'rejected Performance KPIs / chrome scrape', via: raw.via || 'rejected' };
    if (Array.isArray(raw.columns) && Array.isArray(raw.rows) && Array.isArray(raw.rows[0])) {
      const promoted = promoteRowLabelColumn(raw.columns, raw.rows);
      const body = dropRepeatedLabelRows(promoted.rows);
      const keepIdx = promoted.columns.map((c, i) => (isJunkCol(c) ? -1 : i)).filter((i) => i >= 0);
      if (keepIdx.length < 2) return { error: 'too few clean columns after filter', via: raw.via || 'normalized-grid', headers: promoted.columns };
      return {
        columns: keepIdx.map((i) => prettyCol(promoted.columns[i])),
        rows: body.map((row) => keepIdx.map((i) => (row && row[i] != null ? String(row[i]) : ''))),
        via: raw.via || 'normalized-grid',
      };
    }
    const records = Array.isArray(raw.data) ? raw.data
      : (Array.isArray(raw.rows) && raw.rows.length && raw.rows[0] && !Array.isArray(raw.rows[0]) ? raw.rows : null);
    if (!records || !records.length) return raw;
    const rawHeaders = Array.isArray(raw.headers) && raw.headers.length
      ? raw.headers
      : (Array.isArray(raw.columns) && raw.columns.length ? raw.columns : Object.keys(records[0] || {}));
    const seenHdr = {};
    const keys = rawHeaders.map((h, i) => {
      const base = String(h || '').trim() || ('col_' + i);
      const n = (seenHdr[base] = (seenHdr[base] || 0) + 1);
      return n === 1 ? base : (base + ' (' + n + ')');
    }).filter((k) => k && !isJunkCol(k));
    if (keys.length < 2) return { error: 'too few clean columns after filter', via: raw.via, headers: rawHeaders };
    const columns = keys.map(prettyCol);
    const rows = records.map((rec) => keys.map((k) => (rec[k] == null ? '' : String(rec[k]))));
    // Drop rows that are clearly Overview KPI chrome
    const cleanRows = rows.filter((line) => !/performance\\s*kpis/i.test(String(line[0] || '')));
    if (!cleanRows.length) return { error: 'only Performance KPIs rows after filter' };
    return { columns, rows: cleanRows, data: records, via: raw.via || 'normalized-grid' };
  };

  const dismissGenericErrorDialog = async () => {
    await page.evaluate(() => {
      const norm = s => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      for (const el of Array.from(document.querySelectorAll('button, [role="button"], a, span'))) {
        const t = norm(el.innerText || el.textContent || '');
        if (t === 'ok' || t === 'close' || t === 'dismiss') {
          const box = el.closest('[role="dialog"], .mstrmojo-Dialog, .mstrmojo-MsgBox, [class*="Dialog"], [class*="Modal"]');
          if (box || /error|warning/i.test((document.body && document.body.innerText) || '')) {
            try { el.click(); } catch (_) {}
          }
        }
      }
    }).catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(200);
  };

  // Locate grid/crosstab (or chart) under GRID_TITLE — used to open widget Menu → Show Data.
  const findGridWidget = async (titleText) => {
    for (const frame of page.frames()) {
      const result = await frame.evaluate((want) => {
        const isVisible = el => {
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) return false;
          const st = getComputedStyle(el);
          return st.visibility !== 'hidden' && st.display !== 'none';
        };
        const getDirectText = el => {
          let t = '';
          for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) t += n.textContent;
          return t.trim();
        };
        const hints = (Array.isArray(want) ? want : [want]).map(s => String(s || '').trim()).filter(Boolean);
        const vh = window.innerHeight || 900;
        const isNavChrome = el => {
          if (!el || !el.closest) return false;
          if (el.closest('[role="tab"], [role="tablist"], [role="navigation"]')) return true;
          const r = el.getBoundingClientRect();
          if (r.top > vh * 0.82 && r.height < 52 && r.width < 320) return true;
          let cls = '';
          try { cls = String(el.className || ''); } catch (_) {}
          return /dock|pageTab|TabBar|tab-item|mstrmojo-Dock|navItem/i.test(cls);
        };
        let titleEl = null, titleScore = -Infinity;
        for (const hint of hints) {
          const target = hint.toLowerCase();
          for (const el of Array.from(document.querySelectorAll('*'))) {
            if (!isVisible(el) || isNavChrome(el)) continue;
            const r = el.getBoundingClientRect();
            if (r.top > vh * 0.88) continue; // skip footer tabs
            const d = (getDirectText(el) || '').toLowerCase();
            const full = ((el.innerText || '').replace(/\\s+/g, ' ').trim()).toLowerCase();
            const exact = d === target || full === target;
            const hit = exact || (d.includes(target) && d.length <= target.length + 28)
              || (full.includes(target) && full.length <= target.length + 28);
            if (!hit) continue;
            const area = r.width * r.height;
            if (area > 160000) continue;
            const score = (exact ? 5000 : 0) + target.length * 20 - Math.sqrt(area) - r.top * 0.05;
            if (score > titleScore) { titleScore = score; titleEl = el; }
          }
        }
        if (!titleEl) {
          for (const el of Array.from(document.querySelectorAll('th, [role="columnheader"], span, div, td'))) {
            if (!isVisible(el) || isNavChrome(el)) continue;
            if (String(getDirectText(el) || '').toLowerCase() !== 'employee name') continue;
            const r = el.getBoundingClientRect();
            if (r.width > 400 || r.height > 60) continue;
            titleEl = el;
            break;
          }
        }
        if (!titleEl) return { error: 'grid title not found: ' + hints.join(' / ') };
        const tr = titleEl.getBoundingClientRect();
        const sels = [
          '[class*="Xtab" i]', '[class*="xtab" i]', '[role="grid"]', 'table',
          '[class*="Grid" i]', '[class*="ag-root" i]',
          'canvas', 'svg', '[class*="highcharts" i]', '[class*="mstrmojo-graph" i]',
        ];
        let best = null, bestScore = -1, bestRect = null;
        for (const el of Array.from(document.querySelectorAll(sels.join(',')))) {
          if (!isVisible(el)) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 120 || r.height < 60) continue;
          if (r.bottom < tr.top - 20) continue;
          if (r.top < tr.bottom - 40 && r.top + 40 < tr.bottom) continue;
          const dist = Math.max(0, r.top - tr.bottom) + Math.abs(r.left - tr.left) * 0.15;
          const score = (r.width * r.height) / 1000 - dist;
          if (score > bestScore) { bestScore = score; best = el; bestRect = r; }
        }
        if (!bestRect) {
          // Fallback: large region below title (menu still works on hover)
          bestRect = {
            top: tr.bottom + 4,
            left: Math.max(0, tr.left),
            width: Math.max(400, Math.min(900, (window.innerWidth || 1200) - tr.left - 40)),
            height: Math.max(220, Math.min(480, vh - tr.bottom - 40)),
          };
        }
        return { top: bestRect.top, left: bestRect.left, width: bestRect.width, height: bestRect.height };
      }, titleText).catch(() => null);
      if (result && !result.error) return { frame, rect: result };
    }
    return { frame: null, rect: null, error: 'grid widget not located for ' + titleText };
  };

  const getFrameViewportOffset = async (frame) => {
    if (!frame || frame === page.mainFrame()) return { x: 0, y: 0 };
    try {
      const frameEl = await frame.frameElement();
      const box = await frameEl.boundingBox();
      if (box) return { x: box.x, y: box.y };
    } catch (_) {}
    return { x: 0, y: 0 };
  };

  const openShowData = async (titleText) => {
    await dismissGenericErrorDialog();
    await closeAnyOpenDropdown();
    await waitForLoadingToFinish(20000);
    const { frame, rect, error } = await findGridWidget(titleText);
    if (!frame || !rect) return { error: error || 'grid widget not located' };
    const frameOffset = await getFrameViewportOffset(frame);
    const cx = frameOffset.x + rect.left + rect.width / 2;
    const cy = frameOffset.y + rect.top + Math.min(40, rect.height / 3);
    const cornerX = frameOffset.x + rect.left + rect.width - 18;
    const cornerY = frameOffset.y + rect.top + 14;

    const clickDotsAt = async (ax, ay) => {
      await page.mouse.move(cx, cy, { steps: 12 });
      await sleep(350);
      await page.mouse.move(ax, ay, { steps: 12 });
      await sleep(700);
      return await frame.evaluate(([anchorX, anchorY]) => {
        const isVisible = el => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          const st = getComputedStyle(el);
          return st.visibility !== 'hidden' && st.display !== 'none';
        };
        const known = Array.from(document.querySelectorAll(
          '.hover-menu-btn, .hover-btn, [aria-label="Context Menu"], [aria-label*="context menu" i], [aria-label*="More" i], [title*="More" i]'
        )).filter(isVisible);
        if (known.length) {
          known.sort((a, b) => {
            const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
            const da = Math.abs(ra.left - anchorX) + Math.abs(ra.top - anchorY);
            const db = Math.abs(rb.left - anchorX) + Math.abs(rb.top - anchorY);
            return da - db;
          });
          known[0].click();
          return { clicked: true, via: 'known-menu-btn' };
        }
        for (const el of Array.from(document.querySelectorAll('*'))) {
          if (!isVisible(el)) continue;
          const t = (el.innerText || el.textContent || '').trim();
          if (t === '...' || t === '⋮' || t === '•••' || t === '···') {
            el.click();
            return { clicked: true, via: 'text-dots' };
          }
          const al = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title') || '')) || '';
          if (/more options|show more|kebab|ellipsis|3.?dot|three.?dot|context\\s*menu/i.test(al)) {
            el.click();
            return { clicked: true, via: 'aria-label' };
          }
        }
        const classRe = /more|kebab|ellipsis|overflow|menu|dots?[-_]?btn|hover-btn/i;
        for (const el of Array.from(document.querySelectorAll('*'))) {
          if (!isVisible(el)) continue;
          const cls = (el.getAttribute && el.getAttribute('class')) || '';
          if (!cls || !classRe.test(cls)) continue;
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.width < 64 && r.height > 0 && r.height < 64) {
            el.click();
            return { clicked: true, via: 'class-keyword' };
          }
        }
        return { error: 'dots / menu button not found' };
      }, [ax - frameOffset.x, ay - frameOffset.y]).catch(() => ({ error: 'dots evaluate failed' }));
    };

    let dotsClicked = await clickDotsAt(cornerX, cornerY);
    if (dotsClicked.error) {
      for (const [dx, dy] of [[-8, 0], [8, 0], [0, -8], [0, 8], [-16, -4], [16, -4], [-20, 10], [10, 20]]) {
        dotsClicked = await clickDotsAt(cornerX + dx, cornerY + dy);
        if (dotsClicked.clicked) break;
      }
    }
    if (dotsClicked.error) {
      await page.mouse.click(cx, cy, { button: 'right' });
      await sleep(700);
      dotsClicked = { clicked: true, via: 'right-click' };
    }
    await sleep(800);

    const clickShowDataAnywhere = async () => {
      const tryClick = () => {
        const norm = s => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
        const isVisible = el => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          const st = getComputedStyle(el);
          return st.visibility !== 'hidden' && st.display !== 'none';
        };
        const isMatch = t => t === 'show data' || t === 'export data' || t === 'view data'
          || /^show\\s*data/.test(t) || t.includes('show data');
        const exact = [], fuzzy = [];
        for (const el of Array.from(document.querySelectorAll('li, button, a, span, div, [role="menuitem"], [role="option"]'))) {
          if (!isVisible(el)) continue;
          const raw = (el.innerText || el.textContent || '').trim();
          if (!raw || raw.length > 40) continue;
          const t = norm(raw);
          const r = el.getBoundingClientRect();
          const area = r.width * r.height;
          if (t === 'show data' || t === 'export data') exact.push({ el, area });
          else if (isMatch(t) && area < 8000) fuzzy.push({ el, area });
        }
        exact.sort((a, b) => a.area - b.area);
        fuzzy.sort((a, b) => a.area - b.area);
        const best = exact[0] || fuzzy[0];
        if (best) { best.el.click(); return { clicked: true, text: (best.el.innerText || '').trim() }; }
        return { error: 'Show Data menu item not found' };
      };
      try {
        const r = await frame.evaluate(tryClick);
        if (r && r.clicked) return r;
      } catch (_) {}
      for (const f of page.frames()) {
        try {
          const r = await f.evaluate(tryClick);
          if (r && r.clicked) return r;
        } catch (_) {}
      }
      return await page.evaluate(tryClick).catch((e) => ({ error: String(e && e.message || e) }));
    };

    let showDataClicked = await clickShowDataAnywhere();
    if (showDataClicked.error) {
      await dismissGenericErrorDialog();
      dotsClicked = await clickDotsAt(cornerX, cornerY);
      await sleep(900);
      showDataClicked = await clickShowDataAnywhere();
    }
    if (showDataClicked.error) return { error: showDataClicked.error, dots: dotsClicked };
    await sleep(1000);
    return { ok: true, dots: dotsClicked, showData: showDataClicked };
  };

  const extractShowDataTable = async () => {
    const extractFn = (expectedCols) => {
      const norm = s => (s || '').replace(/\\s+/g, ' ').trim();
      const isVisible = el => {
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 20) return false;
        const st = getComputedStyle(el);
        return st.visibility !== 'hidden' && st.display !== 'none';
      };
      const POPUP_SEL = '[role="dialog"], .mstrmojo-popup, .mstrmojo-Popup, .mstrmojo-Dialog, .mstrmojo-RootPopup, .mstrmojo-MsgBox, [class*="Popup"], [class*="Modal"], [class*="Dialog"]';
      const isControlText = (t) => /^(close|ok|cancel|export|print|search|filter)$/i.test(norm(t));
      const isKpiLike = (headers, data) => {
        if (!headers || headers.length < 2) return true;
        if (!data || !data.length) return true;
        const blob = JSON.stringify({ headers, data: data.slice(0, 5) }).toLowerCase();
        if (/performance\\s*kpis\\s*-/.test(blob)) return true;
        if ((headers.filter(h => /line\\s*copy/i.test(String(h))).length) >= 2) return true;
        return false;
      };
      const scoreTable = (table) => {
        if (!table || !table.rows || table.rows.length < 2) return 0;
        let cols = 0;
        for (let i = 0; i < Math.min(table.rows.length, 4); i++) {
          cols = Math.max(cols, table.rows[i] ? table.rows[i].cells.length : 0);
        }
        if (cols < 2) return 0;
        return table.rows.length * cols;
      };
      const headerNorm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9%]+/g, '');
      const expectedKeys = (expectedCols || []).map(headerNorm).filter(Boolean);
      const uniquifyHeaders = (headers) => {
        const seen = {};
        return (headers || []).map((h, i) => {
          const base = String(h || '').trim() || ('col_' + i);
          const n = (seen[base] = (seen[base] || 0) + 1);
          return n === 1 ? base : (base + ' (' + n + ')');
        });
      };
      const isDataRow = (cells) => {
        const numeric = cells.filter((t) => /^[\\d,.%$()\\s-]+$/.test(String(t || '').replace(/,/g, ''))).length;
        return numeric >= Math.max(2, Math.floor(cells.length / 2));
      };
      const scoreHeaderRow = (cells) => {
        const named = cells.filter((t) => t && !/^[\\d,.%()\\s/-]+$/.test(t));
        const unique = new Set(named.map((t) => t.toLowerCase().replace(/\\s+/g, ' ').trim()));
        if (named.length >= 3 && unique.size <= 1) return -100;
        let hits = 0;
        for (const k of expectedKeys) {
          if ([...unique].some((u) => {
            const n = headerNorm(u);
            return n && k && (n === k || n.includes(k) || k.includes(n));
          })) hits++;
        }
        return unique.size * 8 + hits * 25;
      };
      const parseHtmlTable = (table) => {
        const rows = Array.from(table.querySelectorAll('tr'));
        if (rows.length < 2) return null;
        const rowCells = (tr) => Array.from(tr.querySelectorAll('th, td')).map((h) => (h.innerText || h.textContent || '').trim());
        let headerIdx = 0;
        let bestScore = -Infinity;
        for (let i = 0; i < Math.min(rows.length, 6); i++) {
          const cells = rowCells(rows[i]);
          if (cells.length < 2 || isDataRow(cells)) continue;
          const score = scoreHeaderRow(cells);
          if (score > bestScore) { bestScore = score; headerIdx = i; }
        }
        const headerTexts = rowCells(rows[headerIdx]);
        if (headerTexts.length < 2) return null;
        const headers = uniquifyHeaders(headerTexts.map((t, i) => t || ('col_' + i)));
        const matrix = [];
        const data = [];
        for (let i = 0; i < rows.length; i++) {
          if (i === headerIdx) continue;
          const cells = Array.from(rows[i].querySelectorAll('td, th'));
          if (!cells.length) continue;
          const rowText = norm(rows[i].innerText || rows[i].textContent || '');
          if (isControlText(rowText)) continue;
          const line = headers.map((_, idx) => cells[idx] ? (cells[idx].innerText || cells[idx].textContent || '').trim() : '');
          if (!line.some(Boolean)) continue;
          matrix.push(line);
          const rowData = {};
          headers.forEach((h, idx) => { rowData[h] = line[idx]; });
          data.push(rowData);
        }
        if (headers[0] && /^col_\\d+$/i.test(headers[0]) && matrix.some((line) => /nbrx|nrx|trx|reach|writer|call/i.test(String(line[0] || '')))) {
          headers[0] = 'Metric';
          matrix.forEach((line, i) => { if (data[i]) { data[i] = { Metric: line[0], ...data[i] }; delete data[i]['col_0']; } });
        }
        if (isKpiLike(headers, data)) return null;
        return { headers, columns: headers, rows: matrix, data, via: 'show-data-html-table' };
      };

      const parseAgGrid = (root) => {
        if (!root) return null;
        const headerEls = Array.from(root.querySelectorAll('.ag-header-cell, [class*="ag-header-cell"]')).filter(isVisible);
        if (headerEls.length < 2) return null;
        const headers = uniquifyHeaders(headerEls.map((h, i) => (h.innerText || h.textContent || '').trim() || ('col_' + i)));
        const data = [];
        const matrix = [];
        const rowEls = Array.from(root.querySelectorAll('.ag-row, [role="row"]')).filter(isVisible);
        for (const rowEl of rowEls) {
          if (rowEl.querySelector('.ag-header-cell, [role="columnheader"]')) continue;
          const cells = Array.from(rowEl.querySelectorAll('.ag-cell, [role="gridcell"], [role="cell"]'));
          if (!cells.length) continue;
          const line = headers.map((_, idx) => cells[idx] ? (cells[idx].innerText || cells[idx].textContent || '').trim() : '');
          if (!line.some(Boolean)) continue;
          if (isControlText(line.join(' '))) continue;
          matrix.push(line);
          const rowData = {};
          headers.forEach((h, idx) => { rowData[h] = line[idx]; });
          data.push(rowData);
        }
        if (isKpiLike(headers, data) || data.length < 1) return null;
        return { headers, columns: headers, rows: matrix, data, via: 'show-data-ag-grid' };
      };

      let popups = Array.from(document.querySelectorAll(POPUP_SEL)).filter(isVisible);

      // --- Show Data dialog selection -------------------------------------------
      // POPUP_SEL also matches MSTR prompt dropdowns ([class*="Popup"]). MSTR renders
      // those lists AS TABLES, so "has a <table>" cannot mean "is the grid" — that is
      // how ["4","001A - Coney Island, NY"] was scraped as the Performance Trend grid.
      // A real crosstab always has a label column plus >= 2 data columns.
      const MIN_GRID_COLS = 3;
      const pCols = (p) => ((p && (p.headers || p.columns)) || []).length;
      const pRows = (p) => ((p && p.rows) || []).length;
      const isUsableGrid = (p) => !!p && pCols(p) >= MIN_GRID_COLS && pRows(p) >= 1;

      const popupText = (el) => norm(el.innerText || el.textContent || '');
      const isShowDataDialog = (el) => {
        const t = popupText(el).toLowerCase();
        return /show data/.test(t) || /column set/.test(t) || /\\b\\d+\\s+rows?\\b/.test(t);
      };
      const maxTableCols = (el) => {
        let mx = 0;
        for (const t of Array.from(el.querySelectorAll('table'))) {
          for (const r of Array.from(t.rows || [])) mx = Math.max(mx, (r.cells || []).length);
        }
        return mx;
      };
      const looksLikeFilterList = (el) => {
        const items = Array.from(el.querySelectorAll('li, [role="option"], [role="listitem"]'));
        if (items.length >= 3) return true;
        const mx = maxTableCols(el);
        return mx > 0 && mx < MIN_GRID_COLS;   // narrow table == prompt list, not a grid
      };

      const dialogPopups = popups.filter((p) => isShowDataDialog(p) && !looksLikeFilterList(p));
      const otherPopups  = popups.filter((p) => !looksLikeFilterList(p));

      // Try Show-Data-looking popups, then any non-filter popup, then the page.
      // Every tier enforces the same shape floor, so a prompt list can never win.
      const tiers = [dialogPopups, otherPopups];
      let bestParsed = null, bestScore = 0;
      for (const tier of tiers) {
        for (const popup of tier) {
          for (const table of Array.from(popup.querySelectorAll('table'))) {
            const s = scoreTable(table);
            if (s < 4) continue;
            const parsed = parseHtmlTable(table);
            if (!isUsableGrid(parsed)) continue;
            if (s > bestScore) { bestScore = s; bestParsed = parsed; }
          }
        }
        if (bestParsed) break;
      }
      if (bestParsed) return bestParsed;

      const tables = Array.from(document.querySelectorAll('table')).filter((t) => scoreTable(t) >= 4);
      tables.sort((a, b) => scoreTable(b) - scoreTable(a));
      for (const table of tables) {
        const parsed = parseHtmlTable(table);
        if (isUsableGrid(parsed)) return parsed;
      }

      for (const popupEl of popups) {
        let rowEls = Array.from(popupEl.querySelectorAll('[role="row"]')).filter(isVisible);
        rowEls.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
        if (rowEls.length < 2) continue;
        let headerRowEl = rowEls.find(r => r.querySelector('[role="columnheader"]')) || rowEls[0];
        const headerCellEls = Array.from(headerRowEl.querySelectorAll('[role="columnheader"], [role="gridcell"], [role="cell"], td, [class*="cell" i]'));
        if (headerCellEls.length < 2) continue;
        const headerCols = headerCellEls.map((h, i) => {
          const r = h.getBoundingClientRect();
          return { name: (h.innerText || h.textContent || '').trim() || ('col_' + i), cx: r.left + r.width / 2 };
        });
        const data = [];
        for (const rowEl of rowEls.filter(r => r !== headerRowEl)) {
          const cells = Array.from(rowEl.querySelectorAll('[role="gridcell"], [role="cell"], td, [class*="cell" i]'));
          if (!cells.length) continue;
          const rowText = norm(rowEl.innerText || rowEl.textContent || '');
          if (isControlText(rowText)) continue;
          const rowData = {};
          for (const cell of cells) {
            const raw = (cell.innerText || cell.textContent || '').trim();
            if (!raw) continue;
            const r = cell.getBoundingClientRect();
            const cx = r.left + r.width / 2;
            let bestCol = null, bestDist = Infinity;
            for (const col of headerCols) {
              const d = Math.abs(cx - col.cx);
              if (d < bestDist) { bestDist = d; bestCol = col; }
            }
            if (bestCol) rowData[bestCol.name] = raw;
          }
          if (Object.keys(rowData).length > 0) data.push(rowData);
        }
        const headers = headerCols.map(c => c.name);
        if (!isKpiLike(headers, data) && data.length > 0) {
          return { headers, data, via: 'show-data-aria-grid' };
        }
      }
      const agRoots = Array.from(document.querySelectorAll('.ag-root, .ag-root-wrapper, [class*="ag-theme"]')).filter(isVisible);
      let bestAg = null, bestAgScore = 0;
      for (const root of agRoots) {
        const parsed = parseAgGrid(root);
        if (!parsed) continue;
        const s = (parsed.headers || []).length * ((parsed.data || []).length + 1);
        if (s > bestAgScore) { bestAgScore = s; bestAg = parsed; }
      }
      if (bestAg) return bestAg;
      return { error: 'Show Data table not found' };
    };

    for (const frame of page.frames()) {
      try {
        const result = await frame.evaluate(extractFn, EXPECTED_COLUMNS);
        if (result && !result.error) return result;
      } catch (_) {}
    }
    return await page.evaluate(extractFn, EXPECTED_COLUMNS).catch(() => ({ error: 'Show Data extract failed' }));
  };

  const closeShowDataPopup = async () => {
    const closed = await page.evaluate(() => {
      const norm = s => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      for (const el of Array.from(document.querySelectorAll('button, [role="button"], span, a'))) {
        const t = norm(el.innerText || el.textContent || '');
        if (t === 'close') { el.click(); return true; }
      }
      return false;
    }).catch(() => false);
    if (!closed) await page.keyboard.press('Escape').catch(() => {});
    await sleep(400);
  };

  const extractViaShowData = async (titleHint) => {
    // A prompt dropdown left open is itself a [class*="Popup"] and was being scraped
    // instead of the Show Data dialog (headers came back as territory values).
    await closeAnyOpenDropdown();
    await dismissGenericErrorDialog();
    const openResult = await openShowData(titleHint);
    if (openResult && openResult.error) return { error: openResult.error, open: openResult };
    await waitForLoadingToFinish(20000);
    const start = Date.now();
    let table = { error: 'Show Data table not found' };
    while (Date.now() - start < 8000) {
      table = await extractShowDataTable();
      // Accept the dialog's table as-is; only explicit Overview chrome is rejected.
      if (table && !table.error && !isChromeScrape(table)) break;
      await sleep(350);
    }
    await closeShowDataPopup();
    if (!table || table.error || isChromeScrape(table)) {
      return { error: (table && table.error) || 'Show Data returned KPI/chrome noise', open: openResult };
    }
    const nCols = (table.headers || table.columns || []).length;
    if (nCols < 3) {
      return { error: 'Show Data table had ' + nCols + ' column(s)', open: openResult, headers: table.headers || table.columns || [] };
    }
    return table;
  };

  const extractOnPageGrid = async (titleHint, expectedCols) => {
    const titleHints = (() => {
      const raw = Array.isArray(titleHint) ? titleHint : [titleHint];
      const hints = [];
      const add = (s) => {
        const t = String(s || '').trim();
        if (!t || hints.some(h => h.toLowerCase() === t.toLowerCase())) return;
        hints.push(t);
      };
      raw.forEach(add);
      if (raw.some(t => /trend/i.test(String(t || ''))) || /trend/i.test(GRID_TITLE)) {
        add(KPI_LABEL);
        add('Performance Trend Grid');
      }
      if (raw.some(t => /geography/i.test(String(t || ''))) || /geography/i.test(GRID_TITLE)) {
        add('Employee Name');
        add('Geography Details');
      }
      hints.sort((a, b) => b.length - a.length);
      return hints;
    })();
    const scrapeFn = (payload) => {
      const titleHintsIn = Array.isArray(payload && payload.titles)
        ? payload.titles
        : [String((payload && payload.title) || payload || '')];
      const norm = s => (s || '').replace(/\\s+/g, ' ').trim();
      const isOnPage = el => {
        try {
          const r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) return false;
          const st = getComputedStyle(el);
          return st.visibility !== 'hidden' && st.display !== 'none';
        } catch (_) { return false; }
      };
      function getDirectText(el) {
        let t = '';
        for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) t += n.textContent;
        return t.trim();
      }
      const isNoiseCell = (raw) => {
        const t = String(raw || '');
        if (/performance\\s*kpis/i.test(t)) return true;
        if (/^line\\s*copy/i.test(t)) return true;
        if (/\\d/.test(t) && /^(nbrx|nrx|trx|blink|total writers)\\b/i.test(t)) return true;
        return false;
      };
      const headerNameRe = /territory|employee name|area|nbrx total|nrx total|trx total|total calls|reach|frequency|speaker|quarter|qtd|metric/i;
      const vh = window.innerHeight || 900;
      const isNavChrome = el => {
        if (!el || !el.closest) return false;
        if (el.closest('[role="tab"], [role="tablist"], [role="navigation"]')) return true;
        const r = el.getBoundingClientRect();
        if (r.top > vh * 0.82 && r.height < 52 && r.width < 320) return true;
        let cls = '';
        try { cls = String(el.className || ''); } catch (_) {}
        return /dock|pageTab|TabBar|tab-item|mstrmojo-Dock|navItem/i.test(cls);
      };
      let titleEl = null, titleRect = null, titleScore = -Infinity;
      for (const hint of titleHintsIn) {
        const want = norm(hint).toLowerCase();
        if (!want) continue;
        for (const el of Array.from(document.querySelectorAll('*'))) {
          if (!isOnPage(el) || isNavChrome(el)) continue;
          const r = el.getBoundingClientRect();
          if (r.top > vh * 0.88) continue; // skip footer nav tabs
          const d = norm(getDirectText(el)).toLowerCase();
          const full = norm(el.innerText || '').toLowerCase();
          const exact = d === want || full === want;
          const hit = exact || (d.includes(want) && d.length <= want.length + 28)
            || (full.includes(want) && full.length <= want.length + 28);
          if (!hit) continue;
          const area = r.width * r.height;
          if (area > 160000) continue;
          const score = (exact ? 5000 : 0) + want.length * 20 - Math.sqrt(area) - r.top * 0.05;
          if (score > titleScore) { titleScore = score; titleEl = el; titleRect = r; }
        }
      }
      const preferEmployeeNameHeader = () => {
        for (const el of Array.from(document.querySelectorAll('th, [role="columnheader"], [class*="ag-header-cell"], span, div, td'))) {
          if (!isOnPage(el) || isNavChrome(el)) continue;
          if (norm(getDirectText(el) || el.innerText || '').toLowerCase() !== 'employee name') continue;
          const r = el.getBoundingClientRect();
          if (r.width > 400 || r.height > 60) continue;
          titleEl = el;
          titleRect = { top: Math.max(0, r.top - 36), left: r.left, bottom: r.bottom, right: r.right, width: r.width, height: r.height };
          return true;
        }
        return false;
      };
      // Page/tab label "Geography Details" is not the xtab — pin to Employee Name when present.
      if (!titleRect || (/geography/i.test(titleHintsIn.join(' ')) && titleRect && titleRect.height < 48 && titleRect.width < 360)) {
        preferEmployeeNameHeader();
      }
      if (!titleRect) preferEmployeeNameHeader();
      // Trend/Geography: do not scrape the whole page when title is missing (that yields KPI chrome).
      if (!titleRect && /trend|geography/i.test(titleHintsIn.join(' '))) {
        return { error: 'grid title not found on page', title_found: false, cell_count: 0 };
      }
      const region = titleRect
        ? { top: titleRect.bottom - 8, left: Math.max(0, titleRect.left - 80), right: 100000, bottom: Math.max((window.innerHeight || 900) + 400, titleRect.bottom + 900) }
        : { top: 60, left: 0, right: 100000, bottom: 10000 };

      const cellsFromTable = (table) => {
        const out = [];
        if (!table || !table.rows) return out;
        for (let i = 0; i < table.rows.length; i++) {
          const row = table.rows[i];
          for (let j = 0; j < row.cells.length; j++) {
            const el = row.cells[j];
            const r = el.getBoundingClientRect();
            const raw = norm(el.innerText || el.textContent || '');
            if (!raw || raw.length > 80) continue;
            out.push({ raw, cx: r.left + r.width / 2, top: r.top, left: r.left });
          }
        }
        return out;
      };

      const infos = [];
      const pushInfo = (raw, r) => {
        if (!raw) return;
        if (infos.some(o => o.raw === raw && Math.abs(o.cx - (r.left + r.width / 2)) < 6 && Math.abs(o.top - r.top) < 6)) return;
        infos.push({ raw, cx: r.left + r.width / 2, top: r.top, left: r.left });
      };

      for (const table of Array.from(document.querySelectorAll('table'))) {
        const r = table.getBoundingClientRect();
        if (titleRect && r.bottom < titleRect.top) continue;
        for (const c of cellsFromTable(table)) {
          if (!isNoiseCell(c.raw)) infos.push(c);
        }
      }

      const cellEls = Array.from(document.querySelectorAll(
        'th, td, [role="columnheader"], [role="gridcell"], [role="cell"], [class*="Xtab" i], [class*="xtab" i], [class*="ag-header-cell"], [class*="ag-cell"], [class*="cell" i], span, div'
      ));
      for (const el of cellEls) {
        const r = el.getBoundingClientRect();
        if (r.top < region.top || r.left < region.left - 40) continue;
        if (r.top > region.bottom) continue;
        if (r.width > 420 || r.height > 70 || r.width * r.height > 28000) continue;
        const st = getComputedStyle(el);
        if (st.visibility === 'hidden' || st.display === 'none') continue;
        const raw = norm(getDirectText(el) || el.innerText || el.textContent || '');
        if (!raw || raw.length > 80 || raw.split('\\n').length > 2) continue;
        if (isNoiseCell(raw)) continue;
        pushInfo(raw, r);
      }

      if (infos.length < 6) {
        return { error: 'on-page grid cells not found', title_found: !!titleEl, cell_count: infos.length };
      }
      infos.sort((a, b) => a.top - b.top || a.cx - b.cx);
      const rowClusters = [];
      for (const c of infos) {
        let row = rowClusters.find(x => Math.abs(x.top - c.top) <= 12);
        if (!row) { row = { top: c.top, cells: [] }; rowClusters.push(row); }
        row.cells.push(c);
        row.top = (row.top * (row.cells.length - 1) + c.top) / row.cells.length;
      }
      rowClusters.sort((a, b) => a.top - b.top);
      const xs = infos.map(c => c.cx).sort((a, b) => a - b);
      const cols = [];
      for (const x of xs) {
        let col = cols.find(c => Math.abs(c.mean - x) <= 22);
        if (!col) { col = { mean: x, n: 0 }; cols.push(col); }
        col.n++;
        col.mean = (col.mean * (col.n - 1) + x) / col.n;
      }
      cols.sort((a, b) => a.mean - b.mean);
      const colIndex = (cx) => {
        let best = 0, bestD = Infinity;
        for (let i = 0; i < cols.length; i++) {
          const d = Math.abs(cols[i].mean - cx);
          if (d < bestD) { bestD = d; best = i; }
        }
        return best;
      };
      const matrix = rowClusters.map(row => {
        const line = [];
        for (let i = 0; i < cols.length; i++) line.push('');
        for (const cell of row.cells) {
          const i = colIndex(cell.cx);
          if (!line[i]) line[i] = cell.raw;
        }
        return line;
      });
      let headerIdx = matrix.findIndex(line => {
        const clean = line.filter(t => t && !isNoiseCell(t) && !/\\d/.test(t.replace(/,/g, '')));
        return clean.filter(t => headerNameRe.test(t)).length >= 2;
      });
      if (headerIdx < 0) headerIdx = matrix.findIndex(line => line.filter(t => headerNameRe.test(t) && !isNoiseCell(t)).length >= 2);
      if (headerIdx < 0) headerIdx = 0;
      const headers = matrix[headerIdx].map((h, i) => h || (i === 0 ? 'Area' : ('col_' + i)));
      if (!headers[0]) headers[0] = 'Area';
      const data = [];
      for (let i = 0; i < matrix.length; i++) {
        if (i === headerIdx) continue;
        const line = matrix[i];
        if (!line.some(Boolean)) continue;
        if (/performance\\s*kpis/i.test(String(line[0] || ''))) continue;
        const row = {};
        for (let j = 0; j < headers.length; j++) row[headers[j]] = line[j] || '';
        data.push(row);
      }
      if (!data.length) return { error: 'on-page grid had no data rows', headers, cell_count: infos.length };
      const out = { data, headers, via: 'on-page-clustered', title_found: !!titleEl, cell_count: infos.length };
      const junkHeaders = headers.filter(h => /line\\s*copy/i.test(h) || (/\\d/.test(h) && /nbrx|nrx|trx|writers/i.test(h)));
      if (junkHeaders.length >= 2) return { error: 'on-page scrape looks like KPI/chart chrome', headers, junk: junkHeaders };
      return out;
    };

    const scrollXtab = (titleText, dir) => {
      const hints = (Array.isArray(titleText) ? titleText : [titleText]).map(s => String(s || '').trim().toLowerCase()).filter(Boolean);
      const getDirectText = el => {
        let t = '';
        for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) t += n.textContent;
        return t.trim();
      };
      const vh = window.innerHeight || 900;
      const isNavChrome = el => {
        if (!el || !el.closest) return false;
        if (el.closest('[role="tab"], [role="tablist"], [role="navigation"]')) return true;
        const r = el.getBoundingClientRect();
        return r.top > vh * 0.82 && r.height < 52 && r.width < 320;
      };
      let tr = null, titleScore = -Infinity;
      for (const title of hints) {
        for (const el of Array.from(document.querySelectorAll('*'))) {
          if (isNavChrome(el)) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 8 || r.height < 8 || r.top > vh * 0.88) continue;
          const d = (getDirectText(el) || '').toLowerCase();
          const exact = d === title;
          if (!exact && !(d.includes(title) && d.length <= title.length + 28)) continue;
          const area = r.width * r.height;
          if (area > 160000) continue;
          const score = (exact ? 5000 : 0) + title.length * 20 - Math.sqrt(area) - r.top * 0.05;
          if (score > titleScore) { titleScore = score; tr = r; }
        }
      }
      const preferred = Array.from(document.querySelectorAll(
        '.ag-body-horizontal-scroll-viewport, .ag-center-cols-viewport, .ag-body-viewport, .mstrmojo-scrollNode, .mstrmojo-Xtab-scrollbox, [class*="hScroll" i], [class*="horizontal-scroll" i]'
      ));
      const extra = Array.from(document.querySelectorAll(
        '[class*="Xtab" i], [class*="xtab" i], [role="grid"], table, [class*="Grid" i], [class*="scroll" i], div'
      ));
      const seen = new Set();
      const candidates = [];
      for (const el of preferred.concat(extra)) {
        if (!el || seen.has(el)) continue;
        seen.add(el);
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 4) continue;
        if (tr && r.bottom < tr.top) continue;
        const overflow = el.scrollWidth - el.clientWidth;
        if (overflow > 4) candidates.push({ el, overflow, thin: r.height < 36 ? 0 : 1 });
      }
      candidates.sort((a, b) => a.thin - b.thin || b.overflow - a.overflow);
      if (!candidates.length) return { scrolled: false };
      let moved = false, left = 0, max = 0;
      for (const c of candidates.slice(0, 6)) {
        const el = c.el;
        const before = el.scrollLeft;
        if (dir === 'start') el.scrollLeft = 0;
        else if (dir === 'end') el.scrollLeft = el.scrollWidth;
        else el.scrollLeft = Math.min(el.scrollWidth, el.scrollLeft + Math.max(220, Math.floor(Math.max(el.clientWidth, 200) * 0.75)));
        el.dispatchEvent(new Event('scroll', { bubbles: true }));
        if (el.scrollLeft !== before) moved = true;
        left = el.scrollLeft;
        max = el.scrollWidth - el.clientWidth;
      }
      return { scrolled: moved || dir === 'start', left, max };
    };

    const mergeParts = (parts) => {
      const ok = (parts || []).filter(p => p && !p.error && Array.isArray(p.data) && p.data.length);
      if (!ok.length) return parts && parts[0] ? parts[0] : { error: 'no grid parts' };
      const rowKey = rec => {
        const keys = Object.keys(rec || {});
        const attr = keys.find(k => /area|employee|territory|name/i.test(k)) || keys[0];
        return rec && attr ? String(rec[attr]) : '';
      };
      const headerOrder = [];
      for (const p of ok) {
        for (const h of (p.headers || Object.keys(p.data[0] || {}))) {
          if (!h || /line\\s*copy/i.test(h) || (/\\d/.test(h) && /nbrx|nrx|trx|writers/i.test(h))) continue;
          if (headerOrder.indexOf(h) < 0) headerOrder.push(h);
        }
      }
      const byRow = {};
      const order = [];
      for (const p of ok) {
        for (const rec of p.data) {
          const k = rowKey(rec);
          if (/performance\\s*kpis/i.test(k)) continue;
          if (!byRow[k]) { byRow[k] = {}; order.push(k); }
          Object.assign(byRow[k], rec);
        }
      }
      const data = order.map(k => {
        const rec = byRow[k] || {};
        const out = {};
        headerOrder.forEach(h => { out[h] = rec[h] != null ? rec[h] : ''; });
        return out;
      });
      const merged = { data, headers: headerOrder, via: 'on-page-scrolled-merge', parts: ok.length };
      if (!headerOrder.length || !data.length) return { error: 'merged grid empty after noise filter' };
      return merged;
    };

    const headerKey = h => String(h || '').toLowerCase().replace(/[^a-z0-9%]+/g, '');
    const hasExpected = (part) => {
      if (!expectedCols || !expectedCols.length || !part || !part.headers) return false;
      const got = new Set((part.headers || []).map(headerKey).filter(Boolean));
      const want = expectedCols.map(headerKey).filter(k => k && !/^(area|employeename|col\\d+)$/.test(k));
      if (!want.length) return false;
      const hits = want.filter(k => [...got].some(g => g === k || g.includes(k) || k.includes(g)));
      return hits.length >= Math.min(want.length, Math.max(10, want.length - 1));
    };

    const scrapeWithScroll = async (frame, titles) => {
      const parts = [];
      try { await frame.evaluate(scrollXtab, titles, 'start'); } catch (_) {}
      await sleep(280);
      parts.push(await frame.evaluate(scrapeFn, { titles }).catch(() => ({ error: 'scrape failed' })));
      for (let i = 0; i < 14; i++) {
        if (hasExpected(mergeParts(parts))) break;
        let info = { scrolled: false };
        try { info = await frame.evaluate(scrollXtab, titles, 'next'); } catch (_) {}
        if (!info || !info.scrolled) break;
        await sleep(240);
        parts.push(await frame.evaluate(scrapeFn, { titles }).catch(() => ({ error: 'scrape failed' })));
        if (info.max != null && info.left >= info.max - 8) break;
      }
      try { await frame.evaluate(scrollXtab, titles, 'end'); } catch (_) {}
      await sleep(240);
      parts.push(await frame.evaluate(scrapeFn, { titles }).catch(() => ({ error: 'scrape failed' })));
      try { await frame.evaluate(scrollXtab, titles, 'start'); } catch (_) {}
      return mergeParts(parts);
    };

    let last = { error: 'not found in any accessible frame' };
    for (const frame of page.frames()) {
      const got = await scrapeWithScroll(frame, titleHints);
      if (got && !got.error && Array.isArray(got.data) && got.data.length) return got;
      if (got) last = got;
    }
    return last;
  };

  const finishTable = (row, rawTable, filters) => {
    row.tableData = toGrid(rawTable);
    if (row.tableData && !row.tableData.error) {
      row.grid = {
        columns: row.tableData.columns,
        rows: row.tableData.rows,
      };
      row[KPI_LABEL] = row.grid;
      row.extract_via = rawTable && rawTable.via ? rawTable.via : 'on-page-grid';
    } else {
      row.grid = null;
      row.extract_via = 'failed';
      row.extract_error = (row.tableData && row.tableData.error) || (rawTable && rawTable.error) || 'no table';
    }
    return row;
  };

  const navDebug = [];
  const runNav = async () => {
    for (const step of NAV_STEPS) {
      const r = await clickByText(step, { openers: NAV_OPENERS });
      navDebug.push({ step, ...r });
    }
    if (TIME_GRAIN) {
      await sleep(400);
      const g = await clickByText(TIME_GRAIN, { openers: NAV_OPENERS });
      navDebug.push({ step: TIME_GRAIN, ...g });
    }
  };

  await waitForDossierReady();
  await runNav();
  await waitForDashboard();

  const filterCombinations = (typeof __filterCombinations !== 'undefined' && Array.isArray(__filterCombinations) && __filterCombinations.length > 0)
    ? __filterCombinations : [];

  // "View By" is not a standard DocSelector — it is a custom MSTR widget
  // (radio group / segmented control). DOM .click() is ignored by MSTR's
  // framework, so we locate the option element and use page.mouse.click()
  // at its coordinates to produce a real browser mouse event.
  const applyViewBy = async (labelText, optionText) => {
    await closeAnyOpenDropdown();
    const target = await page.evaluate((label, opt) => {
      const norm = s => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const wantLabel = norm(label);
      const wantOpt = norm(opt);
      const isVisible = el => {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return false;
        const st = getComputedStyle(el);
        return st.visibility !== 'hidden' && st.display !== 'none';
      };
      const getDirectText = el => {
        let t = '';
        for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) t += n.textContent;
        return t.trim();
      };
      // 1. Find the "View By" label
      let labelEl = null, labelArea = Infinity;
      for (const el of Array.from(document.querySelectorAll('*'))) {
        if (!isVisible(el)) continue;
        if (norm(getDirectText(el)) !== wantLabel) continue;
        const r = el.getBoundingClientRect();
        const area = r.width * r.height;
        if (area < labelArea) { labelEl = el; labelArea = area; }
      }
      if (!labelEl) return { error: 'View By label not found' };
      const lr = labelEl.getBoundingClientRect();
      // 2. Find the option near the label — search within a generous region
      //    (same row or row below, up to 400px right)
      const candidates = [];
      for (const el of Array.from(document.querySelectorAll('span, div, a, li, button, [role="option"], [role="radio"], [role="tab"], [role="button"], label, input'))) {
        if (!isVisible(el)) continue;
        const d = norm(getDirectText(el));
        const full = norm(el.innerText || el.textContent || '');
        if (d !== wantOpt && full !== wantOpt) continue;
        const r = el.getBoundingClientRect();
        // Must be near the label: within 80px vertically, to the right or slightly left
        if (Math.abs(r.top - lr.top) > 80) continue;
        if (r.left < lr.left - 40) continue;
        const dist = Math.abs(r.top - lr.top) + Math.abs(r.left - lr.right);
        const area = r.width * r.height;
        candidates.push({ x: r.left + r.width / 2, y: r.top + r.height / 2, dist, area, text: d || full, tag: el.tagName });
      }
      if (!candidates.length) {
        // Fallback: also check inside DocSelector / popup containers near the label
        const containers = Array.from(document.querySelectorAll('.mstrmojo-DocSelector, [class*="DocSelector"], [class*="Selector"], [role="listbox"], [role="radiogroup"]'));
        for (const cont of containers) {
          if (!isVisible(cont)) continue;
          const cr = cont.getBoundingClientRect();
          if (Math.abs(cr.top - lr.top) > 80) continue;
          for (const el of Array.from(cont.querySelectorAll('*'))) {
            if (!isVisible(el)) continue;
            const d = norm(getDirectText(el));
            if (d !== wantOpt) continue;
            const r = el.getBoundingClientRect();
            candidates.push({ x: r.left + r.width / 2, y: r.top + r.height / 2, dist: 0, area: r.width * r.height, text: d, tag: el.tagName });
          }
        }
      }
      if (!candidates.length) return { error: 'View By option not found near label: ' + opt };
      // Prefer smallest element closest to the label
      candidates.sort((a, b) => a.dist - b.dist || a.area - b.area);
      return { x: candidates[0].x, y: candidates[0].y, text: candidates[0].text, tag: candidates[0].tag };
    }, labelText, optionText);
    if (target.error) {
      // Fallback: try selectByLabel as last resort
      const fallback = await selectByLabel(labelText, optionText);
      return { ...fallback, via: 'view-by-fallback-selectByLabel' };
    }
    // 3. Use real mouse events at the element coordinates
    await page.mouse.click(target.x, target.y);
    await sleep(500);
    // Some MSTR controls need a second click or respond to mousedown specifically
    await page.mouse.click(target.x, target.y);
    await dismissGenericErrorDialog();
    await closeAnyOpenDropdown();
    await waitForLoadingToFinish(15000);
    return { ok: true, via: 'view-by-mouse-click', x: target.x, y: target.y, text: target.text, tag: target.tag };
  };

  const scrapeOnce = async (filters) => {
    const debug = {};
    const GEO_ORDER = ['Area', 'Region', 'Territory', 'Time Bucket'];
    const VIEW_BY_KEY = 'View By';
    const allKeys = Object.keys(filters || {});
    const geoKeys = GEO_ORDER.filter(k => allKeys.includes(k));
    const otherKeys = allKeys.filter(k => !GEO_ORDER.includes(k) && k !== VIEW_BY_KEY);
    // Apply geo filters and other filters first — each triggers a page
    // reload inside MSTR that can reset View By back to its default.
    for (const key of geoKeys) {
      debug[key] = await selectByLabel(key, filters[key]);
      await dismissGenericErrorDialog();
      await closeAnyOpenDropdown();
    }
    for (const key of otherKeys) {
      debug[key] = await selectByLabel(key, filters[key]);
      await dismissGenericErrorDialog();
      await closeAnyOpenDropdown();
    }
    await waitForLoadingToFinish(15000);
    // Apply "View By" LAST — after all other filters have settled.
    // MSTR resets View By when geo filters trigger page reloads, so it
    // must be the final filter change before scraping.
    if (allKeys.includes(VIEW_BY_KEY)) {
      debug[VIEW_BY_KEY] = await applyViewBy(VIEW_BY_KEY, filters[VIEW_BY_KEY]);
      await waitForLoadingToFinish(15000);
    }
    await waitForDashboard();
    const row = { filters_applied: debug };
    // Primary: widget Menu → Show Data (clean multi-col table). Fallback: on-page scrape.
    // Try viz title ("Performance Trend Grid") before the shorter tab label.
    const titles = gridTitleHints();
    let extracted = { error: 'no extract' };
    for (const hint of titles) {
      extracted = await extractViaShowData(hint);
      if (extracted && !extracted.error) {
        const preview = toGrid(extracted);
        if (preview && preview.error) {
          extracted = { error: preview.error, via: extracted.via, headers: extracted.headers || preview.headers };
        } else {
          break;
        }
      }
    }
    row.show_data = extracted && extracted.error
      ? { ok: false, error: extracted.error, open: extracted.open || null, headers: extracted.headers || null }
      : { ok: true, via: extracted && extracted.via };
    if (extracted && extracted.error) {
      extracted = await extractOnPageGrid(titles, EXPECTED_COLUMNS);
    }
    finishTable(row, extracted, filters);
    return row;
  };

  if (filterCombinations.length === 0) {
    const row = await scrapeOnce({});
    return { navigation: navDebug, ...row };
  }

  const results = {};
  for (let i = 0; i < filterCombinations.length; i++) {
    const { label = String(i), filters = {} } = filterCombinations[i];
    if (i > 0) {
      await page.goto(reportUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await waitForDossierReady();
      await runNav();
      await waitForDashboard();
    }
    results[label] = await scrapeOnce(filters);
  }
  return { navigation: navDebug, results };
};
`;
}

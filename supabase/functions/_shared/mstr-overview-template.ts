/** Deterministic KPI Playwright script (Overview, Activity, or any numeric tiles). Only URL, KPI labels, and NAV_STEPS vary. */

import { parseNavStepsFromScenario, scenarioTextBlob } from "./mstr-nav-parse.ts";
import { FILTER_CORE_JS } from "./mstr-filter-core.ts";

export const DEFAULT_OVERVIEW_KPIS = [
  "NBRx Total",
  "TRx Total",
  "BlinkRx TRx",
  "BlinkRx NBRx",
  "New Writers",
  "Total Writers",
  "Target Writers (%)",
  "Paid Insured Rate",
  "Total HCP Calls",
  "Reach %",
  "My Plan Reach (%)",
  "Calls to Target (%)",
  "Frequency",
  "BAP to PICR %",
  "Calls/Day (HCP)",
  "PA/ME Submission Rate",
  "PA/ME Initiated Volume",
  "Approval Rate",
  "Samples Dropped",
];

export function normalizeReportUrl(raw: string): string {
  const url = String(raw || "").trim();
  if (!url) return "";
  try {
    const u = new URL(url);
    u.searchParams.delete("continue");
    let out = u.toString();
    if (out.endsWith("?") || out.endsWith("&")) out = out.slice(0, -1);
    return out;
  } catch {
    return url.replace(/[?&]continue(?:=[^&]*)?/i, "").replace(/[?&]$/, "");
  }
}

function looksLikeDateKpiNoise(raw: string): boolean {
  const s = String(raw || "").trim();
  if (!s) return false;
  const t = s.toLowerCase();
  if (/\brefresh\s*date\b/.test(t)) return true;
  if (/^(claims me|call activity we)$/i.test(s)) return true;
  if (/\b(as\s*of|data\s*as\s*of)\b/.test(t)) return true;
  if (/^sales\s*\(/i.test(s) && /\b(nbrx|nrx|trx)\b/i.test(s)) return true;
  return false;
}

function looksLikeUserKpiLabel(raw: string): boolean {
  const s = String(raw || "").trim();
  if (!s || s.length > 80) return false;
  if (looksLikeDateKpiNoise(s)) return false;
  if (/^(overview|activity|performance|geography|filters?|navigation|summary)$/i.test(s)) return false;
  if (/\b(screen|tab|page|report|dashboard|graph|chart|grid|toggle)\b/i.test(s)) return false;
  return /\b(nbrx|nrx|trx|writers|reach|frequency|blink|calls|rate|volume|approval|target|hcp|bap|paid insured|kpi|samples?|dropped)\b/i.test(s);
}

export function looksLikeOverviewKpis(scenario: any, existingScript?: any): boolean {
  const labels = parseKpiLabels(scenario, existingScript, false);
  if (!labels.length) return false;
  const blob = labels.join(" ").toLowerCase();
  return /\b(nbrx|nrx|trx|writers|reach|frequency|blink|calls to target|my plan)\b/i.test(blob);
}

/**
 * Leftover numeric KPI tiles (Overview, Activity, or any KPI page).
 * Grid / chart / date use dedicated templates — never steal those.
 */
export function isKpiScenario(
  scenario: any,
  existingScript?: any,
  _isReferenceTarget = false,
): boolean {
  if (String(scenario?.type || "").toLowerCase() === "trend") return false;
  const blob = scenarioTextBlob(scenario).toLowerCase();

  // Refresh / as-of dates use date_refresh — never extractKPI.
  if (/\brefresh\s*dates?\b/.test(blob) || /\b(claims\s*me|call activity we)\b/.test(blob)) return false;
  if (/\b(as[\s-]?of\s*date|date\s*validat|date\s*labels?|data\s*as\s*of)\b/.test(blob)) return false;

  // Graphs / grids use Show Data — never KPI tile extract.
  if (/\bactivity\s*trend\b/.test(blob)) return false;
  if (/\b(show\s*data|chart\s*data|geography details|grid data|crosstab|graph|chart|plot)\b/.test(blob)) {
    return false;
  }
  if (/\bgrid\b/.test(blob) && !/\b(overview|kpi|tile|pass\s*value)/.test(blob)) return false;
  if (/\bperformance\s*trend\b/.test(blob) && !/\bkpi\b/.test(blob)) return false;

  const configured = parseKpiLabels(scenario, existingScript, false);
  if (configured.length) return true;

  if (/\boverview\b/.test(blob)) return true;
  if (/\b(kpi|pass\s*values?|kpi\s*tiles?|numeric\s*tiles?)\b/.test(blob)) return true;
  if (/\bactivity\b/.test(blob) && (looksLikeOverviewKpis(scenario, existingScript) || /\bkpi\b/.test(blob))) {
    return true;
  }
  return looksLikeOverviewKpis(scenario, existingScript);
}

/** @deprecated Use isKpiScenario — Overview and Activity share the KPI template. */
export function isOverviewScenario(
  scenario: any,
  existingScript?: any,
  isReferenceTarget = false,
): boolean {
  return isKpiScenario(scenario, existingScript, isReferenceTarget);
}

/** @deprecated Use isKpiScenario — Overview and Activity share the KPI template. */
export function isActivityKpiScenario(scenario: any, existingScript?: any): boolean {
  return isKpiScenario(scenario, existingScript);
}

export const isActivityScenario = isActivityKpiScenario;

/** Footer / left-nav steps only — never Weekly/Monthly/Quarterly (chart radios). */
export function parseKpiNavSteps(scenario: any, fallback: string[] = []): string[] {
  // Overview is the dossier landing page — do not click it as a tab.
  // Only real footer tabs. Comparison titles ("Overview vs Performance…", "Main Report") are not tabs.
  const steps = parseNavStepsFromScenario(scenario, { allowGeography: false })
    .map((s) => {
      // Strip only the narrative wrapper ("after navigating to X", "before X") and keep
      // the FULL tab label. Collapsing to a single keyword loses real multi-word sub-tabs
      // such as "Activity Performance" / "Performance Trend".
      let out = String(s || "").trim();
      out = out.replace(/^(?:after|before|then|and)\s+/i, "");
      out = out.replace(/^navigat(?:e|ing)\s+to\s+(?:the\s+)?/i, "");
      out = out.replace(/^(?:go|switch)\s+to\s+(?:the\s+)?/i, "");
      out = out.replace(/\s+(?:sub[-\s]?tab|tab|screen|page|dashboard)$/i, "");
      return out.trim();
    })
    .filter((s) => {
      if (!s) return false;
      if (/^load\b/i.test(s)) return false;
      if (/^(overview|summary|main)$/i.test(s)) return false;
      if (/^vs\b|\bafter\b|\bbefore\b|\bnavigat/i.test(s)) return false;
      if (/\boverview\b/i.test(s) && !/\b(activity|performance|geography|hcp)\b/i.test(s)) return false;
      // Accept a real tab label of 1-4 words that names a known screen family.
      // Exact-matching only 'activity|performance|geography' silently dropped every
      // multi-word sub-tab, so the script clicked the parent screen and scraped its
      // DEFAULT sub-tab (e.g. Sales Performance) instead of the one asked for.
      if (!/\b(activity|performance|geography|call)\b/i.test(s)) return false;
      return s.split(/\s+/).length <= 4;
    });

  // Parent screen before sub-tab: "Performance" then "Activity Performance".
  // Without the parent click the sub-tab is not in the DOM yet.
  const withParents: string[] = [];
  for (const s of steps) {
    const parent = String(s).match(/\b(performance|activity|geography)\b\s*$/i)?.[1];
    if (
      parent &&
      s.split(/\s+/).length > 1 &&
      !steps.some((o) => o.toLowerCase() === parent.toLowerCase()) &&
      !withParents.some((o) => o.toLowerCase() === parent.toLowerCase())
    ) {
      withParents.push(parent.charAt(0).toUpperCase() + parent.slice(1).toLowerCase());
    }
    if (!withParents.some((o) => o.toLowerCase() === s.toLowerCase())) withParents.push(s);
  }

  if (withParents.length) {
    return withParents;
  }
  return [...fallback];
}


function labelsFromScenarioText(scenario: any): string[] {
  const title = String(scenario?.title || "");
  const desc = String(scenario?.description || "");
  const blob = `${title}\n${desc}`;
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const s = String(raw || "").trim();
    if (!s || seen.has(s.toLowerCase()) || looksLikeDateKpiNoise(s)) return;
    seen.add(s.toLowerCase());
    out.push(s);
  };
  // 1. Exact match against default KPI labels
  for (const def of DEFAULT_OVERVIEW_KPIS) {
    const re = new RegExp(def.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    if (re.test(blob)) add(def);
  }
  // 2. Quoted strings — curly quotes AND straight quotes
  for (const m of blob.matchAll(/[““”’‘’]([^”“”’‘’]{2,80})[““”’‘’]/g)) {
    if (looksLikeUserKpiLabel(m[1])) add(m[1].trim());
  }
  // 3. Per-line scan (bullet lists, plain lines)
  for (const line of desc.split(/\r?\n/)) {
    const t = line.replace(/^[-*•\d.)\s]+/, "").trim().replace(/^["']|["']$/g, "");
    if (t && looksLikeUserKpiLabel(t)) add(t);
    // 3b. Comma-separated KPI labels within a line
    if (/,/.test(t)) {
      for (const seg of t.split(/,/)) {
        const s = seg.trim().replace(/^["']|["']$/g, "");
        if (s && s.length <= 50 && looksLikeUserKpiLabel(s)) add(s);
      }
    }
  }
  // 4. Extract KPI-like noun phrases from within sentences.
  //    Matches patterns like "capture the displayed Blink TRx value" → "Blink TRx"
  if (!out.length) {
    const verbRe = /(?:capture|extract|check|scrape|fetch|read|compare|verify|validate|match|displayed|showing|shows?)\s+(?:the\s+)?(?:displayed\s+|corresponding\s+|current\s+|expected\s+)?([A-Z][A-Za-z\s/()%]{1,50}?)\s+(?:values?|figures?|numbers?|metrics?|kpis?|tiles?|data\b)/gi;
    for (const m of blob.matchAll(verbRe)) {
      const candidate = m[1].trim();
      if (candidate && looksLikeUserKpiLabel(candidate)) add(candidate);
    }
  }
  // 5. Sliding window: scan for 1–4 word phrases containing KPI keywords
  if (!out.length) {
    const words = blob.split(/\s+/).map((w) => w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9%()]+$/g, "")).filter(Boolean);
    for (let len = 4; len >= 1; len--) {
      for (let i = 0; i <= words.length - len; i++) {
        const phrase = words.slice(i, i + len).join(" ");
        if (phrase.length > 50) continue;
        if (looksLikeUserKpiLabel(phrase)) add(phrase);
      }
    }
  }
  return out;
}

/** User-configured KPI labels only. Never inject the 18 default Overview KPIs unless useDefault=true. */
export function parseKpiLabels(scenario: any, existingScript?: any, useDefault = false): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: any) => {
    const s = typeof raw === "string"
      ? raw.trim()
      : String(raw?.label || raw?.name || raw?.kpi || "").trim();
    if (!s || seen.has(s.toLowerCase()) || looksLikeDateKpiNoise(s)) return;
    seen.add(s.toLowerCase());
    out.push(s);
  };
  const spec = existingScript?.assertion_spec;
  if (Array.isArray(spec?.kpis)) spec.kpis.forEach(add);
  else if (spec?.kpis && typeof spec.kpis === "object") Object.keys(spec.kpis).forEach(add);
  if (spec?.kpi_tolerances && typeof spec.kpi_tolerances === "object") {
    Object.keys(spec.kpi_tolerances).forEach(add);
  }
  const cfg = scenario?.reports?.kpi_config;
  if (Array.isArray(cfg)) cfg.forEach(add);
  else if (cfg && typeof cfg === "object") {
    if (Array.isArray(cfg.kpis)) cfg.kpis.forEach(add);
    else if (Array.isArray(cfg.labels)) cfg.labels.forEach(add);
    else Object.keys(cfg).forEach(add);
  }
  if (out.length) return out;
  const fromText = labelsFromScenarioText(scenario);
  if (fromText.length) return fromText;
  return useDefault ? [...DEFAULT_OVERVIEW_KPIS] : [];
}

export function assembleKpiScript(opts: {
  reportUrl: string;
  kpiLabels: string[];
  /** Optional tab navigation before KPI scrape (e.g. Activity). Empty = stay on landing page. */
  navSteps?: string[];
}): string {
  const reportUrl = normalizeReportUrl(opts.reportUrl);
  const labels = (opts.kpiLabels || []).filter((k) => typeof k === "string" && k.trim());
  const navSteps = (opts.navSteps || []).filter((s) => typeof s === "string" && s.trim() && !/^(weekly|monthly|quarterly)$/i.test(s));
  const urlLit = JSON.stringify(reportUrl);
  const kpiLit = JSON.stringify(labels, null, 4).replace(/\n/g, "\n    ");
  const navLit = JSON.stringify(navSteps);
  const emptyLabelsNote = labels.length
    ? ""
    : "\n  // KPI_LABELS empty — set labels via Add/Remove KPIs or assertion_spec. Generate validation should fail until then.\n";

  return `/**
 * RTB skill template: KPI tiles (extractKPI).
 * Filled from UI: report URL, KPI_LABELS (user-configured only), optional NAV_STEPS.
 * Filters come from runtime __filterCombinations (never hardcode Area/Region values).
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

  const tryWidenViewport = async () => {
    try { if (typeof page.setViewport === 'function') await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 }); } catch (_) {}
    try { if (typeof page.setViewportSize === 'function') await page.setViewportSize({ width: 1920, height: 1080 }); } catch (_) {}
    try {
      await page.evaluate(() => {
        document.documentElement.style.zoom = '100%';
        if (document.body) document.body.style.zoom = '100%';
      });
    } catch (_) {}
  };
  await tryWidenViewport();

  const reportUrl = ${urlLit};

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

  // Ready BEFORE tab nav: filter chrome / footer tabs. Never wait for KPI tiles here —
  // those only exist on the target screen (Overview/Activity), not login or Performance.
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

  // Ready AFTER tab nav: a KPI label on THIS screen (not hardcoded Overview "NBRx Total").
  // One call after nav and one before scrape — never after every filter pick.
  const waitForDashboard = async (maxMs = 15000) => {
    await waitForLoadingToFinish(Math.min(maxMs, 15000));
    const markers = (typeof KPI_LABELS !== 'undefined' && Array.isArray(KPI_LABELS)) ? KPI_LABELS : [];
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const found = await page.evaluate((labels) => {
        function getDirectText(el) {
          let text = '';
          for (const node of el.childNodes)
            if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
          return text.trim();
        }
        const norm = s => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
        const want = (labels || []).map(s => norm(s)).filter(Boolean);
        if (!want.length) return !!document.querySelector('.mstrmojo-DocSelector, [class*="DocSelector"], [class*="FilterPanel" i]');
        for (const el of Array.from(document.querySelectorAll('*'))) {
          const t = norm(getDirectText(el));
          if (t && want.includes(t)) return true;
        }
        return false;
      }, markers).catch(() => false);
      if (found) break;
      await sleep(500);
    }
    await waitForLoadingToFinish(5000);
  };

  const closeAnyOpenDropdown = async () => {
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Escape', code: 'Escape', bubbles: true }));
      const x = 5, y = Math.max(5, window.innerHeight - 5);
      const opts = { bubbles: true, clientX: x, clientY: y };
      document.body.dispatchEvent(new MouseEvent('mousedown', opts));
      document.body.dispatchEvent(new MouseEvent('mouseup',   opts));
      document.body.dispatchEvent(new MouseEvent('click',     opts));
    }).catch(() => {});
    await sleep(300);
  };

${FILTER_CORE_JS}


  const extractKPI = async (labelText) => {
    return await page.evaluate((label) => {
      function getDirectText(el) {
        let text = '';
        for (const node of el.childNodes)
          if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
        return text.trim();
      }
      function hasElementChildren(el) {
        for (const node of el.childNodes)
          if (node.nodeType === Node.ELEMENT_NODE) return true;
        return false;
      }
      const norm = s => s.replace(/\\s+/g, ' ').trim().toLowerCase();
      const target = norm(label);
      const labelMatches = [];
      for (const el of Array.from(document.querySelectorAll('*'))) {
        const direct = getDirectText(el);
        if (!direct || norm(direct) !== target) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        labelMatches.push({ el, r, area: r.width * r.height });
      }
      if (!labelMatches.length) return { error: 'Label not found: ' + label };
      labelMatches.sort((a, b) => a.area - b.area);
      const numRe = /^\\s*[$]?\\s*-?[\\d,]+(\\.\\d+)?\\s*%?\\s*$/;
      for (const { r: lr } of labelMatches) {
        const labelCx = lr.left + lr.width / 2;
        const maxDx = Math.max(80, lr.width / 2 + 40);
        const candidates = [];
        for (const el of Array.from(document.querySelectorAll('*'))) {
          if (hasElementChildren(el)) continue;
          const direct = getDirectText(el);
          if (!numRe.test(direct)) continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (r.top < lr.top + lr.height - 2) continue;
          if (r.top > lr.top + 120) continue;
          const cx = r.left + r.width / 2;
          if (Math.abs(cx - labelCx) > maxDx) continue;
          const fs = parseFloat(getComputedStyle(el).fontSize) || 0;
          candidates.push({ text: direct.trim(), fs, dx: Math.abs(cx - labelCx), dy: r.top - lr.top });
        }
        if (!candidates.length) continue;
        candidates.sort((a, b) => (b.fs - a.fs) || (a.dx - b.dx) || (a.dy - b.dy));
        return { value: candidates[0].text };
      }
      return { error: 'No value found near label: ' + label };
    }, labelText).catch(() => ({ error: 'evaluate failed' }));
  };

  const NAV_STEPS = ${navLit};
  const NAV_OPENERS = ['Menu', 'Navigation', 'More', 'Open menu', 'Main menu', '☰'];
  const navDebug = [];

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
      const nodes = Array.from(document.querySelectorAll('button, a, [role="tab"], [role="button"], span, div, li'));
      let best = null, bestArea = Infinity;
      let bestExact = null, bestExactArea = Infinity;
      for (const el of nodes) {
        if (!isVisible(el)) continue;
        const t = norm(el.innerText || el.textContent || '');
        // EXACT label wins over a substring hit. Without this, clicking "Performance"
        // could land on "Sales Performance" / "Activity Performance" (smaller area),
        // and a sub-tab request could land on its parent.
        const isExact = (t === want);
        const isPartial = (t.length <= want.length + 16 && t.includes(want));
        if (!isExact && !isPartial) continue;
        const r = el.getBoundingClientRect();
        const area = r.width * r.height;
        if (area >= 80000) continue;
        if (isExact) {
          if (area < bestExactArea) { bestExact = el; bestExactArea = area; }
        } else if (area < bestArea) { best = el; bestArea = area; }
      }
      best = bestExact || best;
      if (!best) return { error: 'not found: ' + label };
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
            if (t === want || t === '\\u2630') { el.click(); return true; }
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

  const runNav = async () => {
    for (const step of NAV_STEPS) {
      const r = await clickByText(step, { openers: NAV_OPENERS });
      navDebug.push({ step, ...r });
      if (r && r.error) break;
    }
  };

  const KPI_LABELS = ${kpiLit};${emptyLabelsNote}
  const toNum = v => (v == null ? null : parseFloat(String(v).replace(/[^0-9.\\-]/g, '')));

  const filterCombinations = (typeof __filterCombinations !== 'undefined' && Array.isArray(__filterCombinations) && __filterCombinations.length > 0)
    ? __filterCombinations : [];

  await waitForDossierReady();
  await runNav();
  await waitForDashboard();

  if (filterCombinations.length === 0) {
    const out = { navigation: navDebug };
    for (const k of KPI_LABELS) {
      const raw = await extractKPI(k);
      out[k] = toNum(raw && raw.value);
    }
    return out;
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

    const debug = {};
    const GEO_ORDER = ['Area', 'Region', 'Territory'];
    const allKeys = Object.keys(filters);
    const geoKeys = GEO_ORDER.filter(k => allKeys.includes(k));
    const otherKeys = allKeys.filter(k => !GEO_ORDER.includes(k));
    for (const key of geoKeys) {
      debug[key] = await selectByLabel(key, filters[key]);
    }
    for (const key of otherKeys) {
      debug[key] = await selectByLabel(key, filters[key]);
    }
    await closeAnyOpenDropdown();
    await waitForLoadingToFinish(15000);
    await waitForDashboard();

    const row = { filters_applied: debug };
    for (const k of KPI_LABELS) {
      const raw = await extractKPI(k);
      row[k] = toNum(raw && raw.value);
    }
    results[label] = row;
  }
  return { navigation: navDebug, results };
};
`;
}

/** @deprecated Use assembleKpiScript — same KPI template. */
export const assembleOverviewScript = assembleKpiScript;

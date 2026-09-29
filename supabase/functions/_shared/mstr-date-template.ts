/**
 * Deterministic refresh / as-of date Playwright script.
 * Same login / wait / selectByLabel cadence as overview/grid.
 * Only URL, DATE_LABELS, and optional NAV_STEPS vary.
 *
 * Viewport: 1920x1080 / 100% zoom like other current templates.
 * The original working date script used 1440x900; 1920 keeps the
 * upper-right date strip visible at 100% zoom.
 */

import { normalizeReportUrl } from "./mstr-overview-template.ts";
import { parseNavStepsFromScenario, scenarioTextBlob } from "./mstr-nav-parse.ts";
import { FILTER_CORE_JS } from "./mstr-filter-core.ts";

export const DEFAULT_DATE_LABELS = [
  "Sales (NBRx)",
  "Sales (NRx & TRx)",
  "Call Activity WE",
  "Claims ME",
  "Refresh Date",
];

const DATE_NOISE = new Set([
  "filters_applied",
  "navigation",
  "ok",
  "error",
  "via",
  "results",
  "extract_via",
]);

export function looksLikeDateLabel(raw: string): boolean {
  const s = String(raw || "").trim();
  if (!s || s.length > 80) return false;
  if (/validations?$/i.test(s)) return false;
  const t = s.toLowerCase();
  if (/^(refresh date|claims me|call activity we)$/i.test(s)) return true;
  if (/^sales\s*\(\s*(nbrx|nrx\s*&\s*trx|nrx|trx)\s*\)$/i.test(s)) return true;
  if (/\brefresh\s*date\b/.test(t)) return true;
  if (/\b(as\s*of|data\s*as\s*of)\b/.test(t)) return true;
  if (/\b(we|me)\b/.test(t) && /\b(claim|call|sales|activity)\b/.test(t)) return true;
  if (/sales\s*\(.*(?:nbrx|nrx|trx)/i.test(s)) return true;
  if (/\bdate\b/.test(t) && !/\b(validat|compare|scenario)\b/.test(t)) return true;
  return false;
}

function looksLikeNumericKpiLabel(raw: string): boolean {
  const s = String(raw || "").trim();
  if (!s) return false;
  if (looksLikeDateLabel(s)) return false;
  return /\b(total|writers|reach\s*%|frequency|rate|volume|approval|calls\/day|target\s*\(|blinkrx|bap to|paid insured|nbrx depth|nbrx breadth)\b/i.test(s);
}

function labelsFromCode(code: string): string[] {
  const m = String(code || "").match(/DATE_LABELS\s*=\s*\[([\s\S]*?)\]/);
  if (!m) return [];
  const out: string[] = [];
  const re = /['"]([^'"]+)['"]/g;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(m[1]))) out.push(hit[1].trim());
  return out.filter(Boolean);
}

/** Refresh / as-of dates — not Geography grid or chart Show Data. */
export function isDateScenario(scenario: any, existingScript?: any): boolean {
  if (String(scenario?.type || "").toLowerCase() === "trend") return false;
  const blob = scenarioTextBlob(scenario).toLowerCase();

  // Do not steal dedicated grid / chart extractors.
  if (/\bgeography details\b/.test(blob) && /\bgrid\b/.test(blob)) return false;
  if (/\bperformance\s*trends?\s*grid\b/.test(blob) || (/\bperformance\s*trend\b/.test(blob) && /\bgrid\b/.test(blob))) {
    return false;
  }
  if (/\b(grid data|crosstab|on-page grid|all grid columns)\b/.test(blob)) return false;
  if (/\b(show\s*data|chart\s*data|graph\s*data|line chart|bar chart|activity\s*trend|segment\s*summary)\b/.test(blob)) {
    return false;
  }
  if (/\b(chart|graph|plot)\b/.test(blob) && !/\b(refresh\s*date|as[\s-]?of)\b/.test(blob)) return false;

  const code = String(
    existingScript?.playwright_code ||
      existingScript?.assertion_spec?.__reference_playwright_code ||
      "",
  );
  if (/extractRefreshDate|DATE_LABELS\s*=/.test(code)) return true;

  if (/\brefresh\s*dates?\b/.test(blob)) return true;
  if (/\b(as[\s-]?of\s*date|date\s*validat|date\s*labels?|data\s*as\s*of)\b/.test(blob)) return true;
  if (/\b(claims\s*me|call activity we|sales\s*\(\s*nbrx\s*\)|sales\s*\(\s*nrx)/.test(blob)) return true;

  const parsed = parseDateLabels(scenario, existingScript, false);
  return parsed.length > 0 && parsed.every(looksLikeDateLabel);
}

export function parseDateNavSteps(scenario: any, fallback: string[] = []): string[] {
  // Overview is the dossier landing page — do not click it as a tab.
  // "Load the Overview Screen" is instructions, not a footer label.
  const steps = parseNavStepsFromScenario(scenario, { allowGeography: false })
    .filter((s) => {
      if (/^load\b/i.test(s)) return false;
      if (/^(overview|summary)$/i.test(s)) return false;
      if (/\boverview\b/i.test(s) && !/\b(activity|performance|geography|hcp)\b/i.test(s)) return false;
      return true;
    });
  if (steps.length) return steps;
  return [...fallback];
}

export function parseDateLabels(scenario: any, existingScript?: any, useDefault = true): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: any) => {
    const s = typeof raw === "string"
      ? raw.trim()
      : String(raw?.label || raw?.name || raw?.kpi || raw?.date || "").trim();
    if (!s || s.length > 80) return;
    if (DATE_NOISE.has(s.toLowerCase().replace(/\s+/g, "_"))) return;
    if (/validations?$/i.test(s)) return;
    if (looksLikeNumericKpiLabel(s)) return;
    const key = s.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };

  const spec = existingScript?.assertion_spec;
  if (Array.isArray(spec?.date_labels)) spec.date_labels.forEach(add);
  if (Array.isArray(spec?.kpis)) spec.kpis.forEach(add);
  else if (spec?.kpis && typeof spec.kpis === "object") Object.keys(spec.kpis).forEach(add);
  if (spec?.kpi_tolerances && typeof spec.kpi_tolerances === "object") {
    Object.keys(spec.kpi_tolerances).forEach(add);
  }

  const cfg = scenario?.reports?.kpi_config;
  if (Array.isArray(cfg)) cfg.forEach(add);
  else if (cfg && typeof cfg === "object") {
    if (Array.isArray(cfg.date_labels)) cfg.date_labels.forEach(add);
    if (Array.isArray(cfg.kpis)) cfg.kpis.forEach(add);
    else if (Array.isArray(cfg.labels)) cfg.labels.forEach(add);
  }

  const desc = String(scenario?.description || "");
  for (const line of desc.split(/\r?\n/)) {
    const t = line.replace(/^[-*•\d.)\s]+/, "").trim().replace(/^["']|["']$/g, "");
    if (t && looksLikeDateLabel(t)) add(t);
  }
  for (const def of DEFAULT_DATE_LABELS) {
    if (new RegExp(def.replace(/[()&]/g, "\\$&"), "i").test(desc) ||
        new RegExp(def.replace(/[()&]/g, "\\$&"), "i").test(String(scenario?.title || ""))) {
      add(def);
    }
  }

  labelsFromCode(String(
    existingScript?.playwright_code ||
      existingScript?.assertion_spec?.__reference_playwright_code ||
      "",
  )).forEach(add);

  const dated = out.filter(looksLikeDateLabel);
  if (dated.length) return dated;
  if (out.length) return out;
  return useDefault ? [...DEFAULT_DATE_LABELS] : [];
}

export function assembleDateScript(opts: {
  reportUrl: string;
  dateLabels: string[];
  /** Optional tab navigation. Empty = stay on Overview landing. */
  navSteps?: string[];
}): string {
  const reportUrl = normalizeReportUrl(opts.reportUrl);
  const dateLabels = (opts.dateLabels || []).filter((k) => typeof k === "string" && k.trim());
  const labels = dateLabels.length ? dateLabels : [...DEFAULT_DATE_LABELS];
  const navSteps = (opts.navSteps || []).filter((s) =>
    typeof s === "string" && s.trim() && !/^(weekly|monthly|quarterly)$/i.test(s)
  );
  const urlLit = JSON.stringify(reportUrl);
  const dateLit = JSON.stringify(labels, null, 4).replace(/\n/g, "\n    ");
  const navLit = JSON.stringify(navSteps);

  return `/**
 * RTB skill template: upper-right refresh / as-of dates (extractRefreshDate).
 * Filled from UI: report URL, DATE_LABELS, optional NAV_STEPS.
 * Filters come from runtime __filterCombinations (never hardcode Area/Region values).
 * Viewport: 1920x1080 / 100% zoom (working script used 1440x900; 1920 matches other templates).
 * Wait policy: spinner after each filter; one waitForDashboard before extract (not after every pick).
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

  // Ready AFTER tab nav: a DATE_LABEL on THIS screen.
  // One call after nav and one before scrape — never after every filter pick.
  const waitForDashboard = async (maxMs = 15000) => {
    await waitForLoadingToFinish(Math.min(maxMs, 15000));
    const markers = (typeof DATE_LABELS !== 'undefined' && Array.isArray(DATE_LABELS)) ? DATE_LABELS : [];
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
          if (!t) continue;
          if (want.includes(t) || want.some(w => t.includes(w) || w.includes(t))) return true;
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


  const extractDateValue = async (labelText) => {
    return await page.evaluate((label) => {
      function getDirectText(el) {
        let text = '';
        for (const node of el.childNodes)
          if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
        return text.trim();
      }
      const norm = s => s.replace(/\\s+/g, ' ').trim().toLowerCase();
      const target = norm(label);
      const isVisible = el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const st = getComputedStyle(el);
        return st.visibility !== 'hidden' && st.display !== 'none';
      };

      const labelMatches = [];
      for (const el of Array.from(document.querySelectorAll('*'))) {
        if (!isVisible(el)) continue;
        const direct = getDirectText(el);
        if (!direct) continue;
        const normDirect = norm(direct);
        if (normDirect === target || normDirect.includes(target) || target.includes(normDirect)) {
          if (normDirect.length > 0 && Math.abs(normDirect.length - target.length) <= 5) {
            const r = el.getBoundingClientRect();
            labelMatches.push({ el, r, area: r.width * r.height });
          }
        }
      }
      if (!labelMatches.length) return { error: 'Label not found: ' + label };
      labelMatches.sort((a, b) => a.area - b.area);

      const dateRe = /\\b(\\d{1,2}[\\/\\-]\\d{1,2}[\\/\\-]\\d{2,4}|\\d{4}[\\/\\-]\\d{1,2}[\\/\\-]\\d{1,2}|[A-Za-z]{3}\\s+\\d{1,2},?\\s+\\d{4}|WE\\s+\\d{1,2}\\/\\d{1,2}[\\/\\-]\\d{2,4}|ME\\s+\\d{1,2}\\/\\d{1,2}[\\/\\-]\\d{2,4})\\b/i;

      for (const { r: lr } of labelMatches) {
        const labelCx = lr.left + lr.width / 2;
        const candidates = [];

        for (const el of Array.from(document.querySelectorAll('*'))) {
          if (!isVisible(el)) continue;
          const direct = getDirectText(el);
          if (!direct || direct.length < 3) continue;
          if (norm(direct) === target) continue;
          const r = el.getBoundingClientRect();
          const dy = Math.abs(r.top - lr.top);
          const dx = Math.abs((r.left + r.width / 2) - labelCx);
          if (dy > 300 || dx > 600) continue;
          const hasDate = dateRe.test(direct);
          const isShortText = direct.length < 30 && direct.length > 2;
          if (hasDate || isShortText) {
            const fs = parseFloat(getComputedStyle(el).fontSize) || 0;
            candidates.push({ text: direct.trim(), fs, dy, dx, hasDate });
          }
        }

        if (!candidates.length) continue;
        const dateCands = candidates.filter(c => c.hasDate);
        const pool = dateCands.length ? dateCands : candidates;
        pool.sort((a, b) => a.dy - b.dy || a.dx - b.dx);
        return { value: pool[0].text };
      }
      return { error: 'No date value found near label: ' + label };
    }, labelText).catch(() => ({ error: 'evaluate failed' }));
  };

  const extractDateValueRightOfLabel = async (labelText) => {
    return await page.evaluate((label) => {
      function getDirectText(el) {
        let text = '';
        for (const node of el.childNodes)
          if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
        return text.trim();
      }
      const norm = s => s.replace(/\\s+/g, ' ').trim().toLowerCase();
      const target = norm(label);
      const isVisible = el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const st = getComputedStyle(el);
        return st.visibility !== 'hidden' && st.display !== 'none';
      };

      let labelEl = null, labelArea = Infinity;
      for (const el of Array.from(document.querySelectorAll('*'))) {
        if (!isVisible(el)) continue;
        const direct = getDirectText(el);
        if (!direct) continue;
        const normDirect = norm(direct);
        if (normDirect === target) {
          const r = el.getBoundingClientRect();
          const area = r.width * r.height;
          if (area < labelArea) { labelEl = el; labelArea = area; }
        }
      }

      if (!labelEl) {
        for (const el of Array.from(document.querySelectorAll('*'))) {
          if (!isVisible(el)) continue;
          const direct = getDirectText(el);
          if (!direct) continue;
          const normDirect = norm(direct);
          if (normDirect.includes(target) && normDirect.length < target.length + 10) {
            const r = el.getBoundingClientRect();
            const area = r.width * r.height;
            if (area < labelArea) { labelEl = el; labelArea = area; }
          }
        }
      }

      if (!labelEl) return { error: 'Label not found: ' + label };
      const lr = labelEl.getBoundingClientRect();

      const candidates = [];
      for (const el of Array.from(document.querySelectorAll('*'))) {
        if (!isVisible(el)) continue;
        if (el === labelEl) continue;
        const direct = getDirectText(el);
        if (!direct || direct.length < 3) continue;
        if (norm(direct) === target) continue;
        const r = el.getBoundingClientRect();
        const vertDiff = Math.abs(r.top - lr.top);
        const horizDiff = r.left - (lr.left + lr.width);
        if (vertDiff <= 20 && horizDiff >= -10 && horizDiff <= 400) {
          candidates.push({ text: direct.trim(), horizDiff, vertDiff });
        }
      }

      if (candidates.length) {
        candidates.sort((a, b) => a.horizDiff - b.horizDiff || a.vertDiff - b.vertDiff);
        return { value: candidates[0].text };
      }

      const parent = labelEl.parentElement;
      if (parent) {
        const siblings = Array.from(parent.querySelectorAll('*'));
        for (const sib of siblings) {
          if (sib === labelEl) continue;
          if (!isVisible(sib)) continue;
          const direct = getDirectText(sib);
          if (!direct || direct.length < 3) continue;
          if (norm(direct) === target) continue;
          const r = sib.getBoundingClientRect();
          if (r.left > lr.right - 10) {
            return { value: direct.trim() };
          }
        }
        const parentDirect = getDirectText(parent);
        if (parentDirect && norm(parentDirect) !== target && parentDirect.length > label.length + 2) {
          const idx = parentDirect.toLowerCase().indexOf(label.toLowerCase());
          if (idx !== -1) {
            const after = parentDirect.substring(idx + label.length).trim().replace(/^[:\\s]+/, '');
            if (after.length > 0) return { value: after };
          }
        }
      }

      return { error: 'No value found to the right of label: ' + label };
    }, labelText).catch(() => ({ error: 'evaluate failed' }));
  };

  const extractRefreshDate = async (labelText) => {
    const rightResult = await extractDateValueRightOfLabel(labelText);
    if (rightResult && rightResult.value) return rightResult;
    const dateResult = await extractDateValue(labelText);
    if (dateResult && dateResult.value) return dateResult;
    return { error: 'Could not extract value for: ' + labelText };
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
        // EXACT label wins over a substring hit. Smallest-area-only picked the page
        // title ("Lynkuet - Performance") or a longer link over the real tab.
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

  const DATE_LABELS = ${dateLit};

  const filterCombinations = (typeof __filterCombinations !== 'undefined' && Array.isArray(__filterCombinations) && __filterCombinations.length > 0)
    ? __filterCombinations : [];

  await waitForDossierReady();
  await runNav();
  await waitForDashboard();

  if (filterCombinations.length === 0) {
    const out = { navigation: navDebug };
    for (const k of DATE_LABELS) {
      const raw = await extractRefreshDate(k);
      out[k] = (raw && raw.value) ? raw.value : null;
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
    for (const k of DATE_LABELS) {
      const raw = await extractRefreshDate(k);
      row[k] = (raw && raw.value) ? raw.value : null;
    }
    results[label] = row;
  }
  return { navigation: navDebug, results };
};
`;
}

/**
 * Trend-check template: Weekly / Monthly / Quarterly graph periods must be
 * consecutive (no missing month / week / quarter in the middle).
 *
 * Reuses the proven chart Show Data pipeline, then analyzes the first time
 * column. Scenario type = "trend" picks this — not warehouse or reference compare.
 */

import { scenarioTextBlob } from "./mstr-nav-parse.ts";
import {
  assembleChartScript,
  parseChartNavSteps,
  parseChartTimeGrain,
  parseChartTitle,
  validateAssembledScript,
} from "./mstr-chart-template.ts";

export const TREND_CHECK_KPI = "Trend check";

export function isTrendCheckScenario(scenario: any, existingScript?: any): boolean {
  if (String(scenario?.type || "").toLowerCase() === "trend") return true;
  const blob = scenarioTextBlob(scenario).toLowerCase().replace(/\bquaterly\b/g, "quarterly");
  if (
    /\b(consecutive|consequent)\b/.test(blob) &&
    /\b(month|week|quarter|period|toggle)\b/.test(blob)
  ) {
    return true;
  }
  if (/\b(missing|absent|gap)\b/.test(blob) && /\b(month|week|quarter|period)\b/.test(blob)) {
    return true;
  }
  const code = String(
    existingScript?.playwright_code ||
      existingScript?.assertion_spec?.__reference_playwright_code ||
      "",
  );
  return /analyzeTrendContinuity|TREND_CHECK_KPI/.test(code);
}

export function parseTrendChartTitle(scenario: any): string {
  return parseChartTitle(scenario);
}

export function parseTrendTimeGrain(scenario: any, target: "main" | "reference" = "main"): string {
  return parseChartTimeGrain(scenario, target);
}

export function parseTrendNavSteps(scenario: any): string[] {
  return parseChartNavSteps(scenario);
}

export { validateAssembledScript };

/** Injected into the assembled chart script (Browserless function scope). */
const TREND_CONTINUITY_HELPER = `
  const TREND_CHECK_KPI = ${JSON.stringify(TREND_CHECK_KPI)};

  const monthIndex = (s) => {
    const m = String(s || '').toLowerCase();
    const names = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    for (let i = 0; i < 12; i++) {
      if (m.includes(names[i])) return i;
    }
    const n = m.match(/\\b(1[0-2]|0?[1-9])\\b/);
    if (n) return Number(n[1]) - 1;
    return null;
  };

  const parseYear = (s) => {
    const y4 = String(s || '').match(/\\b(20\\d{2})\\b/);
    if (y4) return Number(y4[1]);
    const y2 = String(s || '').match(/['’]?(\\d{2})\\b/);
    if (y2) {
      const n = Number(y2[1]);
      if (n >= 0 && n <= 99) return 2000 + n;
    }
    return null;
  };

  const mondayOf = (d) => {
    const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = x.getUTCDay() || 7;
    x.setUTCDate(x.getUTCDate() - (day - 1));
    return x.getTime();
  };

  const mondayOfIsoWeek = (year, week) => {
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const start = mondayOf(jan4);
    return start + (week - 1) * 7 * 86400000;
  };

  const formatMonth = (key) => {
    const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const year = Math.floor(key / 12);
    const mo = key % 12;
    return names[mo] + ' ' + year;
  };

  const formatQuarter = (key) => {
    const year = Math.floor(key / 4);
    const q = (key % 4) + 1;
    return 'Q' + q + ' ' + year;
  };

  const formatWeek = (ms) => {
    const d = new Date(ms);
    const y = d.getUTCFullYear();
    const jan4 = new Date(Date.UTC(y, 0, 4));
    const week = Math.round((ms - mondayOf(jan4)) / (7 * 86400000)) + 1;
    return 'W' + String(week).padStart(2, '0') + ' ' + y;
  };

  const extractPeriodLabels = (tableData) => {
    if (!tableData || typeof tableData !== 'object') return [];
    const headers = Array.isArray(tableData.headers) ? tableData.headers : [];
    const rows = tableData.rows || tableData.data || [];
    if (!Array.isArray(rows) || !rows.length) return [];
    let col = 0;
    const hi = headers.findIndex((h) => /date|month|week|quarter|period|time|bucket/i.test(String(h || '')));
    if (hi >= 0) col = hi;
    const firstKey = headers[col] || (rows[0] && typeof rows[0] === 'object' && !Array.isArray(rows[0])
      ? Object.keys(rows[0])[0]
      : null);
    const labels = [];
    for (const row of rows) {
      let cell;
      if (Array.isArray(row)) cell = row[col];
      else if (row && typeof row === 'object') cell = firstKey ? row[firstKey] : Object.values(row)[0];
      else cell = row;
      const t = String(cell ?? '').replace(/\\s+/g, ' ').trim();
      if (t && !/^(total|grand total|sum)$/i.test(t)) labels.push(t);
    }
    return labels;
  };

  const analyzePeriods = (labels, grain) => {
    const g = String(grain || 'Monthly').toLowerCase();
    const unparsed = [];
    if (g.startsWith('week')) {
      const points = [];
      const now = new Date();
      const assumeYear = now.getUTCFullYear();
      for (const raw of labels) {
        const w = String(raw).match(/w(?:eek)?\\s*(\\d{1,2})/i);
        const year = parseYear(raw);
        if (w && year) {
          points.push({ raw, key: mondayOfIsoWeek(year, Number(w[1])) });
          continue;
        }
        const md = String(raw).match(/^(\\d{1,2})[-/](\\d{1,2})$/);
        if (md) {
          const month = Number(md[1]);
          const day = Number(md[2]);
          if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
            points.push({ raw, key: mondayOf(new Date(Date.UTC(assumeYear, month - 1, day))) });
            continue;
          }
        }
        const d = Date.parse(raw);
        if (!Number.isNaN(d)) {
          points.push({ raw, key: mondayOf(new Date(d)) });
          continue;
        }
        unparsed.push(raw);
      }
      const uniq = [];
      const seen = new Set();
      for (const p of points.sort((a, b) => a.key - b.key)) {
        if (seen.has(p.key)) continue;
        seen.add(p.key);
        uniq.push(p);
      }
      const missing = [];
      for (let i = 1; i < uniq.length; i++) {
        const days = Math.round((uniq[i].key - uniq[i - 1].key) / 86400000);
        if (days > 7) {
          for (let t = uniq[i - 1].key + 7 * 86400000; t < uniq[i].key; t += 7 * 86400000) {
            missing.push(formatWeek(t));
          }
        }
      }
      return { periods: labels, parsed: uniq.length, unparsed, missing };
    }

    const weekish = labels.filter((raw) => /^\\d{1,2}[-/]\\d{1,2}$/.test(String(raw)));
    if (!g.startsWith('week') && weekish.length >= 2 && weekish.length >= labels.length * 0.6) {
      return { periods: labels, parsed: 0, unparsed: labels, missing: [], grain_mismatch: 'weekly' };
    }

    const points = [];
    for (const raw of labels) {
      const year = parseYear(raw);
      if (g.startsWith('quarter')) {
        const q = String(raw).match(/q\\s*([1-4])|([1-4])\\s*q/i);
        if (q && year) {
          points.push({ raw, key: year * 4 + (Number(q[1] || q[2]) - 1) });
          continue;
        }
        unparsed.push(raw);
        continue;
      }
      const iso = String(raw).match(/(20\\d{2})[-/](1[0-2]|0?[1-9])\\b/);
      const mi = monthIndex(raw);
      if (iso) {
        points.push({ raw, key: Number(iso[1]) * 12 + (Number(iso[2]) - 1) });
        continue;
      }
      if (mi != null && year) {
        points.push({ raw, key: year * 12 + mi });
        continue;
      }
      unparsed.push(raw);
    }
    const uniq = [];
    const seen = new Set();
    for (const p of points.sort((a, b) => a.key - b.key)) {
      if (seen.has(p.key)) continue;
      seen.add(p.key);
      uniq.push(p);
    }
    const missing = [];
    const fmt = g.startsWith('quarter') ? formatQuarter : formatMonth;
    for (let i = 1; i < uniq.length; i++) {
      const gap = uniq[i].key - uniq[i - 1].key;
      if (gap > 1) {
        for (let k = uniq[i - 1].key + 1; k < uniq[i].key; k++) missing.push(fmt(k));
      }
    }
    return { periods: labels, parsed: uniq.length, unparsed, missing };
  };

  const extractTrendPeriodsFallback = async (grain) => {
    return await page.evaluate((g) => {
      const looksLikePeriod = (raw) => {
        const s = String(raw || '').replace(/\\s+/g, ' ').trim();
        if (!s || s.length > 36) return false;
        if (/^(total|grand|sum|area|region|territory|performance|overview|activity)$/i.test(s)) return false;
        if (/w(?:eek)?\\s*\\d+/i.test(s)) return true;
        if (/q\\s*[1-4]/i.test(s)) return true;
        if (/\\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(s)) return true;
        if (/^\\d{1,2}[-/]\\d{1,2}$/.test(s)) return true;
        if (/\\d{1,2}[\\/\\-.]\\d{1,2}[\\/\\-.]\\d{2,4}/.test(s)) return true;
        if (/20\\d{2}[\\/\\-](1[0-2]|0?[1-9])/.test(s)) return true;
        if (String(g || '').toLowerCase().startsWith('week') && /\\b\\d{1,2}\\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(s)) return true;
        return false;
      };
      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        const st = getComputedStyle(el);
        return st.visibility !== 'hidden' && st.display !== 'none';
      };
      const lists = [];
      for (const table of Array.from(document.querySelectorAll('table'))) {
        if (!isVisible(table) || !table.rows || table.rows.length < 3) continue;
        const labels = [];
        for (let i = 0; i < table.rows.length; i++) {
          const cell = table.rows[i].cells[0];
          const t = cell ? (cell.innerText || cell.textContent || '').trim() : '';
          if (looksLikePeriod(t)) labels.push(t);
        }
        if (labels.length >= 2) lists.push(labels);
      }
      const ticks = [];
      for (const el of Array.from(document.querySelectorAll('text, tspan, .tick text, [class*="axis" i] text, [class*="label" i]'))) {
        if (!isVisible(el)) continue;
        const t = (el.textContent || '').trim();
        if (looksLikePeriod(t)) ticks.push(t);
      }
      const uniqTicks = [];
      const seen = new Set();
      for (const t of ticks) {
        const k = t.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        uniqTicks.push(t);
      }
      if (uniqTicks.length >= 2) lists.push(uniqTicks);
      lists.sort((a, b) => b.length - a.length);
      return lists[0] || [];
    }, grain).catch(() => []);
  };

  const tableLooksWeekly = (td) => {
    if (!td || typeof td !== 'object') return false;
    const rows = td.rows || td.data || [];
    const first = rows[0] && typeof rows[0] === 'object' ? rows[0] : null;
    const col0 = first ? String(first.col_0 || first.Period || '').toLowerCase() : '';
    if (/week/.test(col0)) return true;
    const labels = extractPeriodLabels(td);
    const weekish = labels.filter((l) => /^\\d{1,2}[-/]\\d{1,2}$/.test(String(l)));
    return weekish.length >= 2 && weekish.length >= labels.length * 0.6;
  };

  const tableMatchesGrain = (td, grain) => {
    const g = String(grain || '').toLowerCase();
    if (!td || td.error) return false;
    if (g.startsWith('week')) return true;
    return !tableLooksWeekly(td);
  };

  const analyzeTrendContinuity = (row, grain) => {
    const labels = extractPeriodLabels(row && row.tableData);
    const analysis = analyzePeriods(labels, grain);
    const enough = analysis.parsed >= 2;
    const consecutive = enough && analysis.missing.length === 0;
    row.time_grain = grain;
    row.periods = analysis.periods;
    row.missing = analysis.missing;
    row.unparsed_periods = analysis.unparsed;
    row.consecutive = consecutive;
    row[TREND_CHECK_KPI] = consecutive ? 1 : 0;
    if (analysis.grain_mismatch === 'weekly') {
      row.consecutive = false;
      row[TREND_CHECK_KPI] = 0;
      row.trend_error = 'Show Data still looks Weekly after ' + String(grain) + ' toggle';
    } else if (!enough) {
      row.trend_error = labels.length
        ? ('Could not parse ' + String(grain) + ' periods from Show Data')
        : 'No time periods extracted from graph Show Data';
    } else if (!consecutive) {
      row.trend_error = 'Missing ' + String(grain).toLowerCase() + '(s): ' + analysis.missing.join(', ');
    }
    return row;
  };

  const TREND_GRAINS = ['Weekly', 'Monthly', 'Quarterly'];

  const readSelectedGrain = async () => {
    for (const frame of page.frames()) {
      try {
        const detailed = await frame.evaluate((titleText) => {
          const norm = s => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
          const getDirectText = el => {
            let t = '';
            for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) t += n.textContent;
            return t.trim();
          };
          const isVisible = el => {
            const r = el.getBoundingClientRect();
            if (r.width < 1 || r.height < 1) return false;
            const st = getComputedStyle(el);
            return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
          };
          const title = norm(titleText);
          const grains = ['weekly', 'monthly', 'quarterly'];
          let titleRect = null, titleArea = Infinity;
          for (const el of Array.from(document.querySelectorAll('*'))) {
            if (!isVisible(el)) continue;
            const d = norm(getDirectText(el));
            const inner = norm(el.innerText || '');
            if (d !== title && !d.includes(title) && !(inner.includes(title) && inner.length <= title.length + 48)) continue;
            const r = el.getBoundingClientRect();
            const area = r.width * r.height;
            if (area < titleArea) { titleArea = area; titleRect = r; }
          }
          const hits = [];
          for (const el of Array.from(document.querySelectorAll('*'))) {
            if (!isVisible(el)) continue;
            const d = norm(getDirectText(el));
            if (!grains.includes(d)) continue;
            const r = el.getBoundingClientRect();
            if (r.width * r.height > 8000) continue;
            hits.push({ el, d, r });
          }
          let pool = hits;
          if (titleRect) {
            const near = hits.filter(h => Math.abs(h.r.top - titleRect.top) < 64 && h.r.left >= titleRect.left - 40);
            if (near.length) pool = near;
          }
          const selected = [];
          for (const h of pool) {
            const nodes = [h.el, h.el.parentElement, h.el.previousElementSibling];
            const inner = h.el.querySelector && h.el.querySelector('input, [role="radio"]');
            if (inner) nodes.push(inner);
            const isOn = nodes.some(node => {
              if (!node) return false;
              if (node.checked === true) return true;
              const aria = (node.getAttribute && (node.getAttribute('aria-checked') || node.getAttribute('aria-pressed') || node.getAttribute('aria-selected'))) || '';
              if (aria === 'true') return true;
              const cls = String(node.className || '');
              if (/selected|active|checked|pressed|RadioButton-on/i.test(cls)) return true;
              try {
                const st = getComputedStyle(node);
                if (Number(st.fontWeight) >= 700) return true;
              } catch (_) {}
              return false;
            });
            if (isOn) selected.push(h.d);
          }
          return {
            selected: selected[0] || null,
            all: selected,
            cluster: pool.map(h => ({ d: h.d, left: Math.round(h.r.left), top: Math.round(h.r.top) })),
            titleTop: titleRect ? Math.round(titleRect.top) : null,
            titleLeft: titleRect ? Math.round(titleRect.left) : null,
          };
        }, CHART_TITLE);
        if (detailed && (detailed.selected || (detailed.cluster && detailed.cluster.length))) return detailed;
      } catch (_) {}
    }
    return { selected: null };
  };

  const clickGrainNearTitle = async (grain) => {
    const target = String(grain || '').toLowerCase();
    for (const frame of page.frames()) {
      try {
        const hit = await frame.evaluate(([titleText, grainN]) => {
          const norm = s => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
          const getDirectText = el => {
            let t = '';
            for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) t += n.textContent;
            return t.trim();
          };
          const isVisible = el => {
            const r = el.getBoundingClientRect();
            if (r.width < 1 || r.height < 1) return false;
            const st = getComputedStyle(el);
            return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
          };
          const title = norm(titleText);
          const grains = ['weekly', 'monthly', 'quarterly'];
          let titleRect = null, titleArea = Infinity;
          for (const el of Array.from(document.querySelectorAll('*'))) {
            if (!isVisible(el)) continue;
            const d = norm(getDirectText(el));
            const inner = norm(el.innerText || '');
            if (d !== title && !d.includes(title) && !(inner.includes(title) && inner.length <= title.length + 48)) continue;
            const r = el.getBoundingClientRect();
            const area = r.width * r.height;
            if (area < titleArea) { titleArea = area; titleRect = r; }
          }
          const grainHits = [];
          for (const el of Array.from(document.querySelectorAll('*'))) {
            if (!isVisible(el)) continue;
            const d = norm(getDirectText(el));
            if (!grains.includes(d)) continue;
            const r = el.getBoundingClientRect();
            if (r.width * r.height > 8000) continue;
            grainHits.push({ el, d, r, area: r.width * r.height });
          }
          grainHits.sort((a, b) => a.area - b.area);
          if (!grainHits.length) return { error: 'no grain labels' };
          let cluster = grainHits;
          if (titleRect) {
            const nearTitle = grainHits.filter(h =>
              Math.abs(h.r.top - titleRect.top) < 64 && h.r.left >= titleRect.left - 40
            );
            if (nearTitle.length) cluster = nearTitle;
          }
          const pick = cluster.find(h => h.d === grainN) || grainHits.find(h => h.d === grainN);
          if (!pick) return { error: 'grain not near title: ' + grainN, titleTop: titleRect && titleRect.top };
          const clickControl = (el) => {
            const inner = el.querySelector && el.querySelector('input[type="radio"], [role="radio"]');
            if (inner) { inner.click(); return 'inner-radio'; }
            const forId = el.getAttribute && el.getAttribute('for');
            if (forId) {
              const inp = document.getElementById(forId);
              if (inp) { inp.click(); return 'label-for'; }
            }
            let p = el;
            for (let i = 0; i < 5 && p; i++, p = p.parentElement) {
              const role = (p.getAttribute && p.getAttribute('role')) || '';
              if (/radio|button|tab/i.test(role) || (p.tagName && /^(BUTTON|LABEL|INPUT)$/i.test(p.tagName))) {
                p.click();
                return 'ancestor-' + (p.tagName || role);
              }
              const pr = p.querySelector && p.querySelector('input[type="radio"], [role="radio"]');
              if (pr) { pr.click(); return 'ancestor-radio'; }
            }
            el.click();
            return 'text';
          };
          const via = clickControl(pick.el);
          return {
            clicked: true,
            via,
            grain: grainN,
            titleTop: titleRect ? Math.round(titleRect.top) : null,
            titleLeft: titleRect ? Math.round(titleRect.left) : null,
            cluster: cluster.map(h => ({ d: h.d, left: Math.round(h.r.left), top: Math.round(h.r.top) })),
            box: { left: pick.r.left, top: pick.r.top, width: pick.r.width, height: pick.r.height },
          };
        }, [CHART_TITLE, target]);
        if (hit && hit.error) continue;
        if (!hit || !hit.clicked || !hit.box) continue;
        let ox = 0, oy = 0;
        if (frame !== page.mainFrame()) {
          try {
            const frameEl = await frame.frameElement();
            const fb = await frameEl.boundingBox();
            if (fb) { ox = fb.x; oy = fb.y; }
          } catch (_) {}
        }
        const cx = ox + hit.box.left + hit.box.width / 2;
        const cy = oy + hit.box.top + hit.box.height / 2;
        await page.mouse.click(cx, cy);
        await waitForLoadingToFinish(20000);
        await waitForDashboard().catch(() => {});
        return { ...hit, mouse: { x: Math.round(cx), y: Math.round(cy) } };
      } catch (_) {}
    }
    return { error: 'title-scoped grain not found: ' + grain };
  };

  const finishGrainSlice = async (tmp, grain) => {
    analyzeTrendContinuity(tmp, grain);
    if (!tmp.periods || tmp.periods.length < 2) {
      const fallback = await extractTrendPeriodsFallback(grain);
      if (fallback && fallback.length >= 2) {
        tmp.tableData = {
          headers: ['Period'],
          rows: fallback.map((p) => ({ Period: p })),
          via: 'trend-period-fallback',
        };
        analyzeTrendContinuity(tmp, grain);
        tmp.trend_extract_via = 'fallback';
      }
    }
    return {
      time_grain: grain,
      periods: tmp.periods || [],
      missing: tmp.missing || [],
      unparsed_periods: tmp.unparsed_periods || [],
      consecutive: !!tmp.consecutive,
      trend_error: tmp.trend_error || null,
      tableData: tmp.tableData || null,
      show_data_error: tmp.show_data_error || null,
      show_data_debug: tmp.show_data_debug || null,
      extract_via: tmp.trend_extract_via || (tmp.tableData && tmp.tableData.via) || null,
      time_grain_click: tmp.time_grain_click || null,
      grain_retries: tmp.grain_retries || 0,
      selected_grain: tmp.selected_grain || null,
      first_col0: (tmp.tableData && tmp.tableData.rows && tmp.tableData.rows[0] && tmp.tableData.rows[0].col_0) || null,
    };
  };
`;

export async function assembleTrendCheckScript(opts: {
  reportUrl: string;
  chartTitle?: string;
  timeGrain?: string;
  navSteps?: string[];
}): Promise<string> {
  let src = await assembleChartScript(opts);

  src = src.replace(
    /\/\*\*[\s\S]*?RTB skill template:[\s\S]*?\*\//,
    `/**
 * RTB skill template: Trend check (consecutive Weekly / Monthly / Quarterly periods).
 * Reuses chart Show Data, then asserts no missing period in the time column.
 * Runtime: Browserless /chromium/function — export default async ({ page }) => { ... }
 */`,
  );

  src = src.replace(
    /const KPI_LABELS = \[\];/,
    `const KPI_LABELS = ["Trend check Weekly", "Trend check Monthly", "Trend check Quarterly"];`,
  );

  const applyHook = /const applyTimeGrain = async \(\) => \{\s*await sleep\(500\);[\s\S]*?let r = await clickChartTimeGrain\(TIME_GRAIN, CHART_TITLE\);[\s\S]*?r = await clickByText\(TIME_GRAIN, \{ openers: NAV_OPENERS, preferMiddle: true \}\);[\s\S]*?r = await clickByText\(TIME_GRAIN, \{ openers: NAV_OPENERS \}\);\s*\}/;
  if (!applyHook.test(src)) {
    throw new Error("trend_check assemble: applyTimeGrain hook not found");
  }
  src = src.replace(
    applyHook,
    `const applyTimeGrain = async (grainOverride) => {
    const grain = grainOverride || TIME_GRAIN;
    await sleep(500);
    let r = await clickChartTimeGrain(grain, CHART_TITLE);
    if (r && r.error) {
      r = await clickByText(grain, { openers: NAV_OPENERS, preferMiddle: true });
    }
    if (r && r.error) {
      r = await clickByText(grain, { openers: NAV_OPENERS });
    }`,
  );

  const extractFn =
    /  const extractChartAfterGrain = async \(row\) => \{[\s\S]*?\n  \};\n\n  if \(filterCombinations/;
  if (!extractFn.test(src)) {
    throw new Error("trend_check assemble: extractChartAfterGrain hook not found");
  }
  const navGrainHook = /\/\/ Grain belongs with navigation[\s\S]*?navDebug\.push\(\{ step: TIME_GRAIN, \.\.\.\(grainNav \|\| \{\}\) \}\);/;
  if (!navGrainHook.test(src)) {
    throw new Error("trend_check assemble: pre-filter grain hook not found");
  }
  src = src.replace(
    navGrainHook,
    `// Trend: click Weekly → extract, then Monthly → extract, then Quarterly → extract (after filters).`,
  );

  src = src.replace(
    extractFn,
    `${TREND_CONTINUITY_HELPER}

  const extractChartAfterGrain = async (row) => {
    await dismissGenericErrorDialog();
    await closeAnyOpenDropdown();
    await sleep(300);

    const tryExtract = async (popupMs = 20000) => {
      const openResult = await openShowData(CHART_TITLE);
      if (openResult.error) return { openResult, tableData: null, waitResult: null };
      const waitResult = await waitForShowDataPopup(popupMs);
      if (waitResult && waitResult.error) {
        await closeShowDataPopup().catch(() => {});
        return { openResult, waitResult, tableData: null };
      }
      const tableData = await extractShowDataTable();
      await closeShowDataPopup();
      return { openResult, waitResult, tableData };
    };

    const extractOneGrain = async (grain) => {
      const tmp = { grain_retries: 0 };
      let attempt = { openResult: null, waitResult: null, tableData: null };
      await closeShowDataPopup().catch(() => {});
      await dismissGenericErrorDialog();
      // 3 retries x 3 grains = 9 full Show Data cycles, which alone exceeds the
      // gateway budget. 2 is enough: a grain that fails twice will fail again.
      const wantGrain = String(grain).trim().toLowerCase();
      const grainOf = (sel) => String((sel && sel.selected) || '').trim().toLowerCase();
      for (let retry = 0; retry < 2; retry++) {
        tmp.grain_retries = retry;
        const apply = await applyTimeGrain(grain);
        const near = await clickGrainNearTitle(grain);
        // Wait for the re-render FIRST. Reading the radio straight after the click
        // returns the pre-click value, which made Weekly report "monthly" and then
        // extract the previous grain's periods.
        await waitForLoadingToFinish(20000);
        await dismissGenericErrorDialog();
        // Verify the radio actually moved before extracting anything.
        let selected = await readSelectedGrain();
        for (let i = 0; i < 12 && grainOf(selected) !== wantGrain; i++) {
          await sleep(500);
          selected = await readSelectedGrain();
        }
        tmp.time_grain_click = { apply, near, selected };
        tmp.selected_grain = selected && selected.selected;
        if (grainOf(selected) !== wantGrain) {
          // Never scrape a chart that is showing a different grain.
          tmp.grain_mismatch = { requested: grain, actual: (selected && selected.selected) || null };
          await dismissGenericErrorDialog();
          continue;
        }
        tmp.grain_mismatch = null;
        await sleep(1000);
        attempt = await tryExtract(20000);
        await closeShowDataPopup().catch(() => {});
        if (isGoodChartTable(attempt.tableData) && tableMatchesGrain(attempt.tableData, grain)) break;
        await dismissGenericErrorDialog();
      }
      tmp.show_data_debug = {
        open: attempt.openResult || null,
        wait: attempt.waitResult || null,
        tableError: (attempt.tableData && attempt.tableData.error) || null,
      };
      if (tmp.grain_mismatch) {
        // The grain toggle never took. Reporting the periods anyway produced
        // nonsense gaps (monthly labels checked against a weekly calendar).
        tmp.tableData = null;
        tmp.show_data_error = 'GRAIN_NOT_APPLIED: requested ' + grain
          + ' but the chart still shows ' + (tmp.grain_mismatch.actual || 'an unknown grain');
      } else if (isGoodChartTable(attempt.tableData)) {
        tmp.tableData = attempt.tableData;
      } else {
        tmp.show_data_error = (attempt.tableData && attempt.tableData.error)
          || (attempt.openResult && attempt.openResult.error)
          || (attempt.waitResult && attempt.waitResult.error)
          || 'extracted table is not a multi-column chart Show Data grid';
      }
      return await finishGrainSlice(tmp, grain);
    };

    row.grains = {};
    let allPass = true;
    for (const grain of TREND_GRAINS) {
      const one = await extractOneGrain(grain);
      row.grains[grain] = one;
      row['Trend check ' + grain] = one.consecutive ? 1 : 0;
      if (!one.consecutive) allPass = false;
      navDebug.push({ step: grain, clicked: !(one.show_data_error && !one.periods.length), grain, consecutive: one.consecutive });
    }
    const weekly = row.grains.Weekly || {};
    row.periods = weekly.periods || [];
    row.missing = weekly.missing || [];
    row.consecutive = allPass;
    row.time_grain = 'Weekly+Monthly+Quarterly';
    row[TREND_CHECK_KPI] = allPass ? 1 : 0;
    const failed = TREND_GRAINS.filter((g) => !row.grains[g] || !row.grains[g].consecutive);
    row.trend_error = allPass ? null : ('Failed: ' + failed.join(', '));
    return row;
  };

  if (filterCombinations`,
  );
  return src;
}

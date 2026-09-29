/**
 * Deterministic chart / Performance Trend script from the proven Browserless
 * Show Data reference (references/browserless-chart-showdata.js).
 * Geography cadence and wait-for-load helpers stay exactly as in that reference.
 */

import { normalizeReportUrl } from "./mstr-overview-template.ts";
import { hasFilterCore, injectFilterCore } from "./mstr-filter-core.ts";
import {
  parseNavStepsFromScenario,
  parseVizTitleFromScenario,
  scenarioTextBlob,
} from "./mstr-nav-parse.ts";

function scenarioBlob(scenario: any): string {
  return scenarioTextBlob(scenario);
}

/** Chart / trend / Show Data — not Overview KPI tiles or Geography grid. */
export function isChartScenario(scenario: any, existingScript?: any): boolean {
  if (String(scenario?.type || "").toLowerCase() === "trend") return false;
  const blob = scenarioBlob(scenario).toLowerCase();
  if (/\bgeography details\b/.test(blob) && /\bgrid\b/.test(blob)) return false;
  if (/\bperformance\s*trends?\s*grid\b/.test(blob) || (/\bperformance\s*trend\b/.test(blob) && /\bgrid\b/.test(blob))) {
    return false;
  }
  if (/\b(grid data|crosstab|on-page grid|all grid columns)\b/.test(blob)) return false;

  // Page/title says KPI tiles — "Performance Trend" as a screen name is not Show Data.
  // Only stay on the chart template when the user asked for graph / Show Data.
  const saysKpi = /\bkpis?\b/.test(blob);
  const explicitChart =
    /\b(show\s*data|chart\s*data|graph\s*data|line\s*chart|bar\s*chart)\b/.test(blob);
  if (saysKpi && !explicitChart) return false;

  if (/\b(show\s*data|chart\s*data|graph\s*data|line chart|bar chart|performance\s*trend|overall performance|activity\s*trend|segment\s*summary)\b/.test(blob)) {
    return true;
  }
  if (/\b(chart|graph|plot)\b/.test(blob) && !/\boverview\b/.test(blob) && !/\bkpi\b/.test(blob)) {
    return true;
  }
  if (/\bperformance\b/.test(blob) && /\b(weekly|monthly|quarterly|trend)\b/.test(blob) && !/\bactivity\b/.test(blob)) {
    return true;
  }
  const code = String(
    existingScript?.playwright_code ||
      existingScript?.assertion_spec?.__reference_playwright_code ||
      "",
  );
  if (/openShowData|extractShowDataTable|clickChartTimeGrain/.test(code)) return true;
  return false;
}

export function parseChartTitle(scenario: any): string {
  return parseVizTitleFromScenario(scenario, "chart");
}

export function parseChartTimeGrain(scenario: any, target: "main" | "reference" = "main"): string {
  const blob = scenarioBlob(scenario).toLowerCase().replace(/\bquaterly\b/g, "quarterly");

  const canon = (g: string | undefined | null): string | null => {
    const v = String(g || "").toLowerCase();
    if (v === "weekly") return "Weekly";
    if (v === "quarterly") return "Quarterly";
    if (v === "monthly") return "Monthly";
    return null;
  };

  // Strongest signal: "for Quarterly toggle" / "Monthly Toggle" (common in reference_match copy).
  const toggles = [...blob.matchAll(/\b(?:for\s+)?(weekly|monthly|quarterly)\s+toggle\b/g)].map((m) => m[1]);
  if (toggles.length) {
    if (target === "reference") return canon(toggles[toggles.length - 1]) || "Monthly";
    return canon(toggles[0]) || "Monthly";
  }

  const nearMain = blob.match(
    /(?:\bprod\b|\bmain\b)[\s\S]{0,160}?\b(weekly|monthly|quarterly)\b|\b(weekly|monthly|quarterly)\b[\s\S]{0,160}?(?:\bprod\b|\bmain\b)/,
  );
  const nearRef = blob.match(
    /(?:\bpre-?prod\b|\breference\b)[\s\S]{0,200}?\b(weekly|monthly|quarterly)\b/g,
  );
  // For reference, prefer the *last* pre-prod/reference→grain pairing (skip title "Reference Match Quaterly").
  if (target === "reference" && nearRef?.length) {
    const last = nearRef[nearRef.length - 1].match(/\b(weekly|monthly|quarterly)\b/);
    return canon(last?.[1]) || "Monthly";
  }

  if (target === "reference") {
    return canon((blob.match(/\b(weekly|monthly|quarterly)\b/g) || []).slice(-1)[0]) || "Monthly";
  }
  return (
    canon(nearMain?.[1] || nearMain?.[2]) ||
    canon((blob.match(/\b(weekly|monthly|quarterly)\b/g) || [])[0]) ||
    "Monthly"
  );
}

/**
 * Nav steps from scenario description / title / report name only.
 * Do NOT invent Performance vs Activity — grids, trend graphs, and summary graphs live on different screens.
 */
export function parseChartNavSteps(scenario: any): string[] {
  return parseNavStepsFromScenario(scenario, { allowGeography: false });
}

export { parseNavStepsFromScenario } from "./mstr-nav-parse.ts";

async function loadChartReference(): Promise<string> {
  const url = new URL("./references/browserless-chart-showdata.js", import.meta.url);
  return await Deno.readTextFile(url);
}

/** Light structural check before accepting a template (else fall back to Claude). */
export function validateAssembledScript(code: string): { ok: boolean; reason?: string } {
  if (!code || code.length < 500) return { ok: false, reason: "too_short" };
  if (!/export\s+default\s+async\s*\(\s*\{\s*page/.test(code)) {
    return { ok: false, reason: "missing_export" };
  }
  if (!/waitForLoadingToFinish/.test(code)) return { ok: false, reason: "missing_wait_loading" };
  if (!/waitForDashboard/.test(code)) return { ok: false, reason: "missing_wait_dashboard" };
  if (!/GEO_ORDER\s*=\s*\[\s*['"]Area['"]/.test(code) && !/applyFiltersInOrder/.test(code)) {
    return { ok: false, reason: "missing_geo_filters" };
  }
  // Filters must go through the hardened core: bounded binding + verified read-back.
  // A script without it can report ok:true on a filter that never moved.
  if (/selectByLabel/.test(code) && !hasFilterCore(code)) {
    return { ok: false, reason: "missing_filter_core" };
  }
  // Bracket balance (cheap syntax smell) — avoid new Function on `export default`.
  let depth = 0;
  for (const ch of code) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    if (depth < 0) return { ok: false, reason: "unbalanced_braces" };
  }
  if (depth !== 0) return { ok: false, reason: "unbalanced_braces" };
  return { ok: true };
}

/**
 * Fill the proven chart Show Data skeleton. Preserves GEO_ORDER
 * ['Area','Region','Territory','Time Bucket'] and wait helpers from the reference.
 */
export async function assembleChartScript(opts: {
  reportUrl: string;
  chartTitle?: string;
  timeGrain?: string;
  navSteps?: string[];
}): Promise<string> {
  // Always refresh the filter core from mstr-filter-core.ts so the reference copy
  // can never drift from the KPI/Grid templates.
  let src = injectFilterCore(await loadChartReference());
  const reportUrl = normalizeReportUrl(opts.reportUrl);
  // Title/nav come from scenario text — never invent Overall Performance / Performance.
  const chartTitle = (opts.chartTitle || "").trim() || "Chart";
  const timeGrain = (opts.timeGrain || "Monthly").trim() || "Monthly";
  const navSteps = (opts.navSteps || []).filter((s) => s && !/^(weekly|monthly|quarterly)$/i.test(s));
  const navLit = JSON.stringify(navSteps);
  const urlLit = JSON.stringify(reportUrl);
  const titleLit = JSON.stringify(chartTitle);
  const grainLit = JSON.stringify(timeGrain);

  // Pin report URL for Browserless (no Node `process` in /chromium/function).
  src = src.replace(
    /const __reportUrl = "";/,
    `const __reportUrl = ${urlLit};`,
  );
  src = src.replace(
    /const __reportUrl = process\.env\.REPORT_URL \|\| [^;]+;/,
    `const __reportUrl = ${urlLit};`,
  );

  src = src.replace(
    /const NAV_STEPS = \[[^\]]*\];/,
    `const NAV_STEPS = ${navLit};`,
  );

  src = src.replace(
    /const CHART_TITLE = '[^']*';/,
    `const CHART_TITLE = ${titleLit};`,
  );
  src = src.replace(
    /const CHART_TITLE = "[^"]*";/,
    `const CHART_TITLE = ${titleLit};`,
  );
  // Keep wait / grain helpers aligned with the real chart widget (not hardcoded Overall Performance).
  src = src.replace(
    /const CHART_WAIT_TITLE = '[^']*';/,
    `const CHART_WAIT_TITLE = ${titleLit};`,
  );
  src = src.replace(
    /const CHART_WAIT_TITLE = "[^"]*";/,
    `const CHART_WAIT_TITLE = ${titleLit};`,
  );
  // Prefer CHART_TITLE binding everywhere — never leave Overall Performance literals.
  src = src.replace(
    /clickChartTimeGrain\(TIME_GRAIN,\s*['"][^'"]*['"]\)/g,
    "clickChartTimeGrain(TIME_GRAIN, CHART_TITLE)",
  );
  src = src.replace(
    /async \(grain, chartTitle = ['"][^'"]*['"]\)/,
    `async (grain, chartTitle = ${titleLit})`,
  );
  src = src.replace(
    /String\(chartTitle \|\| ['"][^'"]*['"]\)/,
    `String(chartTitle || ${titleLit})`,
  );

  // Default grain when context/__timeGrain not injected (single- or double-quoted fallback).
  src = src.replace(
    /const TIME_GRAIN = \(typeof __timeGrain !== 'undefined' && __timeGrain\)\s*\|\|\s*\(typeof context !== 'undefined' && context && context\.timeGrain\)\s*\|\|\s*['"]Monthly['"];/,
    `const TIME_GRAIN = (typeof __timeGrain !== 'undefined' && __timeGrain)
    || (typeof context !== 'undefined' && context && context.timeGrain)
    || ${grainLit};`,
  );

  return src;
}

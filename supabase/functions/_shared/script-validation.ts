/**
 * Post-generate script validation: inspect Browserless run output for
 * navigation, filters, and extraction — then produce repair feedback.
 */

export type ValidationCheck = {
  name: "navigation" | "filters" | "extraction" | "runtime";
  pass: boolean;
  detail: string;
};

export type ScriptExpectations = {
  kind: string;
  navSteps: string[];
  timeGrain?: string | null;
  extract: "kpi" | "chart_table" | "grid" | "dates" | "trend_periods";
  kpiLabels?: string[];
  dateLabels?: string[];
  chartTitle?: string;
  gridTitle?: string;
  filterKeys?: string[];
};

export type ValidationReport = {
  ok: boolean;
  checks: ValidationCheck[];
  summary: string;
  repairHints: string;
  attempt?: number;
};

function asObj(v: unknown): Record<string, any> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : null;
}

export function pickResultRoot(payload: any): any {
  if (!payload || typeof payload !== "object") return null;
  // Do not unwrap `.results` here — chart/grid scripts return
  // `{ navigation: navDebug, results: { combo: {...} } }`. Dropping the parent
  // makes analyzeScriptRun see navDebug=[] even when tabs were clicked.
  const candidates = [
    payload?.extracted?.result,
    payload?.result,
    payload?.extracted,
    payload,
  ];
  for (const c of candidates) {
    const o = asObj(c);
    if (!o) continue;
    if (o.navigation || o.filters_applied || o.tableData || o.grid || o.results) return o;
  }
  return asObj(payload?.extracted?.result) || asObj(payload?.extracted) || null;
}

export function firstComboBlock(root: any): any {
  if (!root) return null;
  // Combo row already (do not treat sibling `navigation` as the extract block).
  if (root.filters_applied || root.tableData || root.grid || root.grains || Array.isArray(root.periods) || typeof root.consecutive === "boolean") return root;
  const nested = asObj(root.results);
  if (nested) {
    const keys = Object.keys(nested).filter((k) => !k.startsWith("__") && k !== "navigation");
    if (keys.length) {
      const first = asObj(nested[keys[0]]);
      if (first) return first;
    }
  }
  return root;
}

function norm(s: string) {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function navClicked(nav: any[], step: string): boolean {
  if (!Array.isArray(nav)) return false;
  const want = norm(step);
  return nav.some((n) => {
    if (!n || typeof n !== "object") return false;
    const st = norm(String(n.step || n.text || ""));
    if (st !== want && !st.includes(want) && !want.includes(st)) return false;
    return n.clicked === true || (!n.error && (n.via || n.clicked));
  });
}

function filterOk(filtersApplied: any, key: string): boolean {
  if (!filtersApplied || typeof filtersApplied !== "object") return false;
  const entry = filtersApplied[key];
  if (!entry) return false;
  if (entry.ok === true || entry.clicked === true) return true;
  if (entry.error) return false;
  return false;
}

function hasChartTable(block: any, chartTitle?: string): boolean {
  if (!block) return false;
  const td = block.tableData || (chartTitle && block[chartTitle]) || block["Overall Performance"];
  if (!td || typeof td !== "object") return false;
  if (td.error) return false;
  const headers = td.headers || td.columns || [];
  const rows = td.rows || td.data || [];
  if (Array.isArray(headers) && headers.length >= 2 && Array.isArray(rows) && rows.length >= 1) return true;
  return false;
}

function looksLikeKpiChromeGrid(g: any): boolean {
  const blob = JSON.stringify(g || {}).toLowerCase();
  if (/performance\s*kpis\s*-/.test(blob)) return true;
  const cols = g?.columns || g?.headers || [];
  if (Array.isArray(cols) && cols.filter((h: any) => /line\s*copy/i.test(String(h))).length >= 2) return true;
  if (Array.isArray(cols) && cols.filter((h: any) => /\d/.test(String(h)) && /nbrx|nrx|trx|writers/i.test(String(h))).length >= 2) {
    return true;
  }
  return false;
}

function hasGrid(block: any, gridTitle?: string, kpiLabel?: string): boolean {
  if (!block) return false;
  const g = block.grid || block.tableData || (kpiLabel && block[kpiLabel]) || (gridTitle && block[gridTitle]);
  if (!g || typeof g !== "object") return false;
  if (g.error) return false;
  if (looksLikeKpiChromeGrid(g)) return false;
  const cols = g.columns || g.headers || [];
  const rows = g.rows || g.data || [];
  if (Array.isArray(cols) && cols.length >= 2 && Array.isArray(rows) && rows.length >= 1) return true;
  return false;
}

function hasTrendPeriods(block: any): boolean {
  if (!block || typeof block !== "object") return false;
  if (block.grains && typeof block.grains === "object") {
    const hits = Object.values(block.grains).filter((g: any) =>
      Array.isArray(g?.periods) && g.periods.length >= 2
    );
    if (hits.length >= 1) return true;
  }
  if (Array.isArray(block.periods) && block.periods.length >= 2 && typeof block.consecutive === "boolean") {
    return true;
  }
  const td = block.tableData;
  const rows = td?.rows || td?.data;
  return Array.isArray(rows) && rows.length >= 2;
}

function hasDateValues(block: any, labels: string[]): boolean {
  if (!block || typeof block !== "object") return false;
  const keys = labels.length ? labels : Object.keys(block).filter((k) =>
    !/^(filters_applied|navigation|ok|error|via|url|extract_via|time_grain|chart_title|extract_debug)$/i.test(k)
  );
  for (const k of keys) {
    const v = block[k];
    if (typeof v === "string" && v.trim().length > 0) return true;
  }
  return false;
}

function hasKpis(block: any, labels: string[]): boolean {
  if (!block || typeof block !== "object") return false;
  const keys = labels.length ? labels : Object.keys(block).filter((k) =>
    !/^(filters_applied|navigation|ok|error|via|url|extract_via|time_grain|chart_title|extract_debug)$/i.test(k)
  );
  let hits = 0;
  for (const k of keys) {
    const v = block[k];
    if (v == null) continue;
    if (typeof v === "number" && Number.isFinite(v)) hits++;
    else if (typeof v === "string" && /^-?[\d,.]+%?$/.test(v.trim())) hits++;
    else if (typeof v === "string" && /(?:\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{2,4}|\d{1,2}\s+[A-Za-z]{3,9},?\s+\d{2,4})/i.test(v.trim())) hits++;
  }
  return hits >= Math.min(1, keys.length || 1);
}

export function buildExpectations(opts: {
  scenario: any;
  kind?: string;
  meta?: Record<string, unknown>;
  filterKeys?: string[];
}): ScriptExpectations {
  const meta = opts.meta || {};
  const kind = String(opts.kind || meta.generated_by || "llm").replace(/^skill:/, "");
  const navSteps = Array.isArray(meta.nav_steps)
    ? (meta.nav_steps as string[]).map(String)
    : [];
  const timeGrain = (meta.time_grain as string) || null;
  const chartTitle = (meta.chart_title as string) || "";
  const gridTitle = kind.includes("grid") || kind === "geography_grid"
    ? ((meta.grid_title as string) || "Geography Details")
    : String(meta.grid_title || "");

  let extract: ScriptExpectations["extract"] = "kpi";
  if (kind.includes("trend") || kind === "trend_check") extract = "trend_periods";
  else if (kind.includes("chart") || kind === "chart_show_data") extract = "chart_table";
  else if (kind.includes("grid") || kind === "geography_grid") extract = "grid";
  else if (kind.includes("date") || kind === "date_refresh") extract = "dates";

  const dateLabels = Array.isArray(meta.date_labels)
    ? (meta.date_labels as string[]).map(String)
    : [];

  return {
    kind,
    navSteps,
    timeGrain,
    extract,
    chartTitle,
    gridTitle,
    filterKeys: opts.filterKeys || [],
    kpiLabels: Array.isArray(meta.kpi_labels) ? (meta.kpi_labels as string[]).map(String) : [],
    dateLabels,
  };
}

export function analyzeScriptRun(payload: any, expectations: ScriptExpectations): ValidationReport {
  const checks: ValidationCheck[] = [];


  if (!payload || payload.ok === false || payload.error === "BROWSERLESS_TIMEOUT" || payload.error) {
    const msg = String(payload?.message || payload?.error || "Script run failed");
    checks.push({ name: "runtime", pass: false, detail: msg });
    return {
      ok: false,
      checks,
      summary: `Runtime failure: ${msg}`,
      repairHints: [
        "Fix hangs and indefinite waits; keep Show Data / dossier waits short.",
        "Ensure login and report URL succeed before navigation.",
        expectations.navSteps.length
          ? `NAV_STEPS must click: ${expectations.navSteps.join(" → ")}`
          : "Add required NAV_STEPS for the scenario tabs.",
      ].join("\n"),
    };
  }

  const root = pickResultRoot(payload);
  const block = firstComboBlock(root) || root || {};
  const navigation = Array.isArray(root?.navigation)
    ? root.navigation
    : (Array.isArray(block?.navigation) ? block.navigation : []);
  const filtersApplied = block?.filters_applied || root?.filters_applied || {};

  // Navigation
  if (expectations.navSteps.length) {
    const missing = expectations.navSteps.filter((s) => !navClicked(navigation, s));
    const grainOk = !expectations.timeGrain || navClicked(navigation, expectations.timeGrain)
      || (block?.time_grain && (block.time_grain.clicked || block.time_grain.grain));
    if (missing.length || !grainOk) {
      checks.push({
        name: "navigation",
        pass: false,
        detail: [
          missing.length ? `Missing/failed tabs: ${missing.join(", ")}` : null,
          !grainOk ? `Time grain not applied: ${expectations.timeGrain}` : null,
          `navDebug=${JSON.stringify(navigation).slice(0, 400)}`,
        ].filter(Boolean).join("; "),
      });
    } else {
      checks.push({
        name: "navigation",
        pass: true,
        detail: `Clicked ${expectations.navSteps.join(" → ")}${expectations.timeGrain ? ` + ${expectations.timeGrain}` : ""}`,
      });
    }
  } else {
    checks.push({ name: "navigation", pass: true, detail: "No nav steps required" });
  }

  // Filters
  if (expectations.filterKeys?.length) {
    const bad = expectations.filterKeys.filter((k) => !filterOk(filtersApplied, k));
    if (bad.length) {
      checks.push({
        name: "filters",
        pass: false,
        detail: `Failed filters: ${bad.join(", ")}; applied=${JSON.stringify(filtersApplied).slice(0, 500)}`,
      });
    } else {
      checks.push({
        name: "filters",
        pass: true,
        detail: `Applied ${expectations.filterKeys.join(", ")}`,
      });
    }
  } else {
    checks.push({ name: "filters", pass: true, detail: "No filter keys required" });
  }

  // Extraction
  let extractPass = false;
  let extractDetail = "";
  if (expectations.extract === "trend_periods") {
    extractPass = hasTrendPeriods(block);
    extractDetail = extractPass
      ? `Trend periods extracted (grain=${block.time_grain || expectations.timeGrain || "?"}; count=${Array.isArray(block.periods) ? block.periods.length : 0})`
      : `Missing consecutive-period extract; keys=${Object.keys(block).join(",")}; show_data_error=${block.show_data_error || ""}; trend_error=${block.trend_error || ""}`;
  } else if (expectations.extract === "chart_table") {
    extractPass = hasChartTable(block, expectations.chartTitle);
    extractDetail = extractPass
      ? "Multi-column chart Show Data table present"
      : `Missing chart tableData (title=${expectations.chartTitle}); got keys=${Object.keys(block).join(",")}; show_data_error=${block.show_data_error || ""}; show_data_debug=${JSON.stringify(block.show_data_debug || {}).slice(0, 900)}`;
  } else if (expectations.extract === "grid") {
    extractPass = hasGrid(block, expectations.gridTitle);
    const chrome = looksLikeKpiChromeGrid(block?.grid || block?.tableData);
    extractDetail = extractPass
      ? `Grid columns/rows present (via=${block.extract_via || block?.show_data?.via || "n/a"})`
      : chrome
      ? `Rejected Performance KPIs / Line-copy chrome scrape; use Menu → Show Data on '${expectations.gridTitle}'`
      : `Missing grid extract (title=${expectations.gridTitle}); extract_via=${block.extract_via || ""}; show_data=${JSON.stringify(block.show_data || {}).slice(0, 200)}; keys=${Object.keys(block).join(",")}`;
  } else if (expectations.extract === "dates") {
    extractPass = hasDateValues(block, expectations.dateLabels?.length ? expectations.dateLabels : (expectations.kpiLabels || []));
    extractDetail = extractPass
      ? "Date / refresh-date string values present"
      : `Missing date strings; keys=${Object.keys(block).join(",")}; extract_debug=${JSON.stringify(block.extract_debug || {}).slice(0, 900)}`;
  } else {
    extractPass = hasKpis(block, expectations.kpiLabels || []);
    extractDetail = extractPass
      ? "KPI values present"
      : `Missing KPI values; keys=${Object.keys(block).join(",")}; extract_debug=${JSON.stringify(block.extract_debug || {}).slice(0, 900)}`;
  }
  checks.push({ name: "extraction", pass: extractPass, detail: extractDetail });

  const ok = checks.every((c) => c.pass);
  const failed = checks.filter((c) => !c.pass);
  const repairHints = ok
    ? ""
    : [
      "VALIDATION FAILED — fix the Playwright script using these findings:",
      ...failed.map((c) => `- [${c.name}] ${c.detail}`),
      expectations.navSteps.length
        ? `- Required NAV_STEPS = ${JSON.stringify(expectations.navSteps)}`
        : null,
      expectations.timeGrain ? `- Required TIME_GRAIN / toggle = ${expectations.timeGrain}` : null,
      expectations.extract === "trend_periods"
        ? `- Click ${expectations.timeGrain || "Weekly/Monthly/Quarterly"} then openShowData('${expectations.chartTitle || "chart"}') and return periods + consecutive`
        : null,
      expectations.extract === "chart_table"
        ? `- Extract via openShowData('${expectations.chartTitle}') → multi-column tableData (never a single KPI cell)`
        : null,
      expectations.extract === "grid"
        ? `- Prefer openShowData('${expectations.gridTitle}') → Show Data popup table; reject Performance KPIs / Line copy scrapes; on-page only as fallback`
        : null,
      expectations.extract === "kpi"
        ? `- Use extractKPI for configured labels; largest font under exact label`
        : null,
      expectations.extract === "dates"
        ? `- Use extractRefreshDate for DATE_LABELS; expect string dates (not numeric KPIs)`
        : null,
      "- Keep Browserless APIs only (evaluate/click/type); do not invent locators.",
      "- Do not hardcode filter values; use __filterCombinations.",
    ].filter(Boolean).join("\n");

  return {
    ok,
    checks,
    summary: ok
      ? "Navigation, filters, and extraction all passed"
      : `Failed: ${failed.map((c) => c.name).join(", ")}`,
    repairHints,
  };
}

/** Keep constants (head) and extract helpers (tail). Full ~60k scripts time out Magentic. */
const REPAIR_SCRIPT_EXCERPT_CHARS = 16_000;

export function excerptScriptForRepair(code: string, maxChars = REPAIR_SCRIPT_EXCERPT_CHARS): {
  text: string;
  truncated: boolean;
  original_bytes: number;
} {
  const original = code || "";
  if (original.length <= maxChars) {
    return { text: original, truncated: false, original_bytes: original.length };
  }
  const marker = `\n\n/* … truncated ${original.length - maxChars} chars (head+tail kept for Magentic) … */\n\n`;
  const budget = Math.max(1_000, maxChars - marker.length);
  const head = Math.floor(budget * 0.4);
  const tail = budget - head;
  return {
    text: `${original.slice(0, head)}${marker}${original.slice(-tail)}`,
    truncated: true,
    original_bytes: original.length,
  };
}

export function formatValidationForAgent(report: ValidationReport, previousCode: string): string {
  const excerpt = excerptScriptForRepair(previousCode);
  return [
    report.repairHints,
    "",
    excerpt.truncated
      ? `Previous script excerpt (${excerpt.original_bytes} chars; head+tail only — return the COMPLETE fixed script):`
      : "Previous script (fix this — do not ignore NAV_STEPS / extract path):",
    "```javascript",
    excerpt.text,
    "```",
    "",
    "Return ONLY the corrected complete Playwright script as JSON:",
    '{ "playwright_code": "export default async ({ page }) => { ... }" }',
  ].join("\n");
}

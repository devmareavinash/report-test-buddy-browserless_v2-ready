/** Shared unwrap + noise filter for stored test_results actual/expected. */

export const KPI_VALUE_NOISE = new Set([
  "error", "message", "filter", "filters", "filters_applied", "source", "where_clause",
  "sql", "row", "metric", "value", "values", "ok", "note", "screenshot",
  "tabledata", "showdata", "showdatadebug", "showdataerror", "showdataopen",
  "extractvia", "firstcol0", "selectedgrain", "timegrainclick", "grainretries",
  "headers", "periods", "missing", "unparsedperiods", "consecutive", "trenderror",
  "timegrain", "grains", "navigation", "tabledatarejected",
  // Keep this aligned with KPI_META_KEYS in ScenarioDetail.tsx. When the two drift,
  // the Runs page renders bookkeeping fields (time_bucket, area, region, ...) as
  // phantom KPI rows that sit at "pending" and drag the overall result to fail,
  // while the Latest result tab -- which filters them -- shows pass.
  "timebucket", "area", "region", "territory", "charttitle", "mstrerrordismissed",
  "dossierready", "timegrainretry", "via", "role", "nth", "selector", "locator",
  "snapshot", "clicked", "opened", "option", "clickedtext", "jobid",
]);

export function normKpiKey(k: string) {
  return String(k || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isKpiValueNoise(k: string) {
  const raw = String(k || "");
  if (!raw || raw.startsWith("__")) return true;
  const normalized = normKpiKey(raw);
  if (KPI_VALUE_NOISE.has(normalized)) return true;
  // Playwright extractors often append readiness/debug metadata to the KPI
  // name itself (for example "Row Count - ..._grid_ready"). It is runtime
  // bookkeeping, never a second KPI.
  return normalized.endsWith("gridready");
}

export function unwrapStoredValues(side: any): Record<string, any> {
  if (!side || typeof side !== "object") return {};
  const raw = (side.values && typeof side.values === "object" && !Array.isArray(side.values))
    ? side.values
    : side;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (isKpiValueNoise(k)) continue;
    out[k] = v;
  }
  return out;
}

export function lookupStoredKpiValue(map: Record<string, any>, name: string): any {
  if (map[name] !== undefined) return map[name];
  const want = normKpiKey(name);
  const exact = Object.keys(map).find((key) => normKpiKey(key) === want);
  if (exact) return map[exact];
  if (want === "count") {
    const rowCounts = Object.keys(map).filter((key) =>
      /^rowcount/.test(normKpiKey(key))
    );
    if (rowCounts.length === 1) return map[rowCounts[0]];
  }
  return undefined;
}

export function configuredKpiNames(spec: any): string[] {
  if (!spec || typeof spec !== "object") return [];
  const tols = spec.kpi_tolerances && typeof spec.kpi_tolerances === "object"
    ? Object.keys(spec.kpi_tolerances).filter((k) => k && !isKpiValueNoise(k))
    : [];
  if (tols.length) return tols;
  if (Array.isArray(spec.kpis)) {
    return spec.kpis.map((k: any) => String(k?.label || k?.name || k || "").trim()).filter((k: string) => k && !isKpiValueNoise(k));
  }
  return [];
}

export type KpiCompareOp = "eq" | "lte" | "gte" | "gt" | "lt";

function toNum(v: any): number {
  if (v === null || v === undefined) return NaN;
  if (typeof v === "number") return v;
  const n = Number(String(v).replace(/[,\s%$]/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

/** Same rule as Latest result: one condition applies to every KPI. */
export function getGlobalCompareOp(tols: Record<string, any> | undefined): KpiCompareOp {
  for (const v of Object.values(tols || {})) {
    const op = v && typeof v === "object" ? v.op : undefined;
    if (op === "lte" || op === "gte" || op === "gt" || op === "lt" || op === "eq") return op;
  }
  return "eq";
}

export function resolveKpiTol(tols: Record<string, any> | undefined, name: string): {
  value: number;
  unit: string;
  op: KpiCompareOp;
} {
  const map = tols && typeof tols === "object" ? tols : {};
  let entry = map[name];
  if (entry == null) {
    const want = normKpiKey(name);
    const hit = Object.keys(map).find((k) => normKpiKey(k) === want);
    entry = hit ? map[hit] : undefined;
  }
  const value = typeof entry === "number" ? entry : Number(entry?.value);
  return {
    value: Number.isFinite(value) ? value : 0,
    unit: (typeof entry === "object" && entry?.unit) || "pct",
    op: getGlobalCompareOp(map),
  };
}

/** Numeric KPI pass/fail matching ScenarioDetail Latest result (`evalPass`). */
export function evalNumericKpiPass(
  actual: any,
  expected: any,
  tol?: { value?: number; unit?: string; op?: string },
): boolean | null {
  if (actual == null || expected == null) return null;
  const a = toNum(actual);
  const e = toNum(expected);
  if (!(Number.isFinite(a) && Number.isFinite(e))) return null;
  const t = Number.isFinite(Number(tol?.value)) ? Math.abs(Number(tol.value)) : 0;
  const op = tol?.op || "eq";
  const allowance = tol?.unit === "abs" ? t : (e === 0 ? t : Math.abs(e) * t / 100);
  if (op === "lte") return a <= e + allowance;
  if (op === "gte") return a >= e - allowance;
  if (op === "gt") return a > e + allowance;
  if (op === "lt") return a < e - allowance;
  return Math.abs(a - e) <= allowance;
}

function firstPayloadError(side: any): string {
  if (!side || typeof side !== "object") return "";
  const e = side.error ?? side.message;
  if (typeof e === "string" && e.trim()) return e.trim();
  return "";
}

/** RCA text if saved; otherwise the stored run error (same fallback as Latest result history). */
export function storedRunLog(row: { analysis?: string | null; actual?: any; expected?: any } | null | undefined): string {
  const rca = String(row?.analysis || "").trim();
  if (rca) return rca;
  return firstPayloadError(row?.actual) || firstPayloadError(row?.expected) || "";
}

export function storedRunLogIsRca(row: { analysis?: string | null } | null | undefined): boolean {
  return Boolean(String(row?.analysis || "").trim());
}

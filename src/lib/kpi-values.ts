import { compareTables } from "./tableCompare";

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

function cleanKpiTolerances(tols: any): Record<string, any> {
  if (!tols || typeof tols !== "object" || Array.isArray(tols)) return {};
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(tols)) {
    if (!k || isKpiValueNoise(k)) continue;
    out[k] = v;
  }
  return out;
}

export function storedKpiTolerances(actual: any, spec: any): Record<string, any> {
  const snapshot = cleanKpiTolerances(actual?.tolerances_snapshot);
  if (Object.keys(snapshot).length) return snapshot;
  return cleanKpiTolerances(spec?.kpi_tolerances);
}

export function storedKpiSpec(actual: any, spec: any): any {
  return {
    ...(spec && typeof spec === "object" ? spec : {}),
    kpi_tolerances: storedKpiTolerances(actual, spec),
  };
}

export type KpiCompareOp = "eq" | "lte" | "gte" | "gt" | "lt";

function toNum(v: any): number {
  if (v === null || v === undefined) return NaN;
  if (typeof v === "number") return v;
  const n = Number(String(v).replace(/[,\s%$]/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

/** Legacy helper for callers that intentionally need one shared condition. */
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
  const op = typeof entry === "object" ? entry?.op : undefined;
  return {
    value: Number.isFinite(value) ? value : 0,
    unit: (typeof entry === "object" && entry?.unit) || "pct",
    op: op === "lte" || op === "gte" || op === "gt" || op === "lt" || op === "eq" ? op : "eq",
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

const DATE_VALUE_RE = new RegExp(
  [
    String.raw`\d{1,2}\s*[\/.\-]\s*\d{1,2}\s*[\/.\-]\s*\d{2,4}`,
    String.raw`[A-Za-z]{3,9}\.?\s+\d{1,2}\s*[-,]?\s*\d{2,4}`,
    String.raw`\d{1,2}\s+[A-Za-z]{3,9}\.?\s*[-,]?\s*\d{2,4}`,
    String.raw`\d{4}-\d{2}-\d{2}`,
  ].join("|"),
  "i",
);

export const looksLikeStoredDateValue = (v: any): boolean =>
  typeof v === "string" && !!v.trim() && DATE_VALUE_RE.test(v.trim());

export const normalizeStoredDateText = (v: any) =>
  String(v ?? "").replace(/\s+/g, " ").replace(/\s*[-,]\s*/g, " ").trim().toLowerCase();

const MONTH_INDEX: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

function utcDateValue(year: number, month: number, day: number): number | null {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  const ts = Date.UTC(year, month, day);
  const d = new Date(ts);
  return d.getUTCFullYear() === year && d.getUTCMonth() === month && d.getUTCDate() === day ? ts : null;
}

export function parseStoredDateValue(v: any): number | null {
  if (!looksLikeStoredDateValue(v)) return null;
  const raw = String(v ?? "").trim();
  const yearFirst = raw.match(/^(\d{4})\s*-\s*(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (yearFirst) return utcDateValue(Number(yearFirst[1]), Number(yearFirst[2]) - 1, Number(yearFirst[3]));

  const numeric = raw.match(/^(\d{1,2})\s*[\/.\-]\s*(\d{1,2})\s*[\/.\-]\s*(\d{2,4})$/);
  if (numeric) {
    const [, m, d, y] = numeric;
    return utcDateValue(Number(y.length === 2 ? `20${y}` : y), Number(m) - 1, Number(d));
  }

  const monthFirst = raw.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})\s*[-,]?\s*(\d{2,4})$/);
  if (monthFirst) {
    const month = MONTH_INDEX[monthFirst[1].toLowerCase()];
    return utcDateValue(Number(monthFirst[3].length === 2 ? `20${monthFirst[3]}` : monthFirst[3]), month, Number(monthFirst[2]));
  }

  const dayFirst = raw.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s*[-,]?\s*(\d{2,4})$/);
  if (dayFirst) {
    const month = MONTH_INDEX[dayFirst[2].toLowerCase()];
    return utcDateValue(Number(dayFirst[3].length === 2 ? `20${dayFirst[3]}` : dayFirst[3]), month, Number(dayFirst[1]));
  }
  return null;
}

export function evalStoredDatePass(
  actual: any,
  expected: any,
  tol?: { value?: number; unit?: string; op?: string },
): boolean | null {
  const a = parseStoredDateValue(actual);
  const e = parseStoredDateValue(expected);
  if (a == null || e == null) {
    return normalizeStoredDateText(actual) === normalizeStoredDateText(expected);
  }
  const op = tol?.op || "eq";
  const dayMs = 24 * 60 * 60 * 1000;
  const allowance = Number.isFinite(Number(tol?.value))
    ? Math.abs(Number(tol?.value)) * (tol?.unit === "abs" ? dayMs : 0)
    : 0;
  if (op === "lte") return a <= e + allowance;
  if (op === "gte") return a >= e - allowance;
  if (op === "gt") return a > e + allowance;
  if (op === "lt") return a < e - allowance;
  return Math.abs(a - e) <= allowance;
}

function recordsToTable(records: any[]): { columns: string[]; rows: any[][] } | null {
  if (!records?.length || typeof records[0] !== "object" || Array.isArray(records[0])) return null;
  const columns: string[] = [];
  for (const rec of records) {
    for (const k of Object.keys(rec || {})) {
      const n = normKpiKey(k);
      if (n === "via" || k.startsWith("__") || /^col\d+$/i.test(k)) continue;
      if (!columns.includes(k)) columns.push(k);
    }
  }
  if (!columns.length) return null;
  return { columns, rows: records.map((rec) => columns.map((c) => rec?.[c] ?? "")) };
}

function columnLabel(c: any, i: number) {
  if (c == null) return `Col ${i + 1}`;
  if (typeof c === "string" || typeof c === "number") return String(c);
  return String(c.name || c.label || c.title || c.key || `Col ${i + 1}`);
}

export function toStoredTableModel(v: any): { columns: string[]; rows: any[][] } | null {
  if (v == null || typeof v === "boolean" || typeof v === "number" || typeof v === "string") return null;
  if (Array.isArray(v)) {
    if (!v.length) return null;
    if (typeof v[0] === "object" && v[0] && !Array.isArray(v[0])) return recordsToTable(v);
    if (Array.isArray(v[0])) {
      const first = v[0].map((c: any, i: number) => columnLabel(c, i));
      return { columns: first, rows: v.slice(1) };
    }
    return { columns: ["Value"], rows: v.map((cell) => [cell]) };
  }
  if (typeof v !== "object") return null;
  const nested = [v.data, v.grid, v.graph, v.table, v.tableData, v.tabledata, v.dataset]
    .find((x) => x && (Array.isArray(x) || typeof x === "object"));
  if (nested && nested !== v) {
    const inner = toStoredTableModel(nested);
    if (inner) return inner;
  }
  if (Array.isArray(v.rows)) {
    if (v.rows[0] && typeof v.rows[0] === "object" && !Array.isArray(v.rows[0])) return recordsToTable(v.rows);
    if (Array.isArray(v.rows[0])) {
      const rawCols = Array.isArray(v.headers)
        ? (v.headers as any[]).map(columnLabel)
        : Array.isArray(v.columns) ? (v.columns as any[]).map(columnLabel) : null;
      const keep = (rawCols || []).map((h, i) => {
        if (i === 0 && /^col_?\d+$/i.test(h) && (v.rows || []).some((r: any) => r?.[0] && !/^[\d,.%()\s-]+$/.test(String(r[0])))) return "Metric";
        return /^col_?\d+$/i.test(h) ? null : h;
      });
      const cols = keep.filter((h): h is string => !!h);
      const idx = keep.map((h, i) => (h ? i : -1)).filter((i) => i >= 0);
      if (cols.length) return { columns: cols, rows: (v.rows as any[][]).map((row) => idx.map((i) => row?.[i])) };
      return toStoredTableModel(v.rows);
    }
  }
  return null;
}

export function isStoredTableValue(v: any): boolean {
  return !!toStoredTableModel(v);
}

export type StoredResultStatus = "pass" | "fail" | "pending";

export type StoredResultKpiRow = {
  k: string;
  a: any;
  e: any;
  diff: number | null;
  deltaPct: number | null;
  pass: boolean | null;
  error?: string | null;
};

export function evalStoredKpiValue(
  actual: any,
  expected: any,
  tol?: { value?: number; unit?: string; op?: string },
): boolean | null {
  if (actual == null || expected == null) return null;
  const actualTable = toStoredTableModel(actual);
  const expectedTable = toStoredTableModel(expected);
  if (actualTable || expectedTable) {
    if (!actualTable || !expectedTable) return null;
    return compareTables(
      actualTable,
      expectedTable,
      { value: Number(tol?.value) || 0, unit: (tol?.unit === "abs" ? "abs" : "pct"), op: (tol?.op as any) || "eq" },
      { skipChangeRows: true },
    ).pass;
  }
  if (looksLikeStoredDateValue(actual) || looksLikeStoredDateValue(expected)) {
    return evalStoredDatePass(actual, expected, tol);
  }
  const numeric = evalNumericKpiPass(actual, expected, tol);
  if (numeric !== null) return numeric;
  const a = toNum(actual);
  const e = toNum(expected);
  if (Number.isFinite(a) || Number.isFinite(e)) return null;
  return String(actual) === String(expected);
}

export function storedResultKpiNames(actual: any, expected: any, spec: any): string[] {
  const actualMap = unwrapStoredValues(actual);
  const expectedMap = unwrapStoredValues(expected);
  const effectiveSpec = storedKpiSpec(actual, spec);
  const configured = configuredKpiNames(effectiveSpec);
  const available = [...Object.keys(actualMap), ...Object.keys(expectedMap)].filter((k) => !isKpiValueNoise(k));
  const configuredHasStoredValue = configured.some((k) =>
    lookupStoredKpiValue(actualMap, k) !== undefined || lookupStoredKpiValue(expectedMap, k) !== undefined
  );
  if (configured.length && configuredHasStoredValue) return configured;
  const fallback = Array.from(new Set(available)).filter((k) => !isKpiValueNoise(k));
  const hasLegacyCountPair =
    lookupStoredKpiValue(actualMap, "Count") !== undefined &&
    lookupStoredKpiValue(expectedMap, "Count") !== undefined &&
    fallback.some((k) => normKpiKey(k) === "count" || /^rowcount/.test(normKpiKey(k)));
  if (!hasLegacyCountPair) return fallback;
  return ["Count", ...fallback.filter((k) => {
    const n = normKpiKey(k);
    return n !== "count" && !/^rowcount/.test(n);
  })];
}

export function overallFromStoredKpiRows(rows: Array<{ pass: boolean | null | undefined }>): StoredResultStatus {
  if (!rows.length) return "pending";
  if (rows.some((row) => row.pass === false)) return "fail";
  if (rows.some((row) => row.pass !== true)) return "pending";
  return "pass";
}

function toStoredStatus(status: any): StoredResultStatus {
  return status === "pass" || status === "fail" || status === "pending" ? status : "pending";
}

export function deriveStoredResultRows({
  actual,
  expected,
  spec,
  diff: storedDiff,
  fallbackStatus,
}: {
  actual: any;
  expected: any;
  spec?: any;
  scenarioType?: string;
  diff?: any;
  fallbackStatus?: string | null;
}): {
  rows: StoredResultKpiRow[];
  status: StoredResultStatus;
  derived: boolean;
} {
  if (firstPayloadError(actual) || firstPayloadError(expected)) {
    return { rows: [], status: "fail", derived: true };
  }
  const actualMap = unwrapStoredValues(actual);
  const expectedMap = unwrapStoredValues(expected);
  const effectiveSpec = storedKpiSpec(actual, spec);
  const tols = effectiveSpec.kpi_tolerances || {};
  const names = storedResultKpiNames(actual, expected, spec);
  let rows = names.map((k) => {
    let a = lookupStoredKpiValue(actualMap, k);
    let e = lookupStoredKpiValue(expectedMap, k);
    if (a == null && isStoredTableValue(actual?.values?.tableData || actual?.tableData)) {
      a = actual?.values?.tableData || actual?.tableData;
    }
    if (e == null && isStoredTableValue(expected?.values?.tableData || expected?.tableData)) {
      e = expected?.values?.tableData || expected?.tableData;
    }
    const aN = toNum(a);
    const eN = toNum(e);
    const both = Number.isFinite(aN) && Number.isFinite(eN);
    const diff = both ? aN - eN : null;
    const deltaPct = both && eN !== 0 ? (diff! / Math.abs(eN)) * 100 : null;
    const tol = resolveKpiTol(tols, k);
    const diffEntry = storedDiff && typeof storedDiff === "object"
      ? lookupStoredKpiValue(storedDiff, k)
      : null;
    const error = diffEntry && typeof diffEntry === "object" && typeof diffEntry.error === "string"
      ? diffEntry.error
      : null;
    // The orchestrator records explicit KPI failures such as `no_value` in
    // the diff map. Missing actual/expected values alone compare as pending,
    // so preserve that execution-time failure instead of contradicting the
    // persisted row status in Run Detail.
    const pass = error
      ? false
      : evalStoredKpiValue(a, e, tol);
    return { k, a, e, diff, deltaPct, pass, error };
  });
  if (!rows.length) return { rows, status: toStoredStatus(fallbackStatus), derived: false };
  const calculatedStatus = overallFromStoredKpiRows(rows);
  const persistedStatus = toStoredStatus(fallbackStatus);
  // Older stored results may contain only the authoritative result status,
  // without a KPI-level diff error. Do not turn such a recorded failure back
  // into pending merely because the missing values cannot be re-compared.
  if (calculatedStatus === "pending" && persistedStatus === "fail") {
    if (rows.length === 1 && rows[0].pass == null) {
      rows = [{ ...rows[0], pass: false }];
    }
    return { rows, status: "fail", derived: false };
  }
  return { rows, status: calculatedStatus, derived: true };
}

export function deriveStoredResultStatus(args: Parameters<typeof deriveStoredResultRows>[0]): StoredResultStatus {
  return deriveStoredResultRows(args).status;
}

function firstPayloadError(side: any): string {
  if (!side || typeof side !== "object") return "";
  const e = side.error;
  if (typeof e === "string" && e.trim()) return e.trim();
  const message = side.message;
  if (typeof message === "string" && message.trim() && !Object.keys(unwrapStoredValues(side)).length) {
    return message.trim();
  }
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

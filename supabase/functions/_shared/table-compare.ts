/**
 * Cell-wise comparison for GRID and GRAPH (Show Data) results — backend copy.
 *
 * MUST stay behaviourally identical to src/lib/tableCompare.ts. The UI renders
 * from its copy and this one decides the status written to `test_results`; if
 * they drift, the Latest-result tab and the Tests / Dashboard / Runs screens
 * disagree about the same run.
 *
 * Previously both grid and graph used JSON.stringify equality, which ignored
 * the configured comparator and tolerance and failed the whole visual on any
 * single differing cell.
 */

export type CompareOp = "eq" | "lte" | "gte" | "gt" | "lt";
export type Tolerance = { value: number; unit: "pct" | "abs"; op?: CompareOp };
export type TableModel = { columns: string[]; rows: any[][] };

export type CellDiff = {
  row: string;
  column: string;
  actual: number | string | null;
  expected: number | string | null;
  deltaPct: number | null;
  reason: "out_of_tolerance" | "missing_actual" | "missing_expected" | "text_mismatch";
};

export type TableCompareResult = {
  pass: boolean;
  comparedCells: number;
  skippedRows: string[];
  skippedColumns: string[];
  failedCells: CellDiff[];
  rowsOnlyInActual: string[];
  rowsOnlyInExpected: string[];
  unmatchedColumns?: string[];
  missingExpectedColumns?: string[];
  note?: string;
};

/** Rows holding a period-over-period delta — an inequality comparator is meaningless for them. */
const CHANGE_ROW_RE = /\b(change|chg|delta|diff|difference|variance|var|growth|vs\.?\s*(prev|previous|prior|ly|py))\b/i;

export function isChangeRow(label: string): boolean {
  return CHANGE_ROW_RE.test(String(label || ""));
}

/** "4,957.0" -> 4957 ; "(5,230)" -> -5230 ; "65.5%" -> 65.5 */
export function parseCell(v: any): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = String(v).trim();
  if (!s || s === "-" || s === "--" || s === "N/A" || s.toLowerCase() === "null") return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[,\s$%]/g, "");
  if (s.startsWith("-")) { neg = true; s = s.slice(1); }
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

const normLabel = (s: any) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

export function cellPasses(actual: number, expected: number, tol?: Tolerance): boolean {
  const t = tol && Number.isFinite(Number(tol.value)) ? Math.abs(Number(tol.value)) : 0;
  const op: CompareOp = (tol && tol.op) || "eq";
  const allowance = tol?.unit === "abs" ? t : (expected === 0 ? t : (Math.abs(expected) * t) / 100);
  if (op === "lte") return actual <= expected + allowance;
  if (op === "gte") return actual >= expected - allowance;
  if (op === "gt") return actual > expected + allowance;
  if (op === "lt") return actual < expected - allowance;
  return Math.abs(actual - expected) <= allowance;
}

/** Normalize the shapes the scripts emit into { columns, rows }. */
export function toTableModel(v: any): TableModel | null {
  if (v == null || typeof v !== "object") return null;

  const nested = [v.data, v.grid, v.graph, v.table, v.tableData, v.dataset]
    .find((x: any) => x && typeof x === "object");
  if (nested && nested !== v) {
    const inner = toTableModel(nested);
    if (inner) return inner;
  }

  if (Array.isArray(v.rows)) {
    const cols = Array.isArray(v.columns)
      ? v.columns.map((c: any) => String(c ?? ""))
      : (Array.isArray(v.headers) ? v.headers.map((c: any) => String(c ?? "")) : null);
    if (v.rows[0] && typeof v.rows[0] === "object" && !Array.isArray(v.rows[0])) {
      // Array of records -> table
      const keys: string[] = [];
      for (const r of v.rows) for (const k of Object.keys(r || {})) if (!keys.includes(k)) keys.push(k);
      return { columns: keys, rows: v.rows.map((r: any) => keys.map((k) => r?.[k] ?? "")) };
    }
    if (Array.isArray(v.rows[0])) {
      return { columns: cols ?? v.rows[0].map((_: any, i: number) => `Col ${i + 1}`), rows: v.rows };
    }
  }

  if (Array.isArray(v)) {
    if (!v.length) return null;
    if (Array.isArray(v[0])) {
      const headerish = v[0].every((c: any) => typeof c === "string" && parseCell(c) === null);
      if (headerish && v.length > 1) return { columns: v[0].map((c: any) => String(c)), rows: v.slice(1) };
      return { columns: v[0].map((_: any, i: number) => `Col ${i + 1}`), rows: v };
    }
  }
  return null;
}

export function compareTables(
  actual: TableModel | null,
  expected: TableModel | null,
  tol?: Tolerance,
  opts?: { skipChangeRows?: boolean },
): TableCompareResult {
  const skipChange = opts?.skipChangeRows !== false;
  const base: TableCompareResult = {
    pass: false, comparedCells: 0, skippedRows: [], skippedColumns: [], failedCells: [],
    rowsOnlyInActual: [], rowsOnlyInExpected: [],
  };
  if (!actual || !expected) {
    return { ...base, note: !actual ? "no actual table" : "no reference table" };
  }

  const indexRows = (t: TableModel) => {
    const idx = new Map<string, { label: string; cells: any[] }>();
    for (const row of t.rows || []) {
      const label = String((row || [])[0] ?? "").trim();
      const key = normLabel(label);
      if (!key) continue;
      if (!idx.has(key)) idx.set(key, { label, cells: row });
    }
    return idx;
  };

  const aIdx = indexRows(actual);
  const eIdx = indexRows(expected);
  const aCols = (actual.columns || []).map((c) => normLabel(c));
  const eCols = (expected.columns || []).map((c) => normLabel(c));

  const colKey = (c: any) => String(c ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const eColsKey = eCols.map(colKey);
  const expectedHasHeaders = eCols.some((c) => c && !/^col[\s_]?\d+$/i.test(String(c)));
  const actualHasHeaders = aCols.some((c) => c && !/^col[\s_]?\d+$/i.test(String(c)));
  const unmatchedCols: string[] = [];
  const missingExpectedCols: string[] = [];

  const failedCells: CellDiff[] = [];
  const skippedRows: string[] = [];
  const skippedCols: string[] = [];
  let compared = 0;

  for (const [key, aRow] of aIdx) {
    if (skipChange && isChangeRow(aRow.label)) { skippedRows.push(aRow.label); continue; }
    const eRow = eIdx.get(key);
    if (!eRow) { base.rowsOnlyInActual.push(aRow.label); continue; }

    for (let ai = 1; ai < aRow.cells.length; ai++) {
      const colName = aCols[ai] ?? `col ${ai}`;
      // Show Data transposes a crosstab, so a delta metric arrives as a COLUMN.
      // Skip it for the same reason change rows are skipped.
      if (skipChange && isChangeRow(String((actual.columns || [])[ai] ?? colName))) {
        const cl = String((actual.columns || [])[ai] ?? colName);
        if (skippedCols.indexOf(cl) === -1) skippedCols.push(cl);
        continue;
      }
      // Positional fallback silently compared the wrong metric whenever the
      // reference had extra columns (prod vs QA) or a header was punctuated
      // differently ("Reach %" vs "Reach (%)"). Match by name, then by a
      // punctuation-insensitive name, and only guess by position when the
      // reference genuinely has no usable headers.
      let ei = eCols.indexOf(colName);
      if (ei === -1) ei = eColsKey.indexOf(colKey(colName));
      if (ei === -1) {
        if (expectedHasHeaders) {
          if (unmatchedCols.indexOf(colName) === -1) unmatchedCols.push(colName);
          continue;
        }
        ei = ai;
      }
      const aVal = aRow.cells[ai];
      const eVal = (eRow.cells || [])[ei];
      const aNum = parseCell(aVal);
      const eNum = parseCell(eVal);

      if (aNum != null && eNum != null) {
        compared++;
        if (!cellPasses(aNum, eNum, tol)) {
          failedCells.push({
            row: aRow.label,
            column: actual.columns?.[ai] ?? `Col ${ai}`,
            actual: aNum, expected: eNum,
            deltaPct: eNum !== 0 ? ((aNum - eNum) / Math.abs(eNum)) * 100 : null,
            reason: "out_of_tolerance",
          });
        }
        continue;
      }

      const aTxt = aVal == null ? "" : String(aVal).trim();
      const eTxt = eVal == null ? "" : String(eVal).trim();
      if (!aTxt && !eTxt) continue;
      compared++;
      if (aTxt !== eTxt) {
        failedCells.push({
          row: aRow.label,
          column: actual.columns?.[ai] ?? `Col ${ai}`,
          actual: aTxt || null, expected: eTxt || null, deltaPct: null,
          reason: !aTxt ? "missing_actual" : (!eTxt ? "missing_expected" : "text_mismatch"),
        });
      }
    }
  }

  for (const [key, eRow] of eIdx) {
    if (skipChange && isChangeRow(eRow.label)) continue;
    if (!aIdx.has(key)) base.rowsOnlyInExpected.push(eRow.label);
  }

  if (expectedHasHeaders && actualHasHeaders) {
    const aColsKey = aCols.map(colKey);
    for (let ei = 1; ei < eCols.length; ei++) {
      const expectedName = eCols[ei];
      if (skipChange && isChangeRow(String((expected.columns || [])[ei] ?? expectedName))) continue;
      if (
        aCols.indexOf(expectedName) === -1 &&
        aColsKey.indexOf(colKey(expectedName)) === -1
      ) {
        missingExpectedCols.push(String((expected.columns || [])[ei] ?? expectedName));
      }
    }
  }

  const structurallyOk = compared > 0;
  return {
    ...base,
    comparedCells: compared,
    skippedRows,
    skippedColumns: skippedCols,
    unmatchedColumns: unmatchedCols,
    missingExpectedColumns: missingExpectedCols,
    failedCells,
    pass:
      structurallyOk &&
      failedCells.length === 0 &&
      base.rowsOnlyInExpected.length === 0 &&
      missingExpectedCols.length === 0,
    note: structurallyOk ? undefined : "no comparable cells",
  };
}

export function summarizeTableCompare(r: TableCompareResult): string {
  if (r.note && !r.comparedCells) return r.note;
  const bits: string[] = [`${r.comparedCells} cell(s) compared`];
  if (r.failedCells.length) bits.push(`${r.failedCells.length} outside tolerance`);
  if (r.skippedRows.length) bits.push(`${r.skippedRows.length} change row(s) skipped`);
  if (r.skippedColumns && r.skippedColumns.length) bits.push(`${r.skippedColumns.length} change column(s) skipped`);
  if (r.rowsOnlyInExpected.length) bits.push(`${r.rowsOnlyInExpected.length} row(s) missing from actual`);
  if (r.rowsOnlyInActual.length) bits.push(`${r.rowsOnlyInActual.length} extra row(s)`);
  if (r.missingExpectedColumns?.length) bits.push(`${r.missingExpectedColumns.length} column(s) missing from actual`);
  return bits.join(", ");
}

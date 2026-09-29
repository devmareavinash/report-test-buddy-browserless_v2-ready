/**
 * Cell-wise comparison for GRID and GRAPH (Show Data) results.
 *
 * Before this, both went through `JSON.stringify(a) === JSON.stringify(b)`:
 * the configured comparator ("actual <= reference") and the tolerance were
 * ignored, and any single differing cell failed the whole visual with one
 * opaque FAIL and no indication of which cell broke.
 *
 * This module aligns the two tables by row label + column header, applies the
 * same op/tolerance rules used for scalar KPIs to each numeric cell, and
 * returns the failing cells so the UI can show them.
 *
 * Shared by the UI (ScenarioDetail / RunScenarioCard) and mirrored in
 * agent-orchestrate so stored status and on-screen status agree.
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

/**
 * Rows that track a period-over-period DELTA rather than a level.
 * A change row legitimately flips sign between environments (e.g. NBRx Change
 * -5,230 vs -4,440), so an inequality comparator is meaningless for it and it
 * would fail every run. These are reported as skipped, not as failures.
 */
const CHANGE_ROW_RE = /\b(change|chg|delta|diff|difference|variance|var|growth|vs\.?\s*(prev|previous|prior|ly|py))\b/i;

export function isChangeRow(label: string): boolean {
  return CHANGE_ROW_RE.test(String(label || ""));
}

/** "4,957.0" -> 4957.0 ; "(5,230)" -> -5230 ; "65.5%" -> 65.5 ; "" -> null */
export function parseCell(v: any): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = String(v).trim();
  if (!s || s === "-" || s === "--" || s === "N/A" || s.toLowerCase() === "null") return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }      // accounting negatives
  s = s.replace(/[,\s$%]/g, "");
  if (s.startsWith("-")) { neg = true; s = s.slice(1); }
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

const normLabel = (s: any) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/** Same rule as scalar KPIs, so a grid cell and a tile behave identically. */
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

type RowIndex = Map<string, { label: string; cells: any[] }>;

function indexRows(t: TableModel): RowIndex {
  const idx: RowIndex = new Map();
  for (const row of t.rows || []) {
    const label = String((row || [])[0] ?? "").trim();
    const key = normLabel(label);
    if (!key) continue;
    if (!idx.has(key)) idx.set(key, { label, cells: row });
  }
  return idx;
}

/**
 * Compare two tables cell by cell.
 *
 * - Rows are matched by their first-column label, columns by header text, so
 *   column reordering or an extra column does not fail everything.
 * - Non-numeric cells are compared as trimmed text.
 * - Change/delta rows are skipped (see isChangeRow).
 */
export function compareTables(
  actual: TableModel | null,
  expected: TableModel | null,
  tol?: Tolerance,
  opts?: { skipChangeRows?: boolean },
): TableCompareResult {
  const skipChange = opts?.skipChangeRows !== false;   // default: skip
  const base: TableCompareResult = {
    pass: false, comparedCells: 0, skippedRows: [], skippedColumns: [], failedCells: [],
    rowsOnlyInActual: [], rowsOnlyInExpected: [],
  };

  if (!actual || !expected) {
    return { ...base, note: !actual ? "no actual table" : "no reference table" };
  }

  const aIdx = indexRows(actual);
  const eIdx = indexRows(expected);

  // Column header -> position, per side (headers can differ in order).
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

    // Compare every column except the label column (index 0).
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
      }                      // fall back to position
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
            actual: aNum,
            expected: eNum,
            deltaPct: eNum !== 0 ? ((aNum - eNum) / Math.abs(eNum)) * 100 : null,
            reason: "out_of_tolerance",
          });
        }
        continue;
      }

      const aTxt = aVal == null ? "" : String(aVal).trim();
      const eTxt = eVal == null ? "" : String(eVal).trim();
      if (!aTxt && !eTxt) continue;                 // both blank: nothing to check
      compared++;
      if (aTxt !== eTxt) {
        failedCells.push({
          row: aRow.label,
          column: actual.columns?.[ai] ?? `Col ${ai}`,
          actual: aTxt || null,
          expected: eTxt || null,
          deltaPct: null,
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

  // A table with no comparable cells must not silently pass.
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

/** One-line summary for the Result column / tooltips. */
export function summarizeTableCompare(r: TableCompareResult): string {
  if (r.note && !r.comparedCells) return r.note;
  const bits: string[] = [];
  bits.push(`${r.comparedCells} cell(s) compared`);
  if (r.failedCells.length) bits.push(`${r.failedCells.length} outside tolerance`);
  if (r.skippedRows.length) bits.push(`${r.skippedRows.length} change row(s) skipped`);
  if (r.skippedColumns && r.skippedColumns.length) bits.push(`${r.skippedColumns.length} change column(s) skipped`);
  if (r.rowsOnlyInExpected.length) bits.push(`${r.rowsOnlyInExpected.length} row(s) missing from actual`);
  if (r.rowsOnlyInActual.length) bits.push(`${r.rowsOnlyInActual.length} extra row(s)`);
  if (r.missingExpectedColumns?.length) bits.push(`${r.missingExpectedColumns.length} column(s) missing from actual`);
  return bits.join(", ");
}

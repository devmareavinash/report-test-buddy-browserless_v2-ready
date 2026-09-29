/** Shared Show Data / chart table renderer for Latest result and Runs. */

const SKIP_COL = /^(via|__)/i;
const EMPTY_COL = /^col_\d+$/i;

function columnLabel(c: any, i: number) {
  if (c == null) return `Col ${i + 1}`;
  if (typeof c === "string" || typeof c === "number") return String(c);
  return String(c.name || c.label || c.title || c.key || `Col ${i + 1}`);
}

function recordsToTable(records: any[]): { columns: string[]; rows: any[][] } | null {
  if (!records?.length || typeof records[0] !== "object" || Array.isArray(records[0])) return null;
  const columns: string[] = [];
  for (const rec of records) {
    for (const k of Object.keys(rec || {})) {
      if (SKIP_COL.test(k) || EMPTY_COL.test(k)) continue;
      if (!columns.includes(k)) columns.push(k);
    }
  }
  if (!columns.length) return null;
  return { columns, rows: records.map((rec) => columns.map((c) => rec?.[c] ?? "")) };
}

export function toTableModel(v: any): { columns: string[]; rows: any[][] } | null {
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
    const inner = toTableModel(nested);
    if (inner) return inner;
  }

  if (Array.isArray(v.rows)) {
    if (v.rows[0] && typeof v.rows[0] === "object" && !Array.isArray(v.rows[0])) {
      return recordsToTable(v.rows);
    }
    if (Array.isArray(v.rows[0])) {
      const rawCols = Array.isArray(v.headers)
        ? (v.headers as any[]).map(columnLabel)
        : Array.isArray(v.columns) ? (v.columns as any[]).map(columnLabel) : null;
      const keep = (rawCols || []).map((h, i) => {
        if (i === 0 && EMPTY_COL.test(h) && (v.rows || []).some((r: any) => r?.[0] && !/^[\d,.%()\s-]+$/.test(String(r[0])))) {
          return "Metric";
        }
        return EMPTY_COL.test(h) ? null : h;
      });
      const cols = keep.filter((h): h is string => !!h);
      const idx = keep.map((h, i) => (h ? i : -1)).filter((i) => i >= 0);
      if (cols.length) {
        return { columns: cols, rows: (v.rows as any[][]).map((row) => idx.map((i) => row?.[i])) };
      }
      return toTableModel(v.rows);
    }
  }
  return null;
}

export function isChartTable(v: any): boolean {
  return !!toTableModel(v);
}

export function MiniDataTable({ columns, rows, large }: { columns: string[]; rows: any[][]; large?: boolean }) {
  return (
    <div className={`${large ? "max-h-96" : "max-h-64"} max-w-full overflow-auto rounded border border-border bg-background`}>
      <table className="w-max min-w-full text-[11px] leading-tight">
        <thead className="sticky top-0 bg-secondary/80 text-muted-foreground">
          <tr>
            {columns.map((c) => (
              <th key={c} className="text-left px-2 py-1 font-medium whitespace-nowrap">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-t border-border/70">
              {columns.map((_, j) => (
                <td key={j} className="px-2 py-0.5 mono whitespace-nowrap">
                  {row?.[j] == null || row?.[j] === "" ? "" : String(row[j])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function GridComparePanels({
  actual, expected, leftLabel, rightLabel, hideExpected,
}: {
  actual: any;
  expected: any;
  leftLabel: string;
  rightLabel?: string;
  hideExpected?: boolean;
}) {
  const a = toTableModel(actual);
  const e = toTableModel(expected);
  if (hideExpected) {
    return a ? <MiniDataTable columns={a.columns} rows={a.rows} large /> : (
      <div className="text-muted-foreground text-[11px]">No grid data</div>
    );
  }
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 w-full min-w-0">
      <div className="min-w-0 space-y-1">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{leftLabel}</div>
        {a ? <MiniDataTable columns={a.columns} rows={a.rows} large /> : (
          <div className="text-muted-foreground text-[11px] border border-dashed border-border rounded p-2">No grid data</div>
        )}
      </div>
      <div className="min-w-0 space-y-1">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{rightLabel || "Reference"}</div>
        {e ? <MiniDataTable columns={e.columns} rows={e.rows} large /> : (
          <div className="text-muted-foreground text-[11px] border border-dashed border-border rounded p-2">No grid data</div>
        )}
      </div>
    </div>
  );
}

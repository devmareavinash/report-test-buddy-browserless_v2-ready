import { useEffect } from "react";
import { GridComparePanels, isChartTable, toTableModel } from "@/components/KpiGrid";
import { deriveStoredResultRows, resolveKpiTol, storedKpiSpec, type StoredResultStatus } from "@/lib/kpi-values";
import { compareTables, summarizeTableCompare } from "@/lib/tableCompare";
import { pickTrendView } from "@/lib/trend-payload";

function fmt(v: any): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return v.toLocaleString();
  if (typeof v === "string") return v;
  return "—";
}

function badge(s: "pass" | "fail" | "pending") {
  const cls = s === "pass"
    ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
    : s === "fail"
    ? "bg-destructive/15 text-destructive border-destructive/30"
    : "bg-secondary text-muted-foreground border-border";
  return <span className={`mono uppercase text-[10px] px-1.5 py-0.5 rounded border ${cls}`}>{s}</span>;
}

function compareSymbol(op?: string) {
  if (op === "lte") return "≤";
  if (op === "gte") return "≥";
  if (op === "gt") return ">";
  if (op === "lt") return "<";
  return "=";
}

function extractionErrorLabel(error?: string | null) {
  if (error === "no_value") return "Actual value was not extracted";
  if (error === "no_expected_value") return "Reference value was not extracted";
  if (error === "no_expected_grid") return "Reference grid was not extracted";
  return error ? error.replace(/_/g, " ") : "";
}

export function StoredResultTable({
  actual,
  expected,
  spec,
  scenarioType,
  status,
  diff,
  onDerivedStatusChange,
}: {
  actual: any;
  expected: any;
  spec?: any;
  scenarioType?: string;
  status?: string | null;
  diff?: any;
  onDerivedStatusChange?: (status: StoredResultStatus) => void;
}) {
  const isTrend = String(scenarioType || "").toLowerCase() === "trend";
  const isRef = String(scenarioType || "").toLowerCase() === "reference_match";
  const effectiveSpec = storedKpiSpec(actual, spec);
  const tols = effectiveSpec.kpi_tolerances || {};
  const derived = deriveStoredResultRows({ actual, expected, spec, scenarioType, diff, fallbackStatus: status });
  const rows = derived.rows;

  useEffect(() => {
    onDerivedStatusChange?.(derived.status);
  }, [derived.status, onDerivedStatusChange]);

  const trend = isTrend
    ? pickTrendView(actual, actual?.values, actual?.extracted, actual?.extracted?.result, expected, diff)
    : null;
  const grains = trend?.grains || [];
  const expectedLabel = isTrend ? "Required" : isRef ? "Reference URL" : "Expected (BE / SQL)";

  if (isTrend && grains.length) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Overall Status:</span>
          {badge((status as any) || "pending")}
          <span className="text-muted-foreground">consecutive week / month / quarter periods</span>
        </div>
        {grains.map((g) => {
          const periods = g.periods || [];
          const missing = g.missing || [];
          const gPass = g.consecutive === true || g.score === 1;
          const gFail = g.consecutive === false || g.score === 0 || missing.length > 0 || !!g.trend_error;
          const gStatus: "pass" | "fail" | "pending" = gPass && !gFail ? "pass" : gFail ? "fail" : "pending";
          return (
            <div key={g.name} className="border border-border rounded p-2 space-y-1">
              <div className="flex items-center gap-2">
                <span className="font-semibold mono">{g.name}</span>
                {badge(gStatus)}
                <span className="text-muted-foreground">{periods.length} period{periods.length === 1 ? "" : "s"}</span>
              </div>
              {g.trend_error && <div className="text-destructive">{g.trend_error}</div>}
              {periods.length ? (
                <div className="flex flex-wrap gap-1">
                  {periods.map((p, i) => (
                    <span key={`${p}-${i}`} className="mono px-1.5 py-0.5 rounded border border-border bg-background">
                      {p}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="text-muted-foreground">No period labels stored for this grain.</div>
              )}
              {!!missing.length && (
                <div className="text-destructive">Missing: {missing.join(", ")}</div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  if (isTrend) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Overall Status:</span>
          {badge((status as any) || "pending")}
          <span className="text-muted-foreground">consecutive week / month / quarter periods</span>
        </div>
        <div className="text-muted-foreground">
          No Weekly / Monthly / Quarterly periods were stored on this run. Re-run headless to populate grain details.
        </div>
      </div>
    );
  }

  if (!rows.length) {
    return <div className="text-muted-foreground">No KPI values extracted yet.</div>;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">Overall Status:</span>
        {badge(derived.status)}
      </div>
      <div className="border border-border rounded overflow-hidden bg-background">
        <table className="w-full text-xs">
          <thead className="bg-secondary/40 text-muted-foreground">
            <tr>
              <th className="text-left p-2">KPI</th>
              <th className="text-left p-2">Actual (UI main report)</th>
              <th className="text-left p-2">{expectedLabel}</th>
              <th className="text-left p-2">Diff</th>
              <th className="text-left p-2">Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.k} className={`border-t border-border ${r.pass === false ? "bg-destructive/5" : ""}`}>
                <td className="p-2 mono align-top">{r.k}</td>
                {isChartTable(r.a) || isChartTable(r.e) ? (
                  <td className="p-2 align-top" colSpan={2}>
                    <GridComparePanels
                      actual={r.a}
                      expected={r.e}
                      leftLabel="Actual (UI main report)"
                      rightLabel={expectedLabel}
                    />
                  </td>
                ) : (
                  <>
                    <td className="p-2 align-top mono font-semibold">{fmt(r.a)}</td>
                    <td className="p-2 align-top mono font-semibold">{fmt(r.e)}</td>
                  </>
                )}
                <td className="p-2 mono align-top">
                  {r.error ? (
                    <span className="text-destructive">{extractionErrorLabel(r.error)}</span>
                  ) : r.diff !== null ? (
                    <span className={r.pass === false ? "text-destructive" : "text-muted-foreground"}>
                      {r.diff > 0 ? "+" : ""}{fmt(r.diff)}
                      {r.deltaPct !== null && (
                        <span className="ml-1">({r.deltaPct > 0 ? "+" : ""}{r.deltaPct.toFixed(2)}%)</span>
                      )}
                    </span>
                  ) : (() => {
                    // Grid / graph: name the offending cells instead of a bare "≠".
                    const tc = (isChartTable(r.a) && isChartTable(r.e))
                      ? compareTables(
                          toTableModel(r.a) as any,
                          toTableModel(r.e) as any,
                          resolveKpiTol(tols, r.k) as any,
                          { skipChangeRows: true },
                        )
                      : null;
                    if (!tc) {
                      return (
                        <span className="text-muted-foreground">
                          {r.pass === false ? "≠" : r.pass === true ? compareSymbol(resolveKpiTol(tols, r.k).op) : "—"}
                        </span>
                      );
                    }
                    return (
                      <div className="space-y-0.5">
                        <div className="text-[10px] text-muted-foreground">{summarizeTableCompare(tc)}</div>
                        {tc.failedCells.slice(0, 5).map((c, ci) => (
                          <div key={ci} className="text-[10px] text-destructive whitespace-nowrap">
                            {c.row} / {c.column}: {fmt(c.actual)} vs {fmt(c.expected)}
                            {c.deltaPct !== null && ` (${c.deltaPct > 0 ? "+" : ""}${c.deltaPct.toFixed(1)}%)`}
                          </div>
                        ))}
                        {tc.failedCells.length > 5 && (
                          <div className="text-[10px] text-muted-foreground">+{tc.failedCells.length - 5} more</div>
                        )}
                      </div>
                    );
                  })()}
                </td>
                <td className="p-2 align-top">{r.pass === null ? badge("pending") : r.pass ? badge("pass") : badge("fail")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

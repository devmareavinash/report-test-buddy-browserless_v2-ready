import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { invokeFunction } from "@/lib/functions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { StatusChip } from "@/components/StatusChip";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ChevronDown, ChevronRight, Wrench, Pencil, Clock, Save, History } from "lucide-react";
import { toast } from "sonner";
import { GridComparePanels, isChartTable, toTableModel } from "@/components/KpiGrid";
import { compareTables, summarizeTableCompare } from "@/lib/tableCompare";
import { pickTrendView } from "@/lib/trend-payload";
import { fetchCanonicalScript } from "@/lib/canonicalScript";
import { configuredKpiNames, isKpiValueNoise, lookupStoredKpiValue } from "@/lib/kpi-values";

type TR = {
  id: string;
  scenario_id: string;
  run_id: string;
  status: string;
  criticality?: string | null;
  severity?: string | null;
  analysis?: string | null;
  expected?: any;
  actual?: any;
  diff?: any;
  healing_status?: string | null;
  healing_proposal?: any;
  screenshot_url?: string | null;
  created_at: string;
};

type Props = {
  scenarioId: string;
  scenarioTitle: string;
  scenarioType: string; // warehouse_match | reference_match | trend | range_check | functional
  scenarioMeta?: string;
  results: TR[]; // one per combo, may be length 1
  defaultOpen?: boolean;
  onChanged?: () => void;
};

const toNum = (v: any): number => {
  if (v === null || v === undefined) return NaN;
  if (typeof v === "number") return v;
  const n = Number(String(v).replace(/[,\s%$]/g, ""));
  return Number.isFinite(n) ? n : NaN;
};

const fmt = (v: any): string => {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return v.toLocaleString();
  if (typeof v === "string") return v;
  return JSON.stringify(v);
};

/**
 * Refresh-date values ("Sep 11 - 2026", "6/30/2026", "2026-09-11").
 * These must never be numeric-coerced: stripping non-digits leaves "11-2026"
 * and parseFloat yields 11, which is why the table showed a bare day number.
 */
const DATE_VALUE_RE = new RegExp(
  [
    String.raw`\d{1,2}\s*[\/.\-]\s*\d{1,2}\s*[\/.\-]\s*\d{2,4}`,
    String.raw`[A-Za-z]{3,9}\.?\s+\d{1,2}\s*[-,]?\s*\d{2,4}`,
    String.raw`\d{1,2}\s+[A-Za-z]{3,9}\.?\s*[-,]?\s*\d{2,4}`,
    String.raw`\d{4}-\d{2}-\d{2}`,
  ].join("|"),
  "i",
);
const looksLikeDateValue = (v: any): boolean =>
  typeof v === "string" && !!v.trim() && DATE_VALUE_RE.test(v.trim());

const overall = (results: TR[]): "pass" | "fail" | "pending" => {
  if (!results.length) return "pending";
  if (results.some((r) => r.status === "fail")) return "fail";
  if (results.every((r) => r.status === "pass")) return "pass";
  return "pending";
};

const badge = (s: "pass" | "fail" | "pending") => {
  const cls =
    s === "pass"
      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
      : s === "fail"
      ? "bg-destructive/15 text-destructive border-destructive/30"
      : "bg-secondary text-muted-foreground border-border";
  return (
    <span className={`mono uppercase text-[10px] px-1.5 py-0.5 rounded border ${cls}`}>
      {s}
    </span>
  );
};

export function RunScenarioCard({
  scenarioId,
  scenarioTitle,
  scenarioType,
  scenarioMeta,
  results,
  defaultOpen,
  onChanged,
}: Props) {
  const [open, setOpen] = useState(!!defaultOpen);
  const latest = results[0];

  const proposeFix = async (trId: string) => {
    toast.loading("Generating proposal…", { id: trId });
    try {
      const { error } = await invokeFunction("agent-heal", { test_result_id: trId });
      if (error) throw error;
      toast.success("Healing proposal ready", { id: trId });
      onChanged?.();
    } catch (e: any) {
      toast.error(e.message || "Failed", { id: trId });
    }
  };

  const defer = async () => {
    await supabase.from("scenarios").update({ deferred: true }).eq("id", scenarioId);
    toast.success("Deferred — agent will skip in future runs");
    onChanged?.();
  };

  const saveRca = async (trId: string, body: string) => {
    if (!body.trim()) return;
    await supabase.from("test_results").update({ analysis: body }).eq("id", trId);
    toast.success("RCA updated");
    onChanged?.();
  };

  const overallStatus = overall(results);

  return (
    <div className="border border-border rounded-md">
      <div className="flex items-center gap-3 p-3">
        <button
          onClick={() => setOpen(!open)}
          className="text-muted-foreground hover:text-foreground"
        >
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <StatusChip status={overallStatus} />
        {(latest?.criticality || latest?.severity) && (
          <StatusChip status={(latest.criticality || latest.severity) as string} />
        )}
        <div className="flex-1 min-w-0">
          <Link
            to={`/scenarios/${scenarioId}`}
            className="text-sm font-medium hover:text-accent block truncate"
          >
            {scenarioTitle}
          </Link>
          {scenarioMeta && (
            <div className="text-xs text-muted-foreground mono truncate">{scenarioMeta}</div>
          )}
        </div>
        <div className="text-xs text-muted-foreground whitespace-nowrap">
          {results.length} combo{results.length === 1 ? "" : "s"}
        </div>
        <div className="text-xs text-muted-foreground mono whitespace-nowrap">
          {latest?.created_at ? new Date(latest.created_at).toLocaleString() : "—"}
        </div>
      </div>

      {open && (
        <div className="border-t border-border bg-secondary/20 p-3 space-y-3 text-xs">
          <ScenarioResultTable results={results} scenarioType={scenarioType} scenarioId={scenarioId} />
          <ScenarioKpiTolerancesReadOnly scenarioId={scenarioId} scenarioType={scenarioType} results={results} />

          {latest?.analysis && (
            <div>
              <span className="text-muted-foreground mono">RCA: </span>
              <span>{latest.analysis}</span>
            </div>
          )}
          {latest?.healing_proposal && (
            <div className="border border-border rounded-md p-2 bg-background/40">
              <div className="text-muted-foreground mono mb-1">
                Proposed fix · status: {latest.healing_status || "proposed"}
              </div>
              {latest.healing_proposal.rationale && <div>{latest.healing_proposal.rationale}</div>}
              {latest.healing_proposal.patched_playwright_code && (
                <pre className="mono text-[10px] mt-1 whitespace-pre-wrap">
                  {latest.healing_proposal.patched_playwright_code}
                </pre>
              )}
            </div>
          )}
          {latest?.screenshot_url && (
            <a
              href={latest.screenshot_url}
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
            >
              View screenshot →
            </a>
          )}
          {latest && <RcaEditor trId={latest.id} initial={latest.analysis || ""} onSave={saveRca} />}
          <div className="flex flex-wrap gap-2 pt-2 border-t border-border">
            {latest && (
              <Button size="sm" variant="outline" onClick={() => proposeFix(latest.id)}>
                <Wrench className="h-3 w-3 mr-1" /> Propose fix
              </Button>
            )}
            <Link to={`/scenarios/${scenarioId}`}>
              <Button size="sm" variant="outline">
                <Pencil className="h-3 w-3 mr-1" /> Update test scenario
              </Button>
            </Link>
            <Button size="sm" variant="outline" onClick={defer}>
              <Clock className="h-3 w-3 mr-1" /> Defer for future
            </Button>
            <HistoryToggle scenarioId={scenarioId} currentRunId={latest?.run_id} />
          </div>
        </div>
      )}
    </div>
  );
}

function ScenarioResultTable({
  results,
  scenarioType,
  scenarioId,
}: {
  results: TR[];
  scenarioType: string;
  scenarioId: string;
}) {
  const { data: script } = useQuery({
    queryKey: ["scenario-tolerances", scenarioId],
    queryFn: async () =>
      (await fetchCanonicalScript(scenarioId, "assertion_spec")).data,
  });
  const currentKpiTol: Record<string, any> =
    ((script as any)?.assertion_spec || {}).kpi_tolerances || {};
  const configuredFromCase = configuredKpiNames(
    (script as any)?.assertion_spec || {},
  );

  const isReference = scenarioType === "reference_match";
  const isWarehouse = scenarioType === "warehouse_match";
  const isTrend = scenarioType === "trend";
  const isRange = scenarioType === "range_check";


  // Column labels by type
  const actualLabel = "Actual (UI main report)";
  const expectedLabel = isReference
    ? "Reference URL"
    : isWarehouse
    ? "Expected (BE / SQL)"
    : isTrend
    ? "Trend baseline"
    : isRange
    ? "Range"
    : "Expected";

  if (!results.length) {
    return <div className="text-muted-foreground">No execution recorded.</div>;
  }

  // Build flat rows: one row per (combo × kpi)
  type Row = {
    comboLabel: string;
    comboIdx: number;
    filters_applied: any;
    kpi: string;
    actual: any;
    expected: any;
    diff: number | null;
    deltaPct: number | null;
    pass: boolean | null;
    /** Cell-wise result for grid/graph rows; null for scalar KPIs. */
    tableCompare: ReturnType<typeof compareTables> | null;
    rowsInCombo: number;
    isFirstInCombo: boolean;
    overall: "pass" | "fail" | "pending";
  };
  const allRows: Row[] = [];
  const errorBanners: { comboLabel: string; message: string; kind: string }[] = [];
  const SKIP_KEYS = new Set([
    "error", "message", "filter", "filters_applied", "source", "where_clause", "sql", "row",
    "periods", "missing", "unparsed_periods", "consecutive", "trend_error", "time_grain",
    "tableData", "tabledata", "show_data_debug", "show_data_error", "extract_via",
    "first_col0", "selected_grain", "time_grain_click", "grain_retries", "navigation",
    "headers", "grains",
  ]);
  results.forEach((tr, idx) => {
    // Per-run tolerance snapshot (set by agent-orchestrate at execution time).
    // Falls back to the script's current tolerances for legacy rows that have no snapshot.
    const snapshotTol = (tr.actual && typeof tr.actual === "object" && tr.actual.tolerances_snapshot && typeof tr.actual.tolerances_snapshot === "object")
      ? tr.actual.tolerances_snapshot as Record<string, any>
      : null;
    const kpiTol: Record<string, any> = snapshotTol || currentKpiTol;
    const comboLabel = (tr.actual?.filter || tr.expected?.filter || `Filter #${idx + 1}`) as string;

    // Surface synthetic errors (script-gen failure, scrape failure, etc.) as a
    // banner ABOVE the table instead of rendering them as a fake "error" KPI row.
    const actualErr =
      (tr.actual && typeof tr.actual === "object" && (tr.actual.error || tr.actual.message)) || null;
    const expectedErr =
      (tr.expected && typeof tr.expected === "object" &&
        tr.expected.error && tr.expected.error !== "script_generation_failed" &&
        (tr.expected.error || tr.expected.message)) || null;
    if (actualErr || expectedErr) {
      const kind =
        tr.expected?.error === "script_generation_failed"
          ? "Script generation failed"
          : tr.expected?.source === "scrape"
          ? "Scrape failed"
          : "Execution error";
      errorBanners.push({
        comboLabel,
        kind,
        message: String(actualErr || expectedErr || "Unknown error"),
      });
    }

    const actualValues = (tr.actual?.values || (tr.actual && typeof tr.actual === "object" ? tr.actual : {})) as Record<string, any>;
    const expectedValues = (tr.expected?.values || {}) as Record<string, any>;
    const diff = (tr.diff || {}) as Record<string, any>;
    const keepKey = (k: string) => {
      if (!k || k.startsWith("__") || SKIP_KEYS.has(k) || isKpiValueNoise(k)) return false;
      return !/(?:^|_)(grid_ready|show_data|show_data_debug|show_data_error|open_result|navigation|filters_applied|popup_debug|debug)$/i.test(k);
    };
    const configuredCandidates = (
      configuredFromCase.length
        ? configuredFromCase
        : Object.keys(kpiTol || {})
    ).filter(keepKey);
    const availableKeys = Array.from(
      new Set([
        ...Object.keys(actualValues).filter(keepKey),
        ...Object.keys(expectedValues).filter(keepKey),
      ]),
    );
    const configured = configuredCandidates.some((k) =>
      lookupStoredKpiValue(actualValues, k) !== undefined ||
      lookupStoredKpiValue(expectedValues, k) !== undefined
    )
      ? configuredCandidates
      : [];
    const trendKeys = [
      "Trend check Weekly",
      "Trend check Monthly",
      "Trend check Quarterly",
      "Trend check",
    ].filter((k) => actualValues[k] != null || expectedValues[k] != null);
    const keys = isTrend
      ? (trendKeys.length ? trendKeys : configured.filter((k) => /^Trend check/i.test(k)))
      : configured.length
      ? configured
      : Array.from(
          new Set(availableKeys),
        );
    if (!keys.length && (actualErr || expectedErr)) {
      // Pure error row — no KPI cells to render for this combo.
      return;
    }
    const safeKeys = keys.length ? keys : ["—"];
    const perKeyPass: (boolean | null)[] = [];
    safeKeys.forEach((k, ki) => {
      const a = lookupStoredKpiValue(actualValues, k);
      const e = lookupStoredKpiValue(expectedValues, k);
      const aN = toNum(a);
      const eN = toNum(e);
      const both = Number.isFinite(aN) && Number.isFinite(eN);
      const d = both ? aN - eN : null;
      const pct = both && eN !== 0 ? (d! / Math.abs(eN)) * 100 : (diff?.[k]?.pct ?? null);

      // Tolerance-aware pass evaluation using saved kpi_tolerances
      const tEntry = kpiTol[k];
      const tVal =
        typeof tEntry === "object" && tEntry ? Number(tEntry.value) : Number(tEntry);
      const tUnit = (typeof tEntry === "object" && tEntry?.unit) || "pct";
      const tOp = (typeof tEntry === "object" && tEntry?.op) || "eq";
      let pass: boolean | null = null;
      // Populated for grid/graph rows so the Diff column can name the failing cells.
      let tableCompare: ReturnType<typeof compareTables> | null = null;
      if (diff?.[k]?.error) pass = false;
      else if (both) {
        const allowed = Number.isFinite(tVal)
          ? tUnit === "abs"
            ? Math.abs(tVal)
            : (Math.abs(tVal) / 100) * Math.abs(eN)
          : 0; // no tolerance configured → require exact match
        if (tOp === "lte") pass = d! - allowed <= 0;
        else if (tOp === "gte") pass = -d! - allowed <= 0;
        else if (tOp === "gt") pass = d! - allowed > 0;
        else if (tOp === "lt") pass = -d! - allowed > 0;
        else pass = Math.abs(d!) <= allowed;
      } else if (isTrend) {
        const consecutive = actualValues.consecutive === true || actualValues["Trend check"] === 1 || a === 1;
        const failed = actualValues.consecutive === false || actualValues["Trend check"] === 0 || a === 0
          || (Array.isArray(actualValues.missing) && actualValues.missing.length > 0);
        if (k === "Trend check" || k === "consecutive") pass = consecutive && !failed;
        else if (a != null && e == null) pass = consecutive && !failed;
      }
      else if (isChartTable(a) && isChartTable(e)) {
        // Grid / graph Show Data: cell-wise so the saved comparator + tolerance
        // apply (JSON equality ignored both and failed on any single cell).
        // Change/delta rows are skipped -- see tableCompare.isChangeRow.
        const ta = toTableModel(a);
        const te = toTableModel(e);
        const cmp = compareTables(ta as any, te as any, {
          value: Number.isFinite(tVal) ? tVal : 0,
          unit: tUnit === "abs" ? "abs" : "pct",
          op: tOp as any,
        }, { skipChangeRows: true });
        pass = cmp.pass;
        tableCompare = cmp;
      }
      else if (looksLikeDateValue(a) || looksLikeDateValue(e)) {
        // Refresh dates are text, not numbers. toNum() would turn
        // "Sep 11 - 2026" into 11, so compare the normalized strings.
        const norm = (x: any) =>
          String(x ?? "").replace(/\s+/g, " ").replace(/\s*[-,]\s*/g, " ").trim().toLowerCase();
        pass = a == null || e == null ? null : norm(a) === norm(e);
      }
      else if (a != null && e == null) pass = null;
      perKeyPass.push(pass);
      allRows.push({
        comboLabel,
        comboIdx: idx,
        filters_applied: tr.actual?.filters_applied || null,
        kpi: k,
        actual: a,
        expected: e,
        diff: d,
        deltaPct: pct,
        pass,
        tableCompare,
        rowsInCombo: safeKeys.length,
        isFirstInCombo: ki === 0,
        overall: "pending",
      });
    });
    // Derive combo overall from per-KPI passes (tolerance-aware)
    const comboOverall: "pass" | "fail" | "pending" = perKeyPass.some((p) => p === false)
      ? "fail"
      : perKeyPass.every((p) => p === true)
      ? "pass"
      : "pending";
    // Backfill overall on rows we just pushed for this combo
    for (let j = allRows.length - safeKeys.length; j < allRows.length; j++) {
      allRows[j].overall = comboOverall;
    }
  });


  const overallStatus: "pass" | "fail" | "pending" = allRows.length
    ? allRows.some((r) => r.pass === false)
      ? "fail"
      : allRows.every((r) => r.pass === true)
      ? "pass"
      : "pending"
    : overall(results);

  const [openCombo, setOpenCombo] = useState<{ label: string; filters: any } | null>(null);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">Overall Status:</span>
        {badge(overallStatus)}
        <span className="text-muted-foreground ml-2">Type:</span>
        <span className="mono">{scenarioType}</span>
      </div>

      {isTrend && results.map((tr, idx) => {
        const view = pickTrendView(tr.actual, tr.actual?.values, tr.actual?.extracted, tr.diff);
        if (!view?.grains.length) return null;
        return (
          <div key={idx} className="border border-border rounded p-2 space-y-2 text-xs">
            <div className="text-muted-foreground">{String(tr.actual?.filter || `Filter #${idx + 1}`)}</div>
            {view.grains.map((b) => (
              <div key={String(b.name)} className="space-y-1">
                <div className="font-semibold mono">{String(b.name || "")}</div>
                {b.trend_error && <div className="text-destructive">{String(b.trend_error)}</div>}
                {!!(b.periods || []).length && (
                  <div className="flex flex-wrap gap-1">
                    {(b.periods || []).map((p: any, i: number) => (
                      <span key={i} className="mono px-1.5 py-0.5 rounded border border-border bg-secondary/40">{String(p)}</span>
                    ))}
                  </div>
                )}
                {!!(b.missing || []).length && (
                  <div className="text-destructive">Missing: {(b.missing || []).map(String).join(", ")}</div>
                )}
              </div>
            ))}
          </div>
        );
      })}

      {errorBanners.length > 0 && (
        <div className="space-y-2">
          {errorBanners.map((b, i) => (
            <div
              key={i}
              className="border border-destructive/40 bg-destructive/10 text-destructive rounded-md p-2 text-xs"
            >
              <div className="font-semibold mono">
                {b.comboLabel} · {b.kind}
              </div>
              <div className="mt-1 whitespace-pre-wrap break-words">{b.message}</div>
            </div>
          ))}
        </div>
      )}

      {allRows.length === 0 ? (
        <div className="text-muted-foreground text-xs">
          No KPI values were captured for this scenario.
        </div>
      ) : (

      <div className="border border-border rounded overflow-hidden">
        {(() => {
          const anyFilters = allRows.some(
            (r) =>
              r.filters_applied &&
              typeof r.filters_applied === "object" &&
              Object.keys(r.filters_applied).length > 0,
          );
          return (
        <table className="w-full text-xs">
          <thead className="bg-secondary/40 text-muted-foreground">
            <tr>
              {anyFilters && <th className="text-left p-2">Filter</th>}
              <th className="text-left p-2">KPI</th>
              <th className="text-left p-2">{actualLabel}</th>
              {!isTrend && <th className="text-left p-2">{expectedLabel}</th>}
              {!isTrend && <th className="text-left p-2">Diff</th>}
              <th className="text-left p-2">Result</th>
              <th className="text-left p-2">Overall</th>
            </tr>
          </thead>
          <tbody>
            {allRows.map((r, i) => {
              const hasFilters =
                r.filters_applied &&
                typeof r.filters_applied === "object" &&
                Object.keys(r.filters_applied).length > 0;
              return (
              <tr
                key={i}
                className={`border-t border-border ${r.pass === false ? "bg-destructive/5" : ""}`}
              >
                {anyFilters && r.isFirstInCombo && (
                  <td className="p-2 align-top" rowSpan={r.rowsInCombo}>
                    {hasFilters ? (
                      <button
                        className="text-accent hover:underline font-semibold text-left"
                        onClick={() =>
                          setOpenCombo({ label: r.comboLabel, filters: r.filters_applied })
                        }
                      >
                        {r.comboLabel}
                      </button>
                    ) : (
                      <div className="font-semibold">{r.comboLabel}</div>
                    )}
                  </td>
                )}
                <td className="p-2 mono align-top">{r.kpi}</td>
                {isChartTable(r.actual) || isChartTable(r.expected) ? (
                  <td className="p-2 align-top" colSpan={isTrend ? 1 : 2}>
                    <GridComparePanels
                      actual={r.actual}
                      expected={r.expected}
                      leftLabel={actualLabel}
                      rightLabel={expectedLabel}
                      hideExpected={isTrend}
                    />
                  </td>
                ) : (
                  <>
                    <td className="p-2 mono font-semibold align-top">{fmt(r.actual)}</td>
                    {!isTrend && <td className="p-2 mono font-semibold align-top">{fmt(r.expected)}</td>}
                  </>
                )}
                {!isTrend && (
                  <td className="p-2 mono align-top">
                    {r.diff !== null ? (
                      <span className={r.pass === false ? "text-destructive" : "text-muted-foreground"}>
                        {r.diff > 0 ? "+" : ""}
                        {fmt(r.diff)}
                        {r.deltaPct !== null && (
                          <span className="text-muted-foreground ml-1">
                            ({r.deltaPct > 0 ? "+" : ""}
                            {r.deltaPct.toFixed(2)}%)
                          </span>
                        )}
                      </span>
                    ) : (looksLikeDateValue(r.actual) || looksLikeDateValue(r.expected)) ? (
                      <span className={r.pass === false ? "text-destructive" : "text-muted-foreground"}>
                        {r.pass === false ? "different date" : r.pass === true ? "same date" : "—"}
                      </span>
                    ) : r.tableCompare ? (
                      /* Grid / graph: name the offending cells instead of a bare "≠". */
                      <div className="space-y-0.5">
                        <div className="text-[10px] text-muted-foreground">
                          {summarizeTableCompare(r.tableCompare)}
                        </div>
                        {r.tableCompare.failedCells.slice(0, 5).map((c, ci) => (
                          <div key={ci} className="text-[10px] text-destructive whitespace-nowrap">
                            {c.row} / {c.column}: {fmt(c.actual)} vs {fmt(c.expected)}
                            {c.deltaPct !== null && ` (${c.deltaPct > 0 ? "+" : ""}${c.deltaPct.toFixed(1)}%)`}
                          </div>
                        ))}
                        {r.tableCompare.failedCells.length > 5 && (
                          <div className="text-[10px] text-muted-foreground">
                            +{r.tableCompare.failedCells.length - 5} more
                          </div>
                        )}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">
                        {r.pass === false ? "≠" : r.pass === true ? "=" : "—"}
                      </span>
                    )}
                  </td>
                )}
                <td className="p-2">
                  {r.pass === null ? badge("pending") : r.pass ? badge("pass") : badge("fail")}
                </td>
                {r.isFirstInCombo && (
                  <td className="p-2 align-top" rowSpan={r.rowsInCombo}>
                    {badge(r.overall)}
                  </td>
                )}
              </tr>
              );
            })}
          </tbody>
        </table>
          );
        })()}
      </div>
      )}

      <Dialog open={!!openCombo} onOpenChange={(o) => !o && setOpenCombo(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{openCombo?.label}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-xs">
            {openCombo &&
              Object.entries(openCombo.filters || {}).map(([k, v]: any) => (
                <div key={k} className="flex items-start gap-2 border-b border-border pb-1">
                  <div className="font-semibold w-40 mono">{k}</div>
                  <div className="mono text-muted-foreground flex-1">
                    {typeof v === "object" ? v?.option ?? JSON.stringify(v) : String(v)}
                  </div>
                </div>
              ))}
            {openCombo && !Object.keys(openCombo.filters || {}).length && (
              <div className="text-muted-foreground">No filter values defined.</div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>

  );
}

function HistoryToggle({
  scenarioId,
  currentRunId,
}: {
  scenarioId: string;
  currentRunId?: string;
}) {
  const [show, setShow] = useState(false);
  const { data } = useQuery({
    queryKey: ["scenario-history", scenarioId, show],
    enabled: show,
    queryFn: async () =>
      (
        await supabase
          .from("test_results")
          .select("id, run_id, status, criticality, severity, analysis, created_at")
          .eq("scenario_id", scenarioId)
          .order("created_at", { ascending: false })
          .limit(50)
      ).data ?? [],
  });
  return (
    <div className="w-full">
      <Button size="sm" variant="ghost" onClick={() => setShow(!show)}>
        <History className="h-3 w-3 mr-1" /> {show ? "Hide history" : "View history"}
      </Button>
      {show && (
        <div className="mt-2 border border-border rounded-md divide-y divide-border">
          {(data || []).map((h: any) => (
            <Link
              key={h.id}
              to={`/runs/${h.run_id}`}
              className={`flex items-center gap-3 px-3 py-2 text-xs hover:bg-secondary/40 ${
                h.run_id === currentRunId ? "bg-accent/5" : ""
              }`}
            >
              <StatusChip status={h.status} />
              {(h.criticality || h.severity) && (
                <StatusChip status={h.criticality || h.severity} />
              )}
              <span className="mono text-muted-foreground">
                {new Date(h.created_at).toLocaleString()}
              </span>
              <span className="flex-1 min-w-0 truncate">{h.analysis || "—"}</span>
              <span className="mono text-muted-foreground">run {h.run_id?.slice(0, 8)}</span>
            </Link>
          ))}
          {!data?.length && (
            <div className="px-3 py-2 text-xs text-muted-foreground">No history.</div>
          )}
        </div>
      )}
    </div>
  );
}

function RcaEditor({
  trId,
  initial,
  onSave,
}: {
  trId: string;
  initial: string;
  onSave: (trId: string, body: string) => void | Promise<void>;
}) {
  const [val, setVal] = useState(initial);
  return (
    <div className="flex gap-2 items-start pt-2 border-t border-border">
      <Textarea
        value={val}
        onChange={(e) => setVal(e.target.value)}
        placeholder="Update RCA / analysis…"
        className="min-h-[60px] flex-1 text-xs"
      />
      <Button size="sm" variant="outline" onClick={() => onSave(trId, val)}>
        <Save className="h-3 w-3 mr-1" /> Save RCA
      </Button>
    </div>
  );
}

function ScenarioKpiTolerancesReadOnly({ scenarioId, scenarioType, results }: { scenarioId: string; scenarioType: string; results?: any[] }) {
  const { data: script } = useQuery({
    queryKey: ["scenario-tolerances", scenarioId],
    queryFn: async () =>
      (await fetchCanonicalScript(scenarioId, "assertion_spec")).data,
  });
  // Prefer the per-run tolerances_snapshot stored on the latest result for this run,
  // so the panel reflects what was applied at evaluation time (not the live script).
  const snapshot = (() => {
    if (!results || !results.length) return null;
    for (const r of results) {
      const snap = r?.actual?.tolerances_snapshot;
      if (snap && typeof snap === "object" && Object.keys(snap).length) return snap as Record<string, any>;
    }
    return null;
  })();
  const tol = snapshot || (((script as any)?.assertion_spec || {}).kpi_tolerances || {});
  const entries = Object.entries(tol);
  const opLabel = (op?: string) =>
    op === "lte" ? "actual ≤ reference"
    : op === "gte" ? "actual ≥ reference"
    : op === "gt" ? "actual > reference"
    : op === "lt" ? "actual < reference"
    : "actual = reference";

  const isRefMatch = scenarioType === "reference_match";
  let globalOp: string | undefined;
  if (isRefMatch) {
    const ops = entries
      .map(([, v]: any) => (typeof v === "object" ? v?.op : undefined))
      .filter(Boolean);
    globalOp = ops.length ? (ops.every((o) => o === ops[0]) ? ops[0] : undefined) : "eq";
  }

  return (
    <div className="border border-border rounded-md p-3 bg-background/40">
      <div className="flex items-center justify-between mb-2 gap-2">
        <div>
          <div className="text-xs font-semibold">KPI Tolerances</div>
          <div className="text-[10px] text-muted-foreground">Latest saved tolerances</div>
        </div>
        {isRefMatch && globalOp && (
          <div className="flex items-center gap-2 text-[11px]">
            <span className="text-muted-foreground">Condition (all KPIs):</span>
            <span className="mono font-semibold">{opLabel(globalOp)}</span>
          </div>
        )}
      </div>
      {!entries.length ? (
        <div className="text-[11px] text-muted-foreground">No KPI tolerances configured.</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
          {entries.map(([k, v]: any) => {
            const val = typeof v === "object" && v ? v.value : v;
            const unit = (typeof v === "object" && v?.unit) || "pct";
            const op = typeof v === "object" ? v?.op : undefined;
            return (
              <div
                key={k}
                className="flex items-center justify-between gap-2 text-[11px] border border-border rounded px-2 py-1.5 bg-secondary/30"
              >
                <span className="mono truncate" title={k}>{k}</span>
                <span className="mono font-semibold whitespace-nowrap">
                  ±{val ?? 0}
                  {unit === "abs" ? "" : "%"}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

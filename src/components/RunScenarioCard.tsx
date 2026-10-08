import { useMemo, useState } from "react";
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
import { StoredResultTable } from "@/components/StoredResultTable";
import { fetchCanonicalScript } from "@/lib/canonicalScript";
import { deriveStoredResultStatus } from "@/lib/kpi-values";

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

const overallFromStatuses = (statuses: Array<"pass" | "fail" | "pending">): "pass" | "fail" | "pending" => {
  if (!statuses.length) return "pending";
  if (statuses.some((s) => s === "fail")) return "fail";
  if (statuses.some((s) => s === "pending")) return "pending";
  return "pass";
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
  const { data: script } = useQuery({
    queryKey: ["scenario-tolerances", scenarioId],
    queryFn: async () =>
      (await fetchCanonicalScript(scenarioId, "assertion_spec")).data,
  });
  const spec = (script as any)?.assertion_spec;
  const resultsWithDerived = useMemo(() =>
    (results || []).map((r) => ({
      ...r,
      // Recalculate with this scenario's saved assertion spec so the summary
      // badge and expanded KPI table cannot disagree.
      derivedStatus: deriveStoredResultStatus({
          actual: r.actual,
          expected: r.expected,
          spec,
          scenarioType,
          diff: r.diff,
          fallbackStatus: r.status,
        }),
    })),
  [results, spec, scenarioType]);

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

  const overallStatus = overallFromStatuses(resultsWithDerived.map((r: any) => r.derivedStatus));
  const latestDerivedStatus = resultsWithDerived[0]?.derivedStatus || "pending";
  const showLatestFailureDetails = latestDerivedStatus !== "pass";

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
          {resultsWithDerived.length} combo{resultsWithDerived.length === 1 ? "" : "s"}
        </div>
        <div className="text-xs text-muted-foreground mono whitespace-nowrap">
          {latest?.created_at ? new Date(latest.created_at).toLocaleString() : "—"}
        </div>
      </div>

      {open && (
        <div className="border-t border-border bg-secondary/20 p-3 space-y-3 text-xs">
          <ScenarioResultTable results={resultsWithDerived} scenarioType={scenarioType} spec={spec} />
          <ScenarioKpiTolerancesReadOnly scenarioId={scenarioId} scenarioType={scenarioType} results={results} />

          {latest?.analysis && (
            <div>
              <span className="text-muted-foreground mono">RCA: </span>
              <span>{latest.analysis}</span>
            </div>
          )}
          {latest?.healing_proposal && showLatestFailureDetails && (
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
          {latest && showLatestFailureDetails && <RcaEditor trId={latest.id} initial={latest.analysis || ""} onSave={saveRca} />}
          <div className="flex flex-wrap gap-2 pt-2 border-t border-border">
            {latest && showLatestFailureDetails && (
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
  spec,
}: {
  results: Array<TR & { derivedStatus?: "pass" | "fail" | "pending" }>;
  scenarioType: string;
  spec?: any;
}) {
  const [openCombo, setOpenCombo] = useState<{ label: string; filters: any } | null>(null);

  if (!results.length) {
    return <div className="text-muted-foreground">No execution recorded.</div>;
  }

  const errorBanners = results.flatMap((tr, idx) => {
    const comboLabel = (tr.actual?.filter || tr.expected?.filter || `Filter #${idx + 1}`) as string;
    const actualErr =
      (tr.actual && typeof tr.actual === "object" && (tr.actual.error || tr.actual.message)) || null;
    const expectedErr =
      (tr.expected && typeof tr.expected === "object" &&
        tr.expected.error && tr.expected.error !== "script_generation_failed" &&
        (tr.expected.error || tr.expected.message)) || null;
    if (!actualErr && !expectedErr) return [];
    const kind =
      tr.expected?.error === "script_generation_failed"
        ? "Script generation failed"
        : tr.expected?.source === "scrape"
        ? "Scrape failed"
        : "Execution error";
    return [{ comboLabel, kind, message: String(actualErr || expectedErr || "Unknown error") }];
  });

  const anyFilters = results.some(
    (tr) =>
      tr.actual?.filters_applied &&
      typeof tr.actual.filters_applied === "object" &&
      Object.keys(tr.actual.filters_applied).length > 0,
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">Overall Status:</span>
        {badge(overallFromStatuses(results.map((r: any) => r.derivedStatus || r.status || "pending")))}
        <span className="text-muted-foreground ml-2">Type:</span>
        <span className="mono">{scenarioType}</span>
      </div>

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

      <div className="space-y-3">
        {results.map((tr, idx) => {
          const comboLabel = (tr.actual?.filter || tr.expected?.filter || `Filter #${idx + 1}`) as string;
          const filters = tr.actual?.filters_applied || null;
          const hasFilters = filters && typeof filters === "object" && Object.keys(filters).length > 0;
          return (
            <div key={tr.id || idx} className="border border-border rounded-md overflow-hidden bg-background/40">
              {(results.length > 1 || anyFilters) && (
                <div className="flex items-center gap-2 px-2 py-1 bg-secondary/40 border-b border-border text-xs">
                  {hasFilters ? (
                    <button
                      className="text-accent hover:underline font-semibold text-left"
                      onClick={() => setOpenCombo({ label: comboLabel, filters })}
                    >
                      {comboLabel}
                    </button>
                  ) : (
                    <span className="font-semibold">{comboLabel}</span>
                  )}
                  <span className="ml-auto">{badge((tr.derivedStatus as any) || (tr.status as any) || "pending")}</span>
                </div>
              )}
              <div className="p-2">
                <StoredResultTable
                  actual={tr.actual}
                  expected={tr.expected}
                  spec={spec}
                  scenarioType={scenarioType}
                  status={tr.derivedStatus || tr.status}
                  diff={tr.diff}
                />
              </div>
            </div>
          );
        })}
      </div>

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
            <span className="text-muted-foreground">Shared condition:</span>
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

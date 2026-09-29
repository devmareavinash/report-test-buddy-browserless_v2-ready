import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { invokeFunction } from "@/lib/functions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { StatusChip } from "@/components/StatusChip";
import { StoredResultTable } from "@/components/StoredResultTable";
import { storedRunLog, storedRunLogIsRca } from "@/lib/kpi-values";
import { fetchCanonicalScript } from "@/lib/canonicalScript";
import { ChevronDown, ChevronRight, Wrench, Pencil, Clock, Save, History, Play } from "lucide-react";
import { toast } from "sonner";
import { useExecutionLocks } from "@/hooks/useExecutionLocks";

type Props = {
  scenarioId: string;
  scenarioTitle: string;
  scenarioMeta?: string; // e.g. "Workstream / Report · type · criticality"
  scenarioType?: string;
  reportId?: string | null;
  workstreamId?: string | null;
  result: any | null;
  /** Every row of the latest run — one per filter combination. */
  results?: any[] | null;
  /** Every CONFIGURED combination paired with its latest result, if one exists. */
  comboPairs?: { label: string; comboId?: string | null; result: any | null }[] | null;
  defaultOpen?: boolean;
  showRunLink?: boolean;
  rightSlot?: React.ReactNode;
  onChanged?: () => void;
};

export function ScenarioResultCard({
  scenarioId,
  scenarioTitle,
  scenarioMeta,
  scenarioType,
  reportId,
  workstreamId,
  result: l,
  results,
  comboPairs,
  defaultOpen = false,
  showRunLink = true,
  rightSlot,
  onChanged,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const [runningComboId, setRunningComboId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const executionLocks = useExecutionLocks();
  const scenarioRunning = executionLocks.isScenarioRunning(
    scenarioId,
    reportId,
    workstreamId,
  );
  // The header must reflect EVERY filter combination of the latest run, not just
  // the newest row: one failing combo makes the scenario fail.
  const configuredPairs = comboPairs && comboPairs.length
    ? comboPairs
    : (results && results.length
        ? results.map((r: any, i: number) => ({
            label: r?.actual?.filter || r?.expected?.filter || `combo ${i + 1}`,
            comboId: null,
            result: r,
          }))
        : (l ? [{ label: l?.actual?.filter || l?.expected?.filter || "combo 1", comboId: null, result: l }] : []));
  const comboRows: any[] = configuredPairs.map((p) => p.result).filter(Boolean);
  const issueResult =
    configuredPairs.map((p) => p.result).find((r) => r?.status === "fail" && String(r?.analysis || "").trim())
    || configuredPairs.map((p) => p.result).find((r) => r?.status === "fail")
    || configuredPairs.map((p) => p.result).find((r) => r?.status === "pending")
    || l;
  const overallStatus = (() => {
    if (!configuredPairs.length) return "pending";
    const st = configuredPairs.map((p) => String(p.result?.status || "pending").toLowerCase());
    if (st.some((x) => x === "fail")) return "fail";
    if (st.some((x) => x === "pending")) return "pending";
    return st.every((x) => x === "pass") ? "pass" : (st[0] || "pending");
  })();
  const runLog = storedRunLog(issueResult);
  const runLogIsRca = storedRunLogIsRca(issueResult);

  const { data: scriptInfo, isLoading: scriptInfoLoading } = useQuery({
    queryKey: ["scenario-script-tolerance", scenarioId],
    enabled: true,
    queryFn: async () =>
      (await fetchCanonicalScript(scenarioId, "assertion_spec")).data,
    staleTime: 0,
    refetchOnMount: "always",
  });
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
    await supabase.from("note_memory").insert({
      scenario_id: scenarioId,
      signature: "ignore_future",
      decision: "ignore_future",
      reason: "Deferred from results view",
      weight: 2,
    });
    toast.success("Deferred — agent will skip in future runs");
    onChanged?.();
  };

  const saveRca = async (trId: string, body: string) => {
    if (!body.trim()) return;
    await supabase.from("test_results").update({ analysis: body }).eq("id", trId);
    await supabase.from("operator_notes").insert({
      test_result_id: trId,
      scenario_id: scenarioId,
      note_type: "rca_update",
      body,
    });
    toast.success("RCA updated");
    onChanged?.();
  };

  const runScenarioCombo = async (comboId?: string | null) => {
    const busyId = comboId || "__scenario__";
    setRunningComboId(busyId);
    const toastId = `scenario-run-${scenarioId}-${busyId}`;
    toast.loading(comboId ? "Running filter combination…" : "Running scenario…", { id: toastId });
    try {
      const { data, error } = await invokeFunction("agent-orchestrate", {
        scope_type: "scenario",
        scope_id: scenarioId,
        single_combo_id: comboId || null,
        trigger_source: "scenario_status_page",
        concurrency: 1,
      });
      if (error) throw error;
      toast.success(`Run ${String(data?.run_id || "").slice(0, 8) || "started"} is in progress`, { id: toastId });
      queryClient.invalidateQueries({ queryKey: ["active-execution-locks"] });
      onChanged?.();
    } catch (e: any) {
      toast.error(e?.message || "Could not start the run", { id: toastId });
    } finally {
      setRunningComboId(null);
    }
  };

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
        {configuredPairs.length > 0 && (
          <span className="text-xs text-muted-foreground mono whitespace-nowrap" title="filter combinations in the latest result per combo">
            {comboRows.filter((r: any) => String(r?.status).toLowerCase() === "pass").length}/{configuredPairs.length} combo{configuredPairs.length === 1 ? "" : "s"}
          </span>
        )}
        {(l?.criticality || l?.severity) && <StatusChip status={l.criticality || l.severity} />}
        <div className="flex-1 min-w-0">
          <Link to={`/scenarios/${scenarioId}`} className="text-sm font-medium hover:text-accent block truncate">
            {scenarioTitle}
          </Link>
          {scenarioMeta && (
            <div className="text-xs text-muted-foreground mono truncate">{scenarioMeta}</div>
          )}
        </div>
        {issueResult && (issueResult.status === "fail" || issueResult.status === "pending") && runLog && (
          <div className="hidden md:block max-w-md text-xs text-destructive truncate" title={runLog}>
            {runLogIsRca ? "RCA: " : "Log: "}{runLog}
          </div>
        )}
        <div className="text-xs text-muted-foreground mono whitespace-nowrap">
          {l?.created_at ? new Date(l.created_at).toLocaleString() : "never run"}
        </div>
        {showRunLink && l?.run_id && (
          <Link to={`/runs/${l.run_id}`} className="text-xs text-accent hover:underline">
            run →
          </Link>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={runningComboId !== null || scenarioRunning}
          onClick={() => void runScenarioCombo(null)}
          title="Run every configured filter combination for this scenario"
        >
          <Play className="h-3 w-3 mr-1" />
          {scenarioRunning
            ? "Running…"
            : runningComboId === "__scenario__"
              ? "Starting…"
              : "Run"}
        </Button>
        {rightSlot}
      </div>
      {open && (
        <div className="border-t border-border bg-secondary/20 p-3 space-y-3 text-xs">
          {!l && <div className="text-muted-foreground">No execution recorded yet.</div>}
          {scriptInfoLoading && (
            <div className="text-muted-foreground">Loading the Latest Result KPI configuration…</div>
          )}
          {!scriptInfoLoading && configuredPairs.length > 0 && (
            <>
              {issueResult && (issueResult.status === "fail" || issueResult.status === "pending") && runLog && (
                <div className="border border-destructive/30 bg-destructive/5 rounded p-2">
                  <span className="text-muted-foreground mono">{runLogIsRca ? "RCA: " : "Log: "}</span>
                  <span>{runLog}</span>
                </div>
              )}
              {(() => {
                // One test_results row per filter combination. Rendering only the
                // first showed a single combo here while Latest result showed all.
                if (configuredPairs.length === 1 && configuredPairs[0].result) {
                  const r = configuredPairs[0].result;
                  return (
                    <div className="space-y-2">
                      <StoredResultTable
                        actual={r.actual}
                        expected={r.expected}
                        spec={(scriptInfo as any)?.assertion_spec}
                        scenarioType={scenarioType}
                        status={r.status}
                        diff={r.diff}
                      />
                      {(r.status === "fail" || r.status === "pending") && (
                        <RcaEditor trId={r.id} initial={r.analysis || ""} onSave={saveRca} />
                      )}
                    </div>
                  );
                }
                return (
                  <div className="space-y-3">
                    {configuredPairs.map((pair, i: number) => {
                      const r = pair.result;
                      return (
                      <div key={pair.comboId || r?.id || i} className="border border-border rounded-md">
                        <div className="flex items-center gap-2 px-2 py-1 bg-secondary/40 border-b border-border">
                          <StatusChip status={r?.status || "pending"} />
                          <span className="mono text-xs">
                            {pair.label || `combo ${i + 1}`}
                          </span>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="ml-auto h-7"
                            disabled={!pair.comboId || runningComboId !== null || scenarioRunning}
                            onClick={() => void runScenarioCombo(pair.comboId)}
                            title={pair.comboId ? "Run this filter combination" : "No configured combination id"}
                          >
                            <Play className="h-3 w-3 mr-1" />
                            {runningComboId === pair.comboId ? "Starting…" : "Run"}
                          </Button>
                        </div>
                        <div className="p-2">
                          {r ? (
                            <div className="space-y-2">
                              {(r.status === "fail" || r.status === "pending") && storedRunLog(r) && (
                                <div className="border border-destructive/30 bg-destructive/5 rounded p-2">
                                  <span className="text-muted-foreground mono">
                                    {storedRunLogIsRca(r) ? "RCA: " : "Log: "}
                                  </span>
                                  <span>{storedRunLog(r)}</span>
                                </div>
                              )}
                              <StoredResultTable
                                actual={r.actual}
                                expected={r.expected}
                                spec={(scriptInfo as any)?.assertion_spec}
                                scenarioType={scenarioType}
                                status={r.status}
                                diff={r.diff}
                              />
                              {(r.status === "fail" || r.status === "pending") && (
                                <RcaEditor trId={r.id} initial={r.analysis || ""} onSave={saveRca} />
                              )}
                            </div>
                          ) : (
                            <div className="text-xs text-muted-foreground p-2">
                              This configured combination has no stored result yet. Select Run to execute it.
                            </div>
                          )}
                        </div>
                      </div>
                    )})}
                  </div>
                );
              })()}
              {l && l.status !== "pass" && l.healing_proposal && (
                <div className="border border-border rounded-md p-2 bg-background/40">
                  <div className="text-muted-foreground mono mb-1">
                    Proposed fix · status: {l.healing_status || "proposed"}
                  </div>
                  {l.healing_proposal.rationale && <div>{l.healing_proposal.rationale}</div>}
                </div>
              )}
            </>
          )}
          <div className="flex flex-wrap gap-2 pt-2 border-t border-border">
            {l && (l.status === "fail" || l.status === "pending") && (
              <Button size="sm" variant="outline" onClick={() => proposeFix(l.id)}>
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
            <HistoryToggle scenarioId={scenarioId} currentRunId={l?.run_id} />
          </div>
        </div>
      )}
    </div>
  );
}

function HistoryToggle({ scenarioId, currentRunId }: { scenarioId: string; currentRunId?: string }) {
  const [show, setShow] = useState(false);
  const { data } = useQuery({
    queryKey: ["scenario-history", scenarioId, show],
    enabled: show,
    queryFn: async () =>
      (await supabase
        .from("test_results")
        .select("id, run_id, status, criticality, severity, analysis, actual, expected, created_at")
        .eq("scenario_id", scenarioId)
        .order("created_at", { ascending: false })
        .limit(50)).data ?? [],
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
              className={`flex items-center gap-3 px-3 py-2 text-xs hover:bg-secondary/40 ${h.run_id === currentRunId ? "bg-accent/5" : ""}`}
            >
              <StatusChip status={h.status} />
              {(h.criticality || h.severity) && <StatusChip status={h.criticality || h.severity} />}
              <span className="mono text-muted-foreground">{new Date(h.created_at).toLocaleString()}</span>
              <span className="flex-1 min-w-0 truncate">{storedRunLog(h) || "—"}</span>
              <span className="mono text-muted-foreground">run {h.run_id?.slice(0, 8)}</span>
            </Link>
          ))}
          {!data?.length && <div className="px-3 py-2 text-xs text-muted-foreground">No history.</div>}
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

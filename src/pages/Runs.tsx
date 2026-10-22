import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { AppLayout } from "@/components/AppLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Link, useSearchParams } from "react-router-dom";
import { StatusChip } from "@/components/StatusChip";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { XCircle, Trash2 } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { fetchRunAssertionSpecs, fetchRunTestResults } from "@/lib/runTestResults";
import { deriveRunResults, matchesRunOutcome, presentedRunStatus } from "@/lib/runPresentation";

export default function Runs() {
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const status = params.get("status");
  const [search, setSearch] = useState("");
  const [wsId, setWsId] = useState("all");
  const [reportId, setReportId] = useState("all");

  const { data: workstreams } = useQuery({
    queryKey: ["ws-list"],
    queryFn: async () => (await supabase.from("workstreams").select("id, name")).data ?? [],
  });
  const { data: reports } = useQuery({
    queryKey: ["reports-list"],
    queryFn: async () =>
      (await supabase.from("reports").select("id, name, workstream_id")).data ?? [],
  });
  const { data: scenarios } = useQuery({
    queryKey: ["run-count-scenarios"],
    queryFn: async () =>
      (await supabase.from("scenarios").select("id, report_id, deferred")).data ?? [],
  });

  const { data: runs } = useQuery({
    queryKey: ["all-runs"],
    queryFn: async () =>
      (await supabase.from("runs").select("*").order("started_at", { ascending: false }).limit(200)).data ?? [],
    refetchInterval: (query) =>
      ((query.state.data as any[]) || []).some((run: any) => run.status === "running") ? 3000 : false,
    staleTime: 0,
    refetchOnMount: "always",
  });

  // Build run_id → set of {workstream_id, report_id, report_name, ws_name} from test_results
  const { data: runMeta, isPending: resultsLoading, error: resultsError } = useQuery({
    queryKey: ["run-meta", (runs || []).map((run) => run.id)],
    enabled: !!runs?.length,
    staleTime: 0,
    refetchOnMount: "always",
    refetchInterval: (runs || []).some((run: any) => run.status === "running") ? 3000 : false,
    queryFn: async () => {
      const ids = (runs || []).map((r: any) => r.id);
      const data = await fetchRunTestResults(ids);
       const specs = await fetchRunAssertionSpecs(data.map((row) => row.scenario_id));
      const map: Record<string, {
        ws: Set<string>;
        reports: Set<string>;
        labels: Set<string>;
        cases: Map<string, Array<"pass" | "fail" | "pending">>;
      }> = {};
      for (const row of deriveRunResults(data, specs)) {
        const rep: any = (row as any).scenarios?.reports;
        if (!rep) continue;
        const m = (map[(row as any).run_id] ||= {
          ws: new Set(), reports: new Set(), labels: new Set(), cases: new Map(),
        });
        if (rep.workstream_id) m.ws.add(rep.workstream_id);
        m.reports.add(rep.id);
        m.labels.add(`${rep.workstreams?.name || ""} / ${rep.name}`.toLowerCase());
        const scenarioId = String((row as any).scenario_id || "");
        if (scenarioId) {
          const statuses = m.cases.get(scenarioId) || [];
          statuses.push(
            row.derivedStatus,
          );
          m.cases.set(scenarioId, statuses);
        }
      }
      return map;
    },
  });

  const caseCounts = (run: any) => {
    const m = runMeta?.[run.id];
    const caseStatus = new Map<string, "pass" | "fail" | "pending">();
    for (const [scenarioId, statuses] of m?.cases || []) {
      caseStatus.set(
        scenarioId,
        statuses.includes("fail") ? "fail" : statuses.includes("pending") ? "pending" : "pass",
      );
    }
    const reportIds = run.scope_type === "workstream"
      ? new Set((reports || []).filter((r: any) => r.workstream_id === run.scope_id).map((r: any) => r.id))
      : new Set(run.scope_type === "report" ? [run.scope_id] : []);
    const scopedScenarioIds = run.scope_type === "scenario"
      ? [run.scope_id]
      : (scenarios || [])
          .filter((s: any) => !s.deferred && reportIds.has(s.report_id))
          .map((s: any) => s.id);
    for (const scenarioId of run.status === "running" ? scopedScenarioIds : []) {
      if (!caseStatus.has(scenarioId)) caseStatus.set(scenarioId, "pending");
    }
    let pass = 0, fail = 0, pending = 0;
    for (const value of caseStatus.values()) {
      if (value === "pass") pass++;
      else if (value === "fail") fail++;
      else pending++;
    }
    return { pass, fail, pending, total: caseStatus.size };
  };

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return (runs || []).filter((r: any) => {
      const counts = caseCounts(r);
      if (!matchesRunOutcome(r, counts, status)) return false;
      const m = runMeta?.[r.id];
      if (wsId !== "all" && !m?.ws.has(wsId)) return false;
      if (reportId !== "all" && !m?.reports.has(reportId)) return false;
      if (!q) return true;
      if (r.id.toLowerCase().includes(q)) return true;
      if (r.trigger_source?.toLowerCase().includes(q)) return true;
      if (r.scope_type?.toLowerCase().includes(q)) return true;
      for (const lbl of m?.labels || []) if (lbl.includes(q)) return true;
      return false;
    });
  }, [runs, runMeta, reports, scenarios, status, wsId, reportId, search]);

  const setStatus = (s: string | null) => {
    const next = new URLSearchParams(params);
    if (s) next.set("status", s);
    else next.delete("status");
    setParams(next);
  };

  const deleteRun = async (runId: string, e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    if (!confirm(`Delete run ${runId.slice(0, 8)} and all its results? This cannot be undone.`)) return;
    const { error } = await supabase.from("runs").delete().eq("id", runId);
    if (error) toast({ title: "Failed to delete run", description: error.message, variant: "destructive" });
    else {
      toast({ title: "Run deleted" });
      queryClient.invalidateQueries({ queryKey: ["all-runs"] });
      queryClient.invalidateQueries({ queryKey: ["run-meta"] });
      queryClient.invalidateQueries({ queryKey: ["scenario-results"] });
      queryClient.invalidateQueries({ queryKey: ["runs-report"] });
    }
  };

  const filteredReports = (reports || []).filter((r: any) => wsId === "all" || r.workstream_id === wsId);

  return (
    <AppLayout>
      <div className="p-8">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-2xl font-bold italic">Runs</h1>
        </div>

        <div className="flex gap-2 flex-wrap items-center mb-4">
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs font-semibold text-foreground mono">
            {filtered.length} runs
          </div>
          <Input
            placeholder="Search id, workstream, report, trigger…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-sm font-semibold placeholder:font-semibold"
          />
          <Select value={wsId} onValueChange={(v) => { setWsId(v); setReportId("all"); }}>
            <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All reports</SelectItem>
              {(workstreams || []).map((w: any) => (
                <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={reportId} onValueChange={setReportId}>
            <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All reports</SelectItem>
              {filteredReports.map((r: any) => (
                <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={status || "all"} onValueChange={(value) => setStatus(value === "all" ? null : value)}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="pass">Passing</SelectItem>
              <SelectItem value="fail">Failing</SelectItem>
              <SelectItem value="running">Running</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Card>
          <CardContent className="space-y-1 overflow-x-auto p-0">
            {resultsError && <div role="alert" className="p-3 text-sm text-destructive">Unable to load run results. Please refresh to try again.</div>}
            <div className="grid min-w-[850px] grid-cols-[90px_minmax(180px,1fr)_90px_140px_190px_110px_28px] items-center gap-3 rounded-t-xl border-b bg-slate-100 px-3 py-3 text-xs font-bold text-slate-600 dark:bg-slate-800 dark:text-slate-200">
              <span>Run ID</span>
              <span>Description</span>
              <span>Checks</span>
              <span>Run Type</span>
              <span>Date &amp; Time</span>
              <span>Status</span>
              <span aria-hidden="true" />
            </div>
            {filtered.map((r: any) => {
              const m = runMeta?.[r.id];
              const counts = caseCounts(r);
              const reportsById = new Map((reports || []).map((x: any) => [x.id, x]));
              const wsById = new Map((workstreams || []).map((x: any) => [x.id, x]));
              let labels = Array.from(m?.labels || []).slice(0, 2).join(", ");
              if (!labels && r.scope_type === "report") {
                const rep: any = reportsById.get(r.scope_id);
                if (rep) {
                  const ws: any = wsById.get(rep.workstream_id);
                  labels = `${ws?.name || "—"} / ${rep.name}`;
                }
              } else if (!labels && r.scope_type === "workstream") {
                const ws: any = wsById.get(r.scope_id);
                if (ws) labels = ws.name;
              }
              return (
                <Link
                  key={r.id}
                  to={`/runs/${r.id}`}
                  className="grid min-w-[850px] grid-cols-[90px_minmax(180px,1fr)_90px_140px_190px_110px_28px] items-center gap-3 hover:bg-secondary/40 rounded px-2 py-2 text-sm"
                >
                  <span className="mono text-xs">{r.id.slice(0, 8)}</span>
                  <span className="text-xs text-muted-foreground min-w-0 truncate">
                    {labels || r.scope_type}
                  </span>
                  <span className="text-xs whitespace-nowrap flex items-center gap-1">
                    <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                      {resultsLoading || resultsError ? "—" : counts.pass}✓
                    </span>
                    <span className="text-muted-foreground">/</span>
                    <span className="text-destructive font-medium">
                      {resultsLoading || resultsError ? "—" : counts.fail}✗
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">{r.trigger_source}</span>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {new Date(r.started_at!).toLocaleString()}
                  </span>
                  <StatusChip status={resultsLoading || resultsError ? "pending" : presentedRunStatus(r, counts)} />
                  {r.status === "running" ? (
                    <button
                      onClick={async (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (!confirm(`Cancel run ${r.id.slice(0, 8)}?`)) return;
                        const curSummary = (r.summary as any) || {};
                        const { error } = await supabase
                          .from("runs")
                          .update({
                            status: "cancelled",
                            finished_at: new Date().toISOString(),
                            summary: { ...curSummary, in_progress: false, cancelled: true },
                          })
                          .eq("id", r.id);
                        if (error) toast({ title: "Failed to cancel", description: error.message, variant: "destructive" });
                        else {
                          toast({ title: "Run cancelled" });
                          queryClient.invalidateQueries({ queryKey: ["all-runs"] });
                        }
                      }}
                      title="Cancel run"
                      className="text-destructive hover:text-destructive/80"
                    >
                      <XCircle className="h-4 w-4" />
                    </button>
                  ) : (
                    <button
                      onClick={(e) => deleteRun(r.id, e)}
                      title="Delete run"
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </Link>
              );
            })}
            {!filtered.length && <div className="p-4 text-sm text-muted-foreground">No runs match.</div>}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}

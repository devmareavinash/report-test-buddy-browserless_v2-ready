import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useParams, useNavigate } from "react-router-dom";
import { AppLayout } from "@/components/AppLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RunScenarioCard } from "@/components/RunScenarioCard";
import { StatusChip } from "@/components/StatusChip";
import { deriveStoredResultStatus } from "@/lib/kpi-values";
import { Button } from "@/components/ui/button";
import { XCircle, Trash2 } from "lucide-react";
import { toast } from "@/hooks/use-toast";


export default function RunDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [wsId, setWsId] = useState("all");
  const [reportId, setReportId] = useState("all");
  const [criticality, setCriticality] = useState("all");

  const { data: run } = useQuery({
    queryKey: ["run", id],
    queryFn: async () => (await supabase.from("runs").select("*").eq("id", id!).maybeSingle()).data,
    refetchInterval: (q) => ((q.state.data as any)?.status === "running" ? 3000 : false),
    staleTime: 0,
    refetchOnMount: "always",
  });
  const isRunning = run?.status === "running";
  const { data: results, refetch } = useQuery({
    queryKey: ["results", id],
    queryFn: async () =>
      (await supabase
        .from("test_results")
        .select(
          "id, scenario_id, run_id, status, criticality, severity, analysis, expected, actual, diff, healing_status, healing_proposal, screenshot_url, created_at, scenarios(id, title, type, criticality, report_id, reports(id, name, workstream_id, workstreams(id, name)))",
        )
        .eq("run_id", id!)
        .order("created_at", { ascending: true })).data ?? [],
    refetchInterval: isRunning ? 3000 : false,
    staleTime: 0,
    refetchOnMount: "always",
  });

  // While a run is in progress, surface scenarios that haven't produced a result yet as "pending".
  const { data: scopeScenarios } = useQuery({
    queryKey: ["run-scope-scenarios", id, (run as any)?.scope_type, (run as any)?.scope_id],
    enabled: !!(run as any)?.scope_id,
    queryFn: async () => {
      const r = run as any;
      if (r.scope_type === "report") {
        return (await supabase
          .from("scenarios")
          .select("id, title, type, criticality, report_id, reports(id, name, workstream_id, workstreams(id, name))")
          .eq("report_id", r.scope_id)).data ?? [];
      }
      if (r.scope_type === "scenario") {
        return (await supabase
          .from("scenarios")
          .select("id, title, type, criticality, report_id, reports(id, name, workstream_id, workstreams(id, name))")
          .eq("id", r.scope_id)).data ?? [];
      }
      if (r.scope_type === "workstream") {
        const { data: reps } = await supabase.from("reports").select("id").eq("workstream_id", r.scope_id);
        const repIds = (reps || []).map((x: any) => x.id);
        if (!repIds.length) return [];
        return (await supabase
          .from("scenarios")
          .select("id, title, type, criticality, report_id, reports(id, name, workstream_id, workstreams(id, name))")
          .in("report_id", repIds)
          .eq("deferred", false)).data ?? [];
      }
      return [];
    },
    refetchInterval: isRunning ? 3000 : false,
  });

  const merged = useMemo(() => {
    const have = new Set((results || []).map((r: any) => r.scenario_id));
    const stubs = isRunning ? (scopeScenarios || [])
      .filter((s: any) => !have.has(s.id))
      .map((s: any) => ({
        id: `pending-${s.id}`,
        scenario_id: s.id,
        run_id: id,
        status: "pending",
        criticality: s.criticality,
        severity: null,
        analysis: null,
        expected: null,
        actual: null,
        diff: null,
        healing_status: null,
        healing_proposal: null,
        screenshot_url: null,
        created_at: (run as any)?.started_at || new Date().toISOString(),
        scenarios: s,
      })) : [];
    return [...(results || []), ...stubs];
  }, [results, scopeScenarios, id, run, isRunning]);

  const workstreams = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of merged || []) {
      const ws = (r as any).scenarios?.reports?.workstreams;
      if (ws?.id) m.set(ws.id, ws.name);
    }
    return Array.from(m, ([id, name]) => ({ id, name }));
  }, [merged]);

  const reports = useMemo(() => {
    const m = new Map<string, { id: string; name: string; workstream_id: string }>();
    for (const r of merged || []) {
      const rep = (r as any).scenarios?.reports;
      if (rep?.id) m.set(rep.id, { id: rep.id, name: rep.name, workstream_id: rep.workstream_id });
    }
    return Array.from(m.values()).filter((r) => wsId === "all" || r.workstream_id === wsId);
  }, [merged, wsId]);

  const withDerivedStatus = useMemo(() => {
    return (merged || []).map((r: any) => {
      const derivedStatus = deriveStoredResultStatus({
        actual: r.actual,
        expected: r.expected,
        scenarioType: r.scenarios?.type,
        diff: r.diff,
        fallbackStatus: r.status,
      });
      return { ...r, derivedStatus };
    });
  }, [merged]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return (withDerivedStatus || []).filter((r: any) => {
      const s = r.scenarios;
      if (status !== "all" && r.derivedStatus !== status) return false;
      if (criticality !== "all") {
        const c = (r.criticality || s?.criticality || "medium").toLowerCase();
        if (c !== criticality) return false;
      }
      if (wsId !== "all" && s?.reports?.workstream_id !== wsId) return false;
      if (reportId !== "all" && s?.report_id !== reportId) return false;
      if (!q) return true;
      return (
        s?.title?.toLowerCase().includes(q) ||
        s?.reports?.name?.toLowerCase().includes(q) ||
        s?.reports?.workstreams?.name?.toLowerCase().includes(q) ||
        r.analysis?.toLowerCase().includes(q)
      );
    });
  }, [withDerivedStatus, search, status, wsId, reportId, criticality]);

  const counts = useMemo(() => {
    let pass = 0, fail = 0, pending = 0;
    for (const r of withDerivedStatus || []) {
      if (r.derivedStatus === "pass") pass++;
      else if (r.derivedStatus === "fail") fail++;
      else pending++;
    }
    return { pass, fail, pending };
  }, [withDerivedStatus]);
  const displayedRunStatus = isRunning
    ? "running"
    : counts.fail > 0
      ? "failed"
      : counts.pending > 0
        ? "running"
        : counts.pass > 0
          ? "completed"
          : run?.status;

  return (
    <AppLayout>
      <div className="p-8 space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold flex items-center gap-3">
              Run <span className="mono text-base text-muted-foreground">{id?.slice(0, 8)}</span>
              {displayedRunStatus && <StatusChip status={displayedRunStatus} />}
            </h1>
            <div className="text-sm text-muted-foreground mt-1">
              {counts.pass} passed · {counts.fail} failed · {counts.pending} pending · trigger {run?.trigger_source}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isRunning ? (
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  if (!confirm("Cancel this run?")) return;
                  const curSummary = (run as any)?.summary || {};
                  const { error } = await supabase
                    .from("runs")
                    .update({
                      status: "cancelled",
                      finished_at: new Date().toISOString(),
                      summary: { ...curSummary, in_progress: false, cancelled: true },
                    })
                    .eq("id", id!);
                  if (error) toast({ title: "Failed to cancel", description: error.message, variant: "destructive" });
                  else {
                    toast({ title: "Run cancelled" });
                    queryClient.invalidateQueries({ queryKey: ["run", id] });
                  }
                }}
                className="text-destructive border-destructive/40 hover:bg-destructive/10"
              >
                <XCircle className="h-4 w-4 mr-1" /> Cancel run
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  if (!confirm(`Delete run ${id?.slice(0, 8)} and all its results? This cannot be undone.`)) return;
                  const { error } = await supabase.from("runs").delete().eq("id", id!);
                  if (error) toast({ title: "Failed to delete run", description: error.message, variant: "destructive" });
                  else {
                    toast({ title: "Run deleted" });
                    queryClient.invalidateQueries({ queryKey: ["all-runs"] });
                    queryClient.invalidateQueries({ queryKey: ["run-meta"] });
                    queryClient.invalidateQueries({ queryKey: ["scenario-results"] });
                    queryClient.invalidateQueries({ queryKey: ["runs-report"] });
                    navigate("/runs");
                  }
                }}
                className="text-destructive border-destructive/40 hover:bg-destructive/10"
              >
                <Trash2 className="h-4 w-4 mr-1" /> Delete run
              </Button>
            )}
          </div>
        </div>

        {(run as any)?.summary?.error && !(results || []).length && (
          <Card className="border-destructive/40 bg-destructive/5">
            <CardContent className="p-3 text-sm text-destructive">
              {(run as any).summary.error}
            </CardContent>
          </Card>
        )}


        <div className="flex gap-2 flex-wrap items-center">
          <Input
            placeholder="Search scenario, report, analysis…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-sm"
          />
          <Select value={wsId} onValueChange={(v) => { setWsId(v); setReportId("all"); }}>
            <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All reports</SelectItem>
              {workstreams.map((w) => (
                <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={reportId} onValueChange={setReportId}>
            <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All reports</SelectItem>
              {reports.map((r) => (
                <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="pass">Pass</SelectItem>
              <SelectItem value="fail">Fail</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
            </SelectContent>
          </Select>
          <Select value={criticality} onValueChange={setCriticality}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All criticality</SelectItem>
              <SelectItem value="critical">Critical</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="low">Low</SelectItem>
            </SelectContent>
          </Select>
          <div className="text-xs text-muted-foreground mono ml-auto">{filtered.length} results</div>
        </div>

        <Card>
          <CardContent className="p-2 space-y-1">
            {(() => {
              // Group filtered results by scenario_id, preserving first-seen order
              const order: string[] = [];
              const groups = new Map<string, any[]>();
              for (const r of filtered as any[]) {
                if (!groups.has(r.scenario_id)) {
                  groups.set(r.scenario_id, []);
                  order.push(r.scenario_id);
                }
                groups.get(r.scenario_id)!.push(r);
              }
              return order.map((sid) => {
                const group = groups.get(sid)!;
                const s = group[0].scenarios;
                const meta = s
                  ? `${s.reports?.workstreams?.name || "—"} / ${s.reports?.name || "—"} · ${s.type || "—"} · ${s.criticality}`
                  : undefined;
                return (
                  <RunScenarioCard
                    key={sid}
                    scenarioId={sid}
                    scenarioTitle={s?.title || "(deleted scenario)"}
                    scenarioType={s?.type || "warehouse_match"}
                    scenarioMeta={meta}
                    results={group}
                    defaultOpen={false}
                    onChanged={refetch}
                  />
                );
              });
            })()}
            {!filtered.length && <div className="text-sm text-muted-foreground p-4 text-center">No results match.</div>}
          </CardContent>
        </Card>

      </div>
    </AppLayout>
  );
}

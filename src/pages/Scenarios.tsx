import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { AppLayout } from "@/components/AppLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { ScenarioResultCard } from "@/components/ScenarioResultCard";
import { toast } from "sonner";
import { fetchLatestRunResultsByScenarioIds, fetchFilterMatrixByScenarioIds, overallStatusFromComboPairs, pairCombosWithResults } from "@/lib/latestTestResults";
import { useExecutionLocks } from "@/hooks/useExecutionLocks";

export default function Scenarios() {
  const [params] = useSearchParams();
  const deferred = params.get("deferred") === "true";
  const urlStatus = params.get("status") || "all";
  const urlCriticality = params.get("criticality") || "all";
  const urlWs = params.get("workstream_id") || "all";
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState(urlStatus);
  const [criticality, setCriticality] = useState(urlCriticality);
  const [wsId, setWsId] = useState(urlWs);
  const executionLocks = useExecutionLocks();
  const activeRunCount = executionLocks.data?.activeRuns?.length || 0;
  const previousActiveRunCount = useRef(0);

  const { data: workstreams } = useQuery({
    queryKey: ["ws-list"],
    queryFn: async () => (await supabase.from("workstreams").select("id, name")).data ?? [],
  });

  const { data, refetch } = useQuery({
    queryKey: ["scenarios-pivot", deferred],
    queryFn: async () => {
      const scenarios =
        (await supabase
          .from("scenarios")
          .select("id, title, type, criticality, status, deferred, report_id, reports(id, name, workstream_id, workstreams(id, name))")
          .eq("deferred", deferred)
          .order("created_at", { ascending: false })
          .limit(2000)).data ?? [];
      const latestRuns = await fetchLatestRunResultsByScenarioIds(
        scenarios.map((s: any) => s.id),
        "id, scenario_id, run_id, status, criticality, severity, analysis, expected, actual, diff, healing_status, healing_proposal, screenshot_url, created_at",
      );
      // Latest result renders scenario_filter_matrix, so this page must too —
      // otherwise a scenario with 4 combinations shows only the ones that have
      // a stored test_results row.
      const matrix = await fetchFilterMatrixByScenarioIds(scenarios.map((s: any) => s.id));
      const mapped = scenarios.map((s: any) => {
        const rows = latestRuns.get(s.id) || [];
        const combos = matrix.get(s.id) || [];
        const comboPairs = pairCombosWithResults(combos, rows);
        const overallStatus = overallStatusFromComboPairs(
          comboPairs,
          rows[0]?.status || "pending",
        );
        return {
          scenario: s,
          latest: rows[0] || null,
          latestAll: rows,
          comboPairs,
          overallStatus,
        };
      });
      return mapped;
    },
    // agent-analyze writes RCA asynchronously after a failed result is inserted.
    // Poll only while at least one failed/pending combination has no RCA yet.
    refetchInterval: (query) => {
      const activeRuns = executionLocks.data?.activeRuns?.length || 0;
      if (activeRuns > 0) return 3000;
      const rows = (query.state.data as any[] | undefined) || [];
      const waiting = rows.some((row: any) =>
        (row.comboPairs || []).some((pair: any) => {
          const result = pair?.result;
          return result
            && (result.status === "fail" || result.status === "pending")
            && !String(result.analysis || "").trim();
        })
      );
      return waiting ? 5000 : false;
    },
    staleTime: 0,
    refetchOnMount: "always",
  });

  useEffect(() => {
    if (activeRunCount > 0 || previousActiveRunCount.current > activeRunCount) {
      refetch();
    }
    previousActiveRunCount.current = activeRunCount;
  }, [activeRunCount, refetch]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return (data || []).filter((row: any) => {
      const s = row.scenario;
      if (wsId !== "all" && s.reports?.workstream_id !== wsId) return false;
      if (status !== "all") {
        const st = row.overallStatus || "pending";
        if (status === "ran") {
          if (st === "pending") return false;
        } else if (st !== status) {
          return false;
        }
      }
      if (criticality !== "all") {
        const c = (row.latest?.criticality || s.criticality || "medium").toLowerCase();
        if (c !== criticality) return false;
      }
      if (!q) return true;
      return (
        s.title?.toLowerCase().includes(q) ||
        s.reports?.name?.toLowerCase().includes(q) ||
        s.reports?.workstreams?.name?.toLowerCase().includes(q) ||
        row.latest?.analysis?.toLowerCase().includes(q) ||
        String(row.latest?.actual?.error || row.latest?.expected?.error || "").toLowerCase().includes(q)
      );
    });
  }, [data, search, status, wsId, criticality]);

  const restore = async (id: string) => {
    await supabase.from("scenarios").update({ deferred: false }).eq("id", id);
    toast.success("Restored");
    refetch();
  };

  return (
    <AppLayout>
      <div className="p-8 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {deferred ? "Deferred scenarios" : "Tests execution status"}
            </h1>
            <p className="text-sm text-muted-foreground">
              Latest execution per scenario, with RCA and proposed fixes.
            </p>
          </div>
          <Link
            to={`/scenarios?deferred=${deferred ? "false" : "true"}`}
            className="text-xs text-accent"
          >
            Show {deferred ? "active" : "deferred"} →
          </Link>
        </div>

        <div className="flex gap-2 flex-wrap items-center">
          <Input
            placeholder="Search title, report, workstream, analysis…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-sm"
          />
          <Select value={wsId} onValueChange={setWsId}>
            <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All reports</SelectItem>
              {(workstreams || []).map((w: any) => (
                <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="ran">Ran</SelectItem>
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
          <div className="text-xs text-muted-foreground mono ml-auto">{filtered.length} scenarios</div>
        </div>

        <Card>
          <CardContent className="p-2 space-y-1">
            {filtered.map((row: any) => {
              const s = row.scenario;
              const meta = `${s.reports?.workstreams?.name || "—"} / ${s.reports?.name || "—"} · ${s.type || "—"} · ${s.criticality}`;
              return (
                <ScenarioResultCard
                  key={s.id}
                  scenarioId={s.id}
                  scenarioTitle={s.title}
                  scenarioMeta={meta}
                  scenarioType={s.type}
                  reportId={s.report_id}
                  workstreamId={s.reports?.workstream_id}
                  result={row.latest}
                  results={row.latestAll}
                  comboPairs={row.comboPairs}
                  onChanged={refetch}
                  rightSlot={
                    deferred ? (
                      <Button size="sm" variant="outline" onClick={() => restore(s.id)}>Restore</Button>
                    ) : undefined
                  }
                />
              );
            })}
            {!filtered.length && (
              <div className="text-sm text-muted-foreground p-4 text-center">No scenarios match.</div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}

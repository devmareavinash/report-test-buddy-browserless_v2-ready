import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { AppLayout } from "@/components/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusChip } from "@/components/StatusChip";
import { Link } from "react-router-dom";
import { fetchFilterMatrixByScenarioIds, fetchLatestRunResultsByScenarioIds, overallStatusFromComboPairs, pairCombosWithResults } from "@/lib/latestTestResults";

export default function Tests() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string>("all");
  const [wsId, setWsId] = useState<string>("all");

  const { data: workstreams } = useQuery({
    queryKey: ["ws"],
    queryFn: async () => (await supabase.from("workstreams").select("id, name")).data ?? [],
  });

  const { data, isLoading } = useQuery({
    queryKey: ["tests-overview"],
    queryFn: async () => {
      const scenarios = (await supabase
        .from("scenarios")
        .select("id, title, status, criticality, type, report_id, reports(id, name, workstream_id, workstreams(id, name))")
        .limit(1000)).data ?? [];
      const ids = scenarios.map((s: any) => s.id);
      const latestByScenario = await fetchLatestRunResultsByScenarioIds(
        ids,
        "id, scenario_id, run_id, status, criticality, severity, created_at, runs(id, started_at)",
      );
      const matrix = await fetchFilterMatrixByScenarioIds(ids);
      return scenarios.map((s: any) => {
        const results = latestByScenario.get(s.id) || [];
        const pairs = pairCombosWithResults(matrix.get(s.id) || [], results);
        const overallStatus = overallStatusFromComboPairs(
          pairs,
          results[0]?.status || "pending",
        );
        return {
          scenario: s,
          latest: results[0] || null,
          overallStatus,
        };
      });
    },
  });

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return (data || []).filter((row: any) => {
      const s = row.scenario;
      if (wsId !== "all" && s.reports?.workstream_id !== wsId) return false;
      if (status !== "all") {
        const st = row.overallStatus || "pending";
        if (st !== status) return false;
      }
      if (!q) return true;
      return (
        s.title?.toLowerCase().includes(q) ||
        s.reports?.name?.toLowerCase().includes(q) ||
        s.reports?.workstreams?.name?.toLowerCase().includes(q)
      );
    });
  }, [data, search, status, wsId]);

  return (
    <AppLayout>
      <div className="p-8 space-y-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">All tests</h1>
          <p className="text-sm text-muted-foreground">Latest result per test case across every report and screen.</p>
        </div>

        <div className="flex gap-2 items-center flex-wrap">
          <Input
            placeholder="Search title, report, workstream…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-xs"
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
              <SelectItem value="pass">Pass</SelectItem>
              <SelectItem value="fail">Fail</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
            </SelectContent>
          </Select>
          <div className="text-xs text-muted-foreground mono ml-auto">{filtered.length} tests</div>
        </div>

        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Test</TableHead>
                  <TableHead>Report</TableHead>
                  <TableHead>Screen</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Latest run</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((row: any) => {
                  const s = row.scenario;
                  const l = row.latest;
                  return (
                    <TableRow key={s.id}>
                      <TableCell><StatusChip status={row.overallStatus || "pending"} /></TableCell>
                      <TableCell className="font-medium">
                        <Link to={`/scenarios/${s.id}`} className="hover:text-accent">{s.title}</Link>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{s.reports?.workstreams?.name || "—"}</TableCell>
                      <TableCell className="text-xs">
                        <Link to={`/reports/${s.report_id}`} className="hover:text-accent">{s.reports?.name}</Link>
                      </TableCell>
                      <TableCell className="text-xs mono text-muted-foreground">{s.type || "—"}</TableCell>
                      <TableCell className="text-xs mono text-muted-foreground">
                        {l?.created_at ? new Date(l.created_at).toLocaleString() : "never"}
                      </TableCell>
                      <TableCell className="text-right">
                        {l?.run_id && (
                          <Link to={`/runs/${l.run_id}`} className="text-xs text-accent hover:underline">view run</Link>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {!filtered.length && !isLoading && (
                  <TableRow><TableCell colSpan={7} className="text-center text-sm text-muted-foreground py-8">No tests match.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { AppLayout } from "@/components/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Link, useNavigate } from "react-router-dom";
import { ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { fetchFilterMatrixByScenarioIds, fetchLatestRunResultsByScenarioIds, overallStatusFromComboPairs, pairCombosWithResults } from "@/lib/latestTestResults";

type Row = {
  scenario: any;
  latest: any | null;
  overallStatus: string;
};

export default function Dashboard() {
  const { data: rows } = useQuery<Row[]>({
    queryKey: ["dashboard-scenarios"],
    queryFn: async () => {
      const scenarios =
        (await supabase
          .from("scenarios")
          .select("id, title, criticality, type, report_id, reports(id, name, workstream_id, workstreams(id, name))")
          .eq("deferred", false)
          .limit(2000)).data ?? [];
      const ids = scenarios.map((s: any) => s.id);
      const latest = await fetchLatestRunResultsByScenarioIds(
        ids,
        "id, scenario_id, run_id, status, criticality, severity, analysis, expected, actual, created_at",
      );
      const matrix = await fetchFilterMatrixByScenarioIds(ids);
      return scenarios.map((s: any) => {
        const results = latest.get(s.id) || [];
        const pairs = pairCombosWithResults(matrix.get(s.id) || [], results);
        const overallStatus = overallStatusFromComboPairs(
          pairs,
          results[0]?.status || "pending",
        );
        return { scenario: s, latest: results[0] || null, overallStatus };
      });
    },
  });

  const { data: lastRunByReport } = useQuery<Record<string, string>>({
    queryKey: ["dashboard-last-run-by-report"],
    queryFn: async () => {
      const { data } = await supabase
        .from("runs")
        .select("id, scope_type, scope_id, started_at")
        .eq("scope_type", "report")
        .order("started_at", { ascending: false })
        .limit(2000);
      const map: Record<string, string> = {};
      for (const r of data || []) {
        const sid = (r as any).scope_id as string;
        if (sid && !map[sid]) map[sid] = (r as any).id;
      }
      return map;
    },
  });

  const [search, setSearch] = useState("");
  const [wsId, setWsId] = useState("all");
  const [reportId, setReportId] = useState("all");
  const [criticality, setCriticality] = useState("all");

  const allRows = rows || [];

  const workstreams = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of allRows) {
      const ws = r.scenario.reports?.workstreams;
      if (ws?.id) m.set(ws.id, ws.name);
    }
    return Array.from(m, ([id, name]) => ({ id, name }));
  }, [allRows]);

  const reportOpts = useMemo(() => {
    const m = new Map<string, { id: string; name: string; workstream_id: string }>();
    for (const r of allRows) {
      const rep = r.scenario.reports;
      if (rep?.id) m.set(rep.id, { id: rep.id, name: rep.name, workstream_id: rep.workstream_id });
    }
    return Array.from(m.values()).filter((r) => wsId === "all" || r.workstream_id === wsId);
  }, [allRows, wsId]);

  const all = useMemo(() => {
    const q = search.toLowerCase().trim();
    return allRows.filter((r) => {
      const s = r.scenario;
      if (wsId !== "all" && s.reports?.workstream_id !== wsId) return false;
      if (reportId !== "all" && s.report_id !== reportId) return false;
      if (criticality !== "all") {
        const c = (r.latest?.criticality || s.criticality || "medium").toLowerCase();
        if (c !== criticality) return false;
      }
      if (!q) return true;
      return (
        s.title?.toLowerCase().includes(q) ||
        s.reports?.name?.toLowerCase().includes(q) ||
        s.reports?.workstreams?.name?.toLowerCase().includes(q) ||
        r.latest?.analysis?.toLowerCase().includes(q)
      );
    });
  }, [allRows, search, wsId, reportId, criticality]);

  const passed = all.filter((r) => r.overallStatus === "pass");
  const failed = all.filter((r) => r.overallStatus === "fail");
  const ran = all.filter((r) => r.latest && r.overallStatus !== "pending");
  const pending = all.filter((r) => !r.latest || r.overallStatus === "pending");

  // workstream rollup of latest-per-scenario
  const wsMap = new Map<string, { id: string; name: string; pass: number; fail: number; total: number }>();
  for (const r of all) {
    const ws = r.scenario.reports?.workstreams;
    if (!ws?.id) continue;
    const cur = wsMap.get(ws.id) || { id: ws.id, name: ws.name, pass: 0, fail: 0, total: 0 };
    cur.total += 1;
    if (r.overallStatus === "pass") cur.pass += 1;
    if (r.overallStatus === "fail") cur.fail += 1;
    wsMap.set(ws.id, cur);
  }
  const wsRows = Array.from(wsMap.values()).sort((a, b) => b.fail - a.fail);

  return (
    <AppLayout>
      <div className="p-8 space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">Latest status across all test scenarios.</p>
        </div>

        <div className="flex gap-2 flex-wrap items-center">
          <Input
            placeholder="Search scenario, report, workstream, analysis…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-sm"
          />
          <Select value={wsId} onValueChange={(v) => { setWsId(v); setReportId("all"); }}>
            <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All reports</SelectItem>
              {workstreams.map((w) => <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={reportId} onValueChange={setReportId}>
            <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All reports</SelectItem>
              {reportOpts.map((r) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={criticality} onValueChange={setCriticality}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All criticality</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="low">Low</SelectItem>
            </SelectContent>
          </Select>
          <div className="text-xs text-muted-foreground mono ml-auto">{all.length} scenarios</div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Stat label="Total scenarios" value={all.length} linkTo="/scenarios" />
          <Stat label="Cases ran" value={ran.length} linkTo="/scenarios?status=ran" />
          <Stat
            label="Passed"
            value={passed.length}
            tone="success"
            linkTo="/scenarios?status=pass"
          />
          <Stat
            label="Failed"
            value={failed.length}
            tone="destructive"
            linkTo="/scenarios?status=fail"
          />
        </div>

        <Card>
          <CardHeader>
            <CardTitle>By report</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {wsRows.map((w) => (
              <WorkstreamRow key={w.id} ws={w} rows={all.filter((r) => r.scenario.reports?.workstream_id === w.id)} lastRunByReport={lastRunByReport || {}} />
            ))}
            {!wsRows.length && (
              <div className="text-sm text-muted-foreground">No scenarios configured.</div>
            )}
          </CardContent>
        </Card>

        {pending.length > 0 && (
          <div className="text-xs text-muted-foreground">
            {pending.length} scenarios have not run yet —{" "}
            <Link to="/scenarios?status=pending" className="text-accent hover:underline">view</Link>
          </div>
        )}
      </div>
    </AppLayout>
  );
}

function WorkstreamRow({ ws, rows, lastRunByReport }: { ws: any; rows: Row[]; lastRunByReport: Record<string, string> }) {
  const [open, setOpen] = useState(true);
  const navigate = useNavigate();
  // group by report
  const reportMap = new Map<string, { id: string; name: string; pass: number; fail: number; total: number }>();
  for (const r of rows) {
    const rep = r.scenario.reports;
    if (!rep?.id) continue;
    const cur = reportMap.get(rep.id) || { id: rep.id, name: rep.name, pass: 0, fail: 0, total: 0 };
    cur.total += 1;
    if (r.overallStatus === "pass") cur.pass += 1;
    if (r.overallStatus === "fail") cur.fail += 1;
    reportMap.set(rep.id, cur);
  }
  const reports = Array.from(reportMap.values());

  return (
    <div className="border border-border rounded-md">
      <div className="flex items-center gap-3 p-3">
        <button onClick={() => setOpen(!open)} className="text-muted-foreground hover:text-foreground">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <div className="flex-1">
          <div className="text-sm font-medium">{ws.name}</div>
          <div className="text-xs text-muted-foreground mono">{reports.length} reports · {ws.total} scenarios</div>
        </div>
        <div className="flex gap-3 text-sm">
          <Link to={`/scenarios?status=pass&workstream_id=${ws.id}`} className="text-success hover:underline">
            {ws.pass} passed
          </Link>
          <Link to={`/scenarios?status=fail&workstream_id=${ws.id}`} className="text-destructive hover:underline">
            {ws.fail} failed
          </Link>
        </div>
      </div>
      {open && (
        <div className="border-t border-border bg-secondary/20 p-3 space-y-1">
          {reports.length === 0 && (
            <div className="text-xs text-muted-foreground">No screens in this report.</div>
          )}
          {reports.map((r) => {
            const runId = lastRunByReport[r.id];
            const handleClick = (e: React.MouseEvent) => {
              e.preventDefault();
              if (runId) {
                navigate(`/runs/${runId}`);
              } else {
                toast.error("No runs found for this report yet");
              }
            };
            return (
              <div key={r.id} className="flex items-center gap-3 px-2 py-1.5 rounded hover:bg-background/60">
                <a href="#" onClick={handleClick} className="text-sm flex-1 hover:text-accent cursor-pointer">{r.name}</a>
                <span className="text-xs text-muted-foreground mono">{r.total} scenarios</span>
                <div className="flex gap-2 text-xs w-32 justify-end">
                  <Link to={`/scenarios?status=pass&workstream_id=${ws.id}`} className="text-success hover:underline">{r.pass}✓</Link>
                  <Link to={`/scenarios?status=fail&workstream_id=${ws.id}`} className="text-destructive hover:underline">{r.fail}✗</Link>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  linkTo,
}: {
  label: string;
  value: number | string;
  tone?: string;
  linkTo?: string;
}) {
  const c: Record<string, string> = {
    success: "text-success",
    destructive: "text-destructive",
    warning: "text-warning",
  };
  const inner = (
    <Card className={linkTo ? "hover:border-accent/50 transition-colors cursor-pointer" : ""}>
      <CardContent className="pt-6">
        <div className="text-xs text-muted-foreground uppercase tracking-wide mono">{label}</div>
        <div className={`text-3xl font-semibold mt-1 ${c[tone || ""] || ""}`}>{value}</div>
      </CardContent>
    </Card>
  );
  return linkTo ? <Link to={linkTo}>{inner}</Link> : inner;
}

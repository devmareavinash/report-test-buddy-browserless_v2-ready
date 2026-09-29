import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { invokeFunction } from "@/lib/functions";
import { useParams, Link } from "react-router-dom";
import { AppLayout } from "@/components/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusChip } from "@/components/StatusChip";
import { toast } from "sonner";
import { Play, Sparkles, Pencil, Trash2, Plus, ChevronRight, Loader2, Copy } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ReportDialog } from "./Reports";
import { ConcurrencySelect, readOrchestrateConcurrency, useOrchestrateConcurrency } from "@/components/ConcurrencySelect";
import { duplicateReport, duplicateScenario } from "@/lib/duplicateEntities";
import { deleteReport, deleteScenario, deleteReportConfirm, deleteScenarioConfirm } from "@/lib/deleteEntities";
import { useExecutionLocks } from "@/hooks/useExecutionLocks";

const CRIT = ["low", "medium", "high", "critical"];

export default function ReportDetail() {
  const { id } = useParams();
  const qc = useQueryClient();
  const executionLocks = useExecutionLocks();

  const { data: report } = useQuery({
    queryKey: ["report", id],
    queryFn: async () => {
      const { data: r } = await supabase.from("reports").select("*").eq("id", id!).maybeSingle();
      if (!r) return null;
      const { data: ws } = await supabase.from("workstreams").select("name").eq("id", r.workstream_id).maybeSingle();
      return { ...r, workstreams: ws };
    },
  });
  const { data: scenarios } = useQuery({
    queryKey: ["scenarios", id],
    queryFn: async () =>
      (await supabase.from("scenarios").select("*").eq("report_id", id!).order("created_at")).data ?? [],
  });
  const { data: prerun } = useQuery({
    queryKey: ["prerun", id],
    queryFn: async () =>
      (await supabase.from("prerun_scripts").select("*").eq("report_id", id!).order("created_at")).data ?? [],
  });
  const { data: runs } = useQuery({
    queryKey: ["runs-report", id, (report as any)?.workstream_id],
    enabled: !!id,
    queryFn: async () => {
      const wsId = (report as any)?.workstream_id;
      const filter = wsId
        ? `and(scope_type.eq.report,scope_id.eq.${id}),and(scope_type.eq.workstream,scope_id.eq.${wsId})`
        : `and(scope_type.eq.report,scope_id.eq.${id})`;
      return (await supabase.from("runs").select("*").or(filter).order("started_at", { ascending: false })).data ?? [];
    },
    refetchInterval: (q) =>
      (q.state.data as any[] | undefined)?.some((r) => r.status === "running") ? 3000 : false,
    staleTime: 0,
    refetchOnMount: "always",
  });

  const [tab, setTab] = useState("scenarios");
  const [genContext, setGenContext] = useState("");
  const { concurrency, setConcurrency } = useOrchestrateConcurrency();
  const genScenarios = useMutation({
    mutationFn: async () => {
      const { data, error } = await invokeFunction("agent-scenarios", { report_id: id, context: genContext });
      if (error) throw error;
      return data as any;
    },
    onSuccess: (data: any) => {
      const inserted = Number(data?.inserted || 0);
      const generated = Number(data?.generated || 0);
      if (inserted > 0) {
        toast.success(`${inserted} scenario${inserted === 1 ? "" : "s"} generated`);
        setGenContext("");
      } else if (generated > 0) {
        toast.warning("Scenario suggestions were created, but none could be saved. Review the returned errors.");
      } else {
        toast.info("No new scenario was generated. The request may already be covered or needs more specific labels.");
      }
      qc.invalidateQueries({ queryKey: ["scenarios", id] });
    },
    onError: (e: any) => toast.error(e?.message || "Scenario generation failed"),
  });
  const runSuite = useMutation({
    mutationFn: async () => {
      const { data, error } = await invokeFunction("agent-orchestrate", {
        scope_type: "report",
        scope_id: id,
        concurrency,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (d: any) => {
      const shortId = d?.run_id ? String(d.run_id).slice(0, 8) : "—";
      toast.success(`Run: ${shortId} is in progress`);
      qc.invalidateQueries({ queryKey: ["active-execution-locks"] });
      qc.invalidateQueries({ queryKey: ["runs-report", id] });
      qc.invalidateQueries({ queryKey: ["scenario-results"] });
      qc.invalidateQueries({ queryKey: ["tests-overview"] });
      setTab("runs");
    },
    onError: (e: any) => toast.error(e?.message || "Could not start the run"),
  });

  if (!report) return <AppLayout><div className="p-8">Loading…</div></AppLayout>;

  return (
    <AppLayout>
      <div className="p-8 space-y-6">
        <ReportHeader report={report} />
        <div className="space-y-2">
          <Textarea
            value={genContext}
            onChange={(e) => setGenContext(e.target.value)}
            placeholder="Optional context for scenario generation (e.g. focus areas, business rules, known edge cases)…"
            className="min-h-[80px] text-sm"
          />
          <div className="flex gap-2">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0}>
                    <Button
                      variant="outline"
                      onClick={() => genScenarios.mutate()}
                      disabled={genScenarios.isPending || !genContext.trim()}
                    >
                      <Sparkles className="h-4 w-4 mr-1" /> {genScenarios.isPending ? "Generating…" : "Generate scenarios"}
                    </Button>
                  </span>
                </TooltipTrigger>
                {!genContext.trim() && (
                  <TooltipContent>Add context above to generate scenarios</TooltipContent>
                )}
              </Tooltip>
            </TooltipProvider>
            <ConcurrencySelect
              unit="scenarios"
              value={concurrency}
              onChange={setConcurrency}
              disabled={runSuite.isPending || executionLocks.isReportRunning(id!, report.workstream_id)}
            />
            <Button
              onClick={() => runSuite.mutate()}
              disabled={runSuite.isPending || executionLocks.isReportRunning(id!, report.workstream_id)}
            >
              {runSuite.isPending || executionLocks.isReportRunning(id!, report.workstream_id)
                ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Running suite…</>
                : <><Play className="h-4 w-4 mr-1" /> Run suite</>}
            </Button>
          </div>
        </div>


        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="scenarios">Scenarios</TabsTrigger>
            <TabsTrigger value="prerun">Prerun script</TabsTrigger>
            <TabsTrigger value="runs">Runs</TabsTrigger>
            <TabsTrigger value="schedule">Schedule</TabsTrigger>
            <TabsTrigger value="history">Version history</TabsTrigger>
          </TabsList>

          <TabsContent value="scenarios" className="space-y-2 mt-4">
            <NewScenarioForm reportId={id!} />
            {(scenarios || []).map((s: any) => (
              <ScenarioRow key={s.id} s={s} reportId={id!} />
            ))}
            {!scenarios?.length && <div className="text-sm text-muted-foreground">No scenarios yet.</div>}
          </TabsContent>

          <TabsContent value="prerun" className="space-y-3 mt-4">
            <PrerunEditor reportId={id!} existing={prerun?.[0]} />
            <div className="text-xs text-muted-foreground">
              Prerun runs once before each scenario in this report — perfect for login + default filter selection.
            </div>
          </TabsContent>

          <TabsContent value="runs" className="space-y-2 mt-4">
            {(runs || []).map((r) => (
              <div key={r.id} className="flex items-center justify-between border border-border rounded-md p-3 hover:bg-secondary/40 gap-2">
                <Link to={`/runs/${r.id}`} className="flex items-center justify-between flex-1 min-w-0 gap-3">
                  <span className="mono text-xs">{r.id.slice(0, 8)}</span>
                  <span className="text-[10px] uppercase mono px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">
                    {r.scope_type === "workstream" ? "report" : "screen"}
                  </span>
                  <span className="text-xs">{(r.summary as any)?.pass ?? 0}✓ / {(r.summary as any)?.fail ?? 0}✗</span>
                  <span className="text-xs text-muted-foreground">{new Date(r.started_at!).toLocaleString()}</span>
                  <StatusChip status={r.status} />
                </Link>
                {r.status !== "running" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive shrink-0"
                    onClick={async () => {
                      if (!confirm(`Delete run ${r.id.slice(0, 8)} and all its results?`)) return;
                      const { error } = await supabase.from("runs").delete().eq("id", r.id);
                      if (error) toast.error(error.message);
                      else {
                        toast.success("Run deleted");
                        qc.invalidateQueries({ queryKey: ["runs-report", id] });
                        qc.invalidateQueries({ queryKey: ["all-runs"] });
                        qc.invalidateQueries({ queryKey: ["scenario-results"] });
                      }
                    }}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                )}
              </div>
            ))}
            {!runs?.length && <div className="text-sm text-muted-foreground">No runs yet.</div>}
          </TabsContent>

          <TabsContent value="schedule" className="space-y-3 mt-4">
            <ScheduleEditor reportId={id!} />
          </TabsContent>

          <TabsContent value="history" className="space-y-3 mt-4">
            <VersionHistory reportId={id!} scenarios={scenarios || []} />
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}

function ReportHeader({ report }: { report: any }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [edit, setEdit] = useState(false);
  const [duping, setDuping] = useState(false);
  const { data: tree } = useQuery({
    queryKey: ["report-tree"],
    queryFn: async () => {
      const ws = (await supabase.from("workstreams").select("*").order("name")).data ?? [];
      const rep = (await supabase.from("reports").select("*").order("name")).data ?? [];
      return { ws, rep };
    },
  });
  const del = async () => {
    if (!confirm(deleteReportConfirm(report.name))) return;
    try {
      await deleteReport(report.id);
      toast.success("Screen deleted");
      navigate("/reports");
    } catch (e: any) {
      toast.error(e?.message || "Delete failed");
    }
  };
  const dup = async () => {
    setDuping(true);
    try {
      const copy = await duplicateReport(report.id);
      toast.success(`Duplicated screen as "${copy.name}"`);
      qc.invalidateQueries({ queryKey: ["report-tree"] });
      qc.invalidateQueries({ queryKey: ["report-status-map"] });
      navigate(`/reports/${copy.id}`);
    } catch (e: any) {
      toast.error(e?.message || "Duplicate failed");
    } finally {
      setDuping(false);
    }
  };
  return (
    <div className="flex items-start justify-between">
      <div className="space-y-1 flex-1">
        <div className="text-xs text-muted-foreground mono">{report.workstreams?.name}</div>
        <h1 className="text-2xl font-semibold">{report.name}</h1>
        <a href={report.url} target="_blank" className="text-xs text-accent mono break-all">{report.url}</a>
        {report.reference_url && <div className="text-xs text-muted-foreground mono">ref: {report.reference_url}</div>}
      </div>
      <div className="flex flex-wrap gap-1 items-center justify-end">
        <Button size="sm" variant="outline" onClick={() => setEdit(true)}><Pencil className="h-3 w-3 mr-1" /> Edit Screen Details</Button>
        <Button size="sm" variant="outline" onClick={dup} disabled={duping} title="Duplicate this screen, test cases, saved scripts, mappings, and filter combinations">
          {duping ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Copy className="h-3 w-3 mr-1" />}
          Duplicate
        </Button>
        <Button size="sm" variant="outline" onClick={del} className="text-destructive hover:text-destructive" title="Delete screen and its test cases, scripts, mappings, and results"><Trash2 className="h-3 w-3 mr-1" /> Delete</Button>
      </div>
      <ReportDialog tree={tree} report={report} open={edit} onOpenChange={setEdit} />
    </div>
  );
}

function VersionHistory({ reportId, scenarios }: { reportId: string; scenarios: any[] }) {
  const sids = scenarios.map((s) => s.id);
  const { data: scenVersions } = useQuery({
    queryKey: ["scenario-versions", reportId],
    queryFn: async () => {
      if (!sids.length) return [];
      return (await supabase.from("scenario_versions").select("*").in("scenario_id", sids).order("created_at", { ascending: false }).limit(200)).data ?? [];
    },
  });
  const { data: scriptVersions } = useQuery({
    queryKey: ["script-versions", reportId],
    queryFn: async () => {
      if (!sids.length) return [];
      return (await supabase.from("script_versions").select("*").in("scenario_id", sids).order("created_at", { ascending: false }).limit(200)).data ?? [];
    },
  });
  const titleOf = (sid: string) => scenarios.find((s) => s.id === sid)?.title || sid.slice(0, 8);
  return (
    <div className="grid md:grid-cols-2 gap-4">
      <Card>
        <CardHeader><CardTitle className="text-sm">Scenario versions</CardTitle></CardHeader>
        <CardContent className="space-y-1">
          {(scenVersions || []).map((v: any) => (
            <Link key={v.id} to={`/scenarios/${v.scenario_id}`} className="flex items-center justify-between text-xs border border-border rounded px-2 py-1.5 hover:bg-secondary/40">
              <span className="mono">v{v.version}</span>
              <span className="flex-1 truncate mx-2">{titleOf(v.scenario_id)}</span>
              <span className="text-muted-foreground mono">{new Date(v.created_at).toLocaleString()}</span>
            </Link>
          ))}
          {!scenVersions?.length && <div className="text-xs text-muted-foreground">No versions yet.</div>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-sm">Script versions</CardTitle></CardHeader>
        <CardContent className="space-y-1">
          {(scriptVersions || []).map((v: any) => (
            <Link key={v.id} to={`/scenarios/${v.scenario_id}`} className="flex items-center justify-between text-xs border border-border rounded px-2 py-1.5 hover:bg-secondary/40">
              <span className="mono">v{v.version}</span>
              <span className="flex-1 truncate mx-2">{titleOf(v.scenario_id)}</span>
              <span className="text-muted-foreground mono">{new Date(v.created_at).toLocaleString()}</span>
            </Link>
          ))}
          {!scriptVersions?.length && <div className="text-xs text-muted-foreground">No versions yet.</div>}
        </CardContent>
      </Card>
    </div>
  );
}

function NewScenarioForm({ reportId }: { reportId: string }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [type, setType] = useState("warehouse_match");
  const [crit, setCrit] = useState("medium");
  const add = async () => {
    if (!title) return;
    await supabase.from("scenarios").insert({ report_id: reportId, title, type, criticality: crit });
    setTitle("");
    qc.invalidateQueries({ queryKey: ["scenarios", reportId] });
  };
  return (
    <div className="flex gap-2 items-center border border-dashed border-border rounded-md p-2">
      <Input className="flex-1" placeholder="New scenario title" value={title} onChange={(e) => setTitle(e.target.value)} />
      <Select value={type} onValueChange={setType}>
        <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
        <SelectContent>
          {["warehouse_match", "reference_match", "trend", "range_check", "functional_check"].map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
        </SelectContent>
      </Select>
      <Select value={crit} onValueChange={setCrit}>
        <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
        <SelectContent>{CRIT.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
      </Select>
      <Button size="sm" onClick={add}><Plus className="h-3 w-3 mr-1" /> Add</Button>
    </div>
  );
}

function ScenarioRow({ s, reportId }: { s: any; reportId: string }) {
  const qc = useQueryClient();
  const [duping, setDuping] = useState(false);
  const update = async (patch: any) => {
    await supabase.from("scenarios").update(patch).eq("id", s.id);
    qc.invalidateQueries({ queryKey: ["scenarios", reportId] });
  };
  const del = async () => {
    if (!confirm(deleteScenarioConfirm(s.title))) return;
    try {
      await deleteScenario(s.id);
      toast.success("Test case deleted");
      qc.invalidateQueries({ queryKey: ["scenarios", reportId] });
    } catch (e: any) {
      toast.error(e?.message || "Delete failed");
    }
  };
  const dup = async () => {
    setDuping(true);
    try {
      const copy = await duplicateScenario(s.id);
      toast.success(`Duplicated as "${copy.title}"`);
      qc.invalidateQueries({ queryKey: ["scenarios", reportId] });
    } catch (e: any) {
      toast.error(e?.message || "Duplicate failed");
    } finally {
      setDuping(false);
    }
  };
  return (
    <Card className={s.deferred ? "opacity-60" : ""}>
      <CardContent className="pt-4 flex items-center gap-2">
        <Link to={`/scenarios/${s.id}`} className="flex-1 group">
          <div className="font-medium text-sm group-hover:text-accent flex items-center gap-1">
            {s.title} <ChevronRight className="h-3 w-3 opacity-50" />
          </div>
          <div className="text-[10px] text-muted-foreground mono mt-1">{s.type} · {s.criticality}{s.deferred && " · deferred"}</div>
        </Link>
        <Select value={s.criticality} onValueChange={(v) => update({ criticality: v })}>
          <SelectTrigger className="w-28 h-8"><SelectValue /></SelectTrigger>
          <SelectContent>{CRIT.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
        </Select>
        <Button size="sm" variant="ghost" onClick={() => update({ deferred: !s.deferred })}>{s.deferred ? "Restore" : "Defer"}</Button>
        <Button size="sm" variant="ghost" onClick={dup} disabled={duping} title="Duplicate this test case including its saved script, filter combinations, KPI settings, and SQL binding">
          {duping ? <Loader2 className="h-3 w-3 animate-spin" /> : <Copy className="h-3 w-3" />}
        </Button>
        <Button size="sm" variant="ghost" onClick={del} title="Delete this test case, its saved script, filter combinations, and version history"><Trash2 className="h-3 w-3" /></Button>
      </CardContent>
    </Card>
  );
}

function PrerunEditor({ reportId, existing }: { reportId: string; existing?: any }) {
  const qc = useQueryClient();
  const [name, setName] = useState(existing?.name || "Default prerun");
  const [code, setCode] = useState(existing?.playwright_code || `// Login + filter setup\nawait page.goto(process.env.LOGIN_URL);\nawait page.fill('#user', process.env.USERNAME);\nawait page.fill('#pass', process.env.PASSWORD);\nawait page.click('button[type=submit]');\nawait page.waitForURL('**/dashboard**');`);
  const save = async () => {
    if (existing) await supabase.from("prerun_scripts").update({ name, playwright_code: code }).eq("id", existing.id);
    else await supabase.from("prerun_scripts").insert({ report_id: reportId, name, playwright_code: code });
    toast.success("Saved");
    qc.invalidateQueries({ queryKey: ["prerun", reportId] });
  };
  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">Shared prerun script</CardTitle></CardHeader>
      <CardContent className="space-y-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} />
        <Textarea className="mono text-xs min-h-[200px]" value={code} onChange={(e) => setCode(e.target.value)} />
        <div className="flex gap-2">
          <Button onClick={save}>Save</Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Headed / live debug is not available on self-hosted Browserless OSS. Use a scenario Run headless from the scenario page.
        </p>
      </CardContent>
    </Card>
  );
}

const FREQ_PRESETS: Record<string, (h: number, m: number, dow: string) => string> = {
  hourly: (_h, m) => `${m} * * * *`,
  daily: (h, m) => `${m} ${h} * * *`,
  weekdays: (h, m) => `${m} ${h} * * 1-5`,
  weekly: (h, m, dow) => `${m} ${h} * * ${dow}`,
};

function cronToPreset(cron: string): { freq: string; hour: number; minute: number; dow: string } {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return { freq: "daily", hour: 7, minute: 0, dow: "1" };
  const [m, h, , , d] = parts;
  if (h === "*") return { freq: "hourly", hour: 0, minute: parseInt(m) || 0, dow: "1" };
  if (d === "1-5") return { freq: "weekdays", hour: parseInt(h) || 0, minute: parseInt(m) || 0, dow: "1" };
  if (d !== "*") return { freq: "weekly", hour: parseInt(h) || 0, minute: parseInt(m) || 0, dow: d };
  return { freq: "daily", hour: parseInt(h) || 0, minute: parseInt(m) || 0, dow: "1" };
}

function describe(cron: string): string {
  const p = cronToPreset(cron);
  const time = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  if (p.freq === "hourly") return `Every hour at :${String(p.minute).padStart(2, "0")}`;
  if (p.freq === "daily") return `Every day at ${time}`;
  if (p.freq === "weekdays") return `Weekdays at ${time}`;
  if (p.freq === "weekly") return `Every ${days[parseInt(p.dow)] || "Mon"} at ${time}`;
  return cron;
}

function ScheduleEditor({ reportId }: { reportId: string }) {
  const qc = useQueryClient();
  const { data: schedules } = useQuery({
    queryKey: ["schedules", reportId],
    queryFn: async () =>
      (await supabase.from("schedules").select("*").eq("scope_type", "report").eq("scope_id", reportId).order("created_at", { ascending: false })).data ?? [],
  });

  const [freq, setFreq] = useState("daily");
  const [hour, setHour] = useState(7);
  const [minute, setMinute] = useState(0);
  const [dow, setDow] = useState("1");
  const [comparator, setComparator] = useState<string>("eq");
  const browserTz = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC";
  const [timezone, setTimezone] = useState<string>(browserTz || "UTC");

  const TZ_OPTIONS = Array.from(new Set([
    browserTz, "UTC",
    "America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York",
    "Europe/London", "Europe/Berlin", "Europe/Paris", "Asia/Dubai",
    "Asia/Kolkata", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney",
  ].filter(Boolean))) as string[];

  const cron = (FREQ_PRESETS[freq] || FREQ_PRESETS.daily)(hour, minute, dow);

  const save = async () => {
    const { error } = await supabase.from("schedules").insert({ scope_type: "report", scope_id: reportId, cron, enabled: true, comparator, timezone });
    if (error) return toast.error(error.message);
    toast.success(`Scheduled — ${describe(cron)} (${timezone})`);
    qc.invalidateQueries({ queryKey: ["schedules", reportId] });
  };

  const toggle = async (s: any) => {
    await supabase.from("schedules").update({ enabled: !s.enabled }).eq("id", s.id);
    qc.invalidateQueries({ queryKey: ["schedules", reportId] });
  };
  const del = async (s: any) => {
    await supabase.from("schedules").delete().eq("id", s.id);
    qc.invalidateQueries({ queryKey: ["schedules", reportId] });
  };
  const updateComparator = async (s: any, v: string) => {
    await supabase.from("schedules").update({ comparator: v }).eq("id", s.id);
    qc.invalidateQueries({ queryKey: ["schedules", reportId] });
  };
  const updateTimezone = async (s: any, v: string) => {
    await supabase.from("schedules").update({ timezone: v }).eq("id", s.id);
    qc.invalidateQueries({ queryKey: ["schedules", reportId] });
  };
  const runNow = async (s: any) => {
    try {
      await invokeFunction("agent-orchestrate", { scope_type: "report", scope_id: reportId, trigger_source: "schedule_manual", schedule_id: s.id, concurrency: readOrchestrateConcurrency() });
      toast.success("Run started with schedule's comparator");
    } catch (e: any) {
      toast.error(e?.message || "Failed to start run");
    }
  };

  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">Schedule this report</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-4 gap-2">
          <div>
            <div className="text-[10px] text-muted-foreground mb-1 uppercase">Frequency</div>
            <Select value={freq} onValueChange={setFreq}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="hourly">Hourly</SelectItem>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="weekdays">Weekdays (Mon–Fri)</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {freq === "weekly" && (
            <div>
              <div className="text-[10px] text-muted-foreground mb-1 uppercase">Day</div>
              <Select value={dow} onValueChange={setDow}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => (
                    <SelectItem key={i} value={String(i)}>{d}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {freq !== "hourly" && (
            <div>
              <div className="text-[10px] text-muted-foreground mb-1 uppercase">Hour</div>
              <Select value={String(hour)} onValueChange={(v) => setHour(parseInt(v))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent className="max-h-60">
                  {Array.from({ length: 24 }, (_, i) => (
                    <SelectItem key={i} value={String(i)}>{String(i).padStart(2, "0")}:00</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div>
            <div className="text-[10px] text-muted-foreground mb-1 uppercase">Minute</div>
            <Select value={String(minute)} onValueChange={(v) => setMinute(parseInt(v))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-60">
                {[0, 5, 10, 15, 20, 30, 45].map((m) => (
                  <SelectItem key={m} value={String(m)}>:{String(m).padStart(2, "0")}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex items-end gap-2 bg-secondary/40 rounded p-3 flex-wrap">
          <div className="flex-1 min-w-[200px]">
            <div className="text-sm">{describe(cron)}</div>
            <div className="text-[10px] text-muted-foreground mono mt-0.5">cron: {cron} · tz: {timezone}</div>
          </div>
          <div>
            <div className="text-[10px] text-muted-foreground mb-1 uppercase">Timezone</div>
            <Select value={timezone} onValueChange={setTimezone}>
              <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-60">
                {TZ_OPTIONS.map((tz) => <SelectItem key={tz} value={tz}>{tz}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <div className="text-[10px] text-muted-foreground mb-1 uppercase">Reference check</div>
            <Select value={comparator} onValueChange={setComparator}>
              <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="gte">actual ≥ reference</SelectItem>
                <SelectItem value="gt">actual &gt; reference</SelectItem>
                <SelectItem value="eq">actual = reference (±tolerance)</SelectItem>
                <SelectItem value="lte">actual ≤ reference</SelectItem>
                <SelectItem value="lt">actual &lt; reference</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button onClick={save}><Plus className="h-3 w-3 mr-1" /> Add schedule</Button>
        </div>

        <div className="space-y-1">
          <div className="text-[10px] text-muted-foreground uppercase mono">Active schedules</div>
          {(schedules || []).map((s: any) => (
            <div key={s.id} className={`flex items-center justify-between border border-border rounded p-2 text-sm gap-2 ${!s.enabled ? "opacity-50" : ""}`}>
              <div className="flex-1 min-w-0">
                <div className="truncate">{describe(s.cron)}</div>
                <div className="text-[10px] text-muted-foreground mono truncate">{s.cron} · {s.timezone || "UTC"}</div>
              </div>
              <Select value={s.timezone || "UTC"} onValueChange={(v) => updateTimezone(s, v)}>
                <SelectTrigger className="w-40 h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent className="max-h-60">
                  {TZ_OPTIONS.map((tz) => <SelectItem key={tz} value={tz}>{tz}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={s.comparator || "eq"} onValueChange={(v) => updateComparator(s, v)}>
                <SelectTrigger className="w-52 h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="gte">actual ≥ reference</SelectItem>
                  <SelectItem value="gt">actual &gt; reference</SelectItem>
                  <SelectItem value="eq">actual = reference</SelectItem>
                  <SelectItem value="lte">actual ≤ reference</SelectItem>
                  <SelectItem value="lt">actual &lt; reference</SelectItem>
                </SelectContent>
              </Select>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => runNow(s)} title="Run now with this schedule's comparator"><Play className="h-3 w-3" /></Button>
                <Button size="sm" variant="ghost" onClick={() => toggle(s)}>{s.enabled ? "Pause" : "Resume"}</Button>
                <Button size="sm" variant="ghost" onClick={() => del(s)}><Trash2 className="h-3 w-3" /></Button>
              </div>
            </div>
          ))}
          {!schedules?.length && <div className="text-xs text-muted-foreground">No schedules yet.</div>}
        </div>
      </CardContent>
    </Card>
  );
}

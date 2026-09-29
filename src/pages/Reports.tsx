import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { invokeFunction } from "@/lib/functions";
import { AppLayout } from "@/components/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Link } from "react-router-dom";
import React, { useMemo, useState } from "react";
import { toast } from "sonner";
import { Play, Plus, Pencil, Trash2, ExternalLink, Loader2, Download, Copy } from "lucide-react";
import { ConcurrencySelect, useOrchestrateConcurrency } from "@/components/ConcurrencySelect";
import { exportScreensToExcel } from "@/lib/exportScreensExcel";
import { duplicateReport, duplicateWorkstream } from "@/lib/duplicateEntities";
import { deleteReport, deleteWorkstream, deleteReportConfirm, deleteWorkstreamConfirm } from "@/lib/deleteEntities";
import { fetchLatestTestResultsByScenarioIds } from "@/lib/latestTestResults";
import { useExecutionLocks } from "@/hooks/useExecutionLocks";

export default function Reports() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [wsId, setWsId] = useState("all");
  const [exporting, setExporting] = useState(false);
  const [editWorkstream, setEditWorkstream] = useState<{ id: string; name: string } | null>(null);
  const [dupingWsId, setDupingWsId] = useState<string | null>(null);
  const { concurrency, setConcurrency } = useOrchestrateConcurrency();
  const executionLocks = useExecutionLocks();
  const { data: tree } = useQuery({
    queryKey: ["report-tree"],
    queryFn: async () => {
      const ws = (await supabase.from("workstreams").select("*").order("name")).data ?? [];
      const rep = (await supabase.from("reports").select("*").order("name")).data ?? [];
      return { ws, rep };
    },
  });

  const { data: statusMap } = useQuery({
    queryKey: ["report-status-map"],
    queryFn: async () => {
      const scenarios = (await supabase
        .from("scenarios")
        .select("id, report_id")
        .eq("deferred", false)
        .limit(5000)).data ?? [];
      const latestRows = await fetchLatestTestResultsByScenarioIds(
        scenarios.map((s: any) => s.id),
        "scenario_id, status, created_at",
      );
      const latest = new Map<string, string>();
      for (const [sid, r] of latestRows) latest.set(sid, r.status as string);
      const map: Record<string, { pass: number; fail: number; pending: number; total: number }> = {};
      for (const s of scenarios) {
        const rep = s.report_id as string;
        if (!rep) continue;
        const m = (map[rep] ||= { pass: 0, fail: 0, pending: 0, total: 0 });
        m.total += 1;
        const st = latest.get(s.id as string);
        if (st === "pass") m.pass += 1;
        else if (st === "fail") m.fail += 1;
        else m.pending += 1;
      }
      return map;
    },
  });

  const run = useMutation({
    mutationFn: async (vars: { scope_type: string; scope_id: string }) => {
      const { data, error } = await invokeFunction("agent-orchestrate", { ...vars, concurrency });
      if (error) throw error;
      return data;
    },
    onSuccess: (d: any, vars) => {
      const shortId = d?.run_id ? String(d.run_id).slice(0, 8) : "—";
      toast.success(`Run: ${shortId} is in progress`);
      qc.invalidateQueries({ queryKey: ["active-execution-locks"] });
      qc.invalidateQueries({ queryKey: ["runs"] });
      if (vars.scope_type === "report") {
        qc.invalidateQueries({ queryKey: ["runs-report", vars.scope_id] });
      }
    },
    onError: (e: any) => toast.error(e.message),
  });

  const filteredReports = useMemo(() => {
    const q = search.toLowerCase().trim();
    return (tree?.rep || []).filter((r: any) => {
      if (wsId !== "all" && r.workstream_id !== wsId) return false;
      if (!q) return true;
      return r.name?.toLowerCase().includes(q) || r.url?.toLowerCase().includes(q);
    });
  }, [tree, search, wsId]);

  const visibleWs = (tree?.ws || []).filter((w: any) =>
    wsId === "all" ? true : w.id === wsId,
  );

  return (
    <AppLayout>
      <div className="p-8 space-y-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Screens</h1>
            <p className="text-sm text-muted-foreground">Report → Screen. Run a full suite at any level.</p>
          </div>
          <NewReportDialog tree={tree} />
        </div>

        <div className="flex gap-2 flex-wrap items-center">
          <Input
            placeholder="Search screens by name or URL…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-sm"
          />
          <Select value={wsId} onValueChange={setWsId}>
            <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All reports</SelectItem>
              {(tree?.ws || []).map((w: any) => (
                <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <ConcurrencySelect unit="screens" value={concurrency} onChange={setConcurrency} disabled={run.isPending} />
          <Button
            size="sm"
            variant="outline"
            disabled={exporting}
            onClick={async () => {
              setExporting(true);
              try {
                const counts = await exportScreensToExcel({ workstreamId: wsId, search });
                toast.success(`Exported ${counts.reports} report(s), ${counts.screens} screen(s), ${counts.testCases} test case(s)`);
              } catch (e: any) {
                toast.error(e?.message || "Export failed");
              } finally {
                setExporting(false);
              }
            }}
            title="Download reports, screens, and test cases as Excel"
          >
            {exporting ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Download className="h-3 w-3 mr-1" />}
            Export Excel
          </Button>
          <div className="text-xs text-muted-foreground mono ml-auto">{filteredReports.length} screens</div>
        </div>

        <div className="space-y-4">
          {visibleWs.map((w) => {
            const wsReports = filteredReports.filter((r: any) => r.workstream_id === w.id);
            if (search || wsId !== "all") {
              if (!wsReports.length) return null;
            }
            return (
              <Card key={w.id}>
                <CardHeader className="flex-row items-center justify-between">
                  <CardTitle className="text-base">{w.name}</CardTitle>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      title="Rename report"
                      onClick={() => setEditWorkstream(w)}
                    >
                      <Pencil className="h-3 w-3" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      title="Duplicate report including screens, test cases, saved scripts, mappings, and filter combinations"
                      disabled={dupingWsId === w.id}
                      onClick={async () => {
                        setDupingWsId(w.id);
                        try {
                          const copy = await duplicateWorkstream(w.id);
                          toast.success(`Duplicated report as "${copy.name}"`);
                          qc.invalidateQueries({ queryKey: ["report-tree"] });
                          qc.invalidateQueries({ queryKey: ["report-status-map"] });
                        } catch (e: any) {
                          toast.error(e?.message || "Duplicate failed");
                        } finally {
                          setDupingWsId(null);
                        }
                      }}
                    >
                      {dupingWsId === w.id
                        ? <Loader2 className="h-3 w-3 animate-spin" />
                        : <Copy className="h-3 w-3" />}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        (run.isPending && run.variables?.scope_id === w.id) ||
                        executionLocks.isWorkstreamRunning(w.id)
                      }
                      onClick={() => run.mutate({ scope_type: "workstream", scope_id: w.id })}
                    >
                      {(run.isPending && run.variables?.scope_id === w.id) ||
                      executionLocks.isWorkstreamRunning(w.id)
                        ? <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                        : <Play className="h-3 w-3 mr-1" />}
                      {executionLocks.isWorkstreamRunning(w.id) ? "Running…" : "Run report"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      title="Delete report and every screen, test case, script, and mapping inside it"
                      onClick={async () => {
                        if (!confirm(deleteWorkstreamConfirm(w.name))) return;
                        try {
                          await deleteWorkstream(w.id);
                          toast.success("Report deleted");
                          qc.invalidateQueries({ queryKey: ["report-tree"] });
                          qc.invalidateQueries({ queryKey: ["report-status-map"] });
                        } catch (e: any) {
                          toast.error(e?.message || "Delete failed");
                        }
                      }}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-1">
                  {wsReports.map((r: any) => (
                    <ReportRow
                      key={r.id}
                      r={r}
                      stats={statusMap?.[r.id]}
                      onRun={() => run.mutate({ scope_type: "report", scope_id: r.id })}
                      running={
                        (run.isPending && run.variables?.scope_id === r.id) ||
                        executionLocks.isReportRunning(r.id, r.workstream_id)
                      }
                    />
                  ))}
                  {!wsReports.length && (
                    <div className="text-xs text-muted-foreground">No screens yet.</div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
        <WorkstreamEditDialog
          workstream={editWorkstream}
          open={!!editWorkstream}
          onOpenChange={(open) => { if (!open) setEditWorkstream(null); }}
        />
      </div>
    </AppLayout>
  );
}

function WorkstreamEditDialog({
  workstream,
  open,
  onOpenChange,
}: {
  workstream: { id: string; name: string } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");

  React.useEffect(() => {
    if (open) setName(workstream?.name || "");
  }, [open, workstream]);

  const save = async () => {
    if (!workstream) return;
    const trimmed = name.trim();
    if (!trimmed) return toast.error("Report name is required");
    const { error } = await supabase.from("workstreams").update({ name: trimmed }).eq("id", workstream.id);
    if (error) return toast.error(error.message);
    toast.success("Report renamed");
    qc.invalidateQueries({ queryKey: ["report-tree"] });
    qc.invalidateQueries({ queryKey: ["ws"] });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename report</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="ws-name">Name</Label>
          <Input
            id="ws-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Report name"
            onKeyDown={(e) => { if (e.key === "Enter") save(); }}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReportRow({ r, stats, onRun, running }: { r: any; stats?: { pass: number; fail: number; pending: number; total: number }; onRun: () => void; running?: boolean }) {
  const qc = useQueryClient();
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
    if (!confirm(deleteReportConfirm(r.name))) return;
    try {
      await deleteReport(r.id);
      toast.success("Screen deleted");
      qc.invalidateQueries({ queryKey: ["report-tree"] });
      qc.invalidateQueries({ queryKey: ["report-status-map"] });
    } catch (e: any) {
      toast.error(e?.message || "Delete failed");
    }
  };
  const dup = async () => {
    setDuping(true);
    try {
      const copy = await duplicateReport(r.id);
      toast.success(`Duplicated as "${copy.name}"`);
      qc.invalidateQueries({ queryKey: ["report-tree"] });
      qc.invalidateQueries({ queryKey: ["report-status-map"] });
    } catch (e: any) {
      toast.error(e?.message || "Duplicate failed");
    } finally {
      setDuping(false);
    }
  };
  return (
    <div className="flex items-center justify-between hover:bg-secondary/40 rounded px-2 py-1.5 gap-2">
      <Link to={`/reports/${r.id}`} className="text-sm flex-1 truncate">{r.name}</Link>
      <span className="text-xs text-muted-foreground mono truncate max-w-xs">{r.url}</span>
      {stats && stats.total > 0 ? (
        <div className="flex gap-2 text-xs whitespace-nowrap">
          <Link to={`/scenarios?status=pass&workstream_id=${r.workstream_id}`} className="text-success hover:underline">{stats.pass}✓</Link>
          <Link to={`/scenarios?status=fail&workstream_id=${r.workstream_id}`} className="text-destructive hover:underline">{stats.fail}✗</Link>
          {stats.pending > 0 && <span className="text-muted-foreground">{stats.pending}·</span>}
          <span className="text-muted-foreground">/ {stats.total}</span>
        </div>
      ) : (
        <span className="text-xs text-muted-foreground">no scenarios</span>
      )}
      <Button size="sm" variant="ghost" onClick={() => setEdit(true)} title="Edit"><Pencil className="h-3 w-3" /></Button>
      <Button size="sm" variant="ghost" onClick={dup} disabled={duping} title="Duplicate screen including test cases, saved scripts, mappings, and filter combinations">
        {duping ? <Loader2 className="h-3 w-3 animate-spin" /> : <Copy className="h-3 w-3" />}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={onRun}
        disabled={running}
        title={running ? "This screen is already running" : "Run screen"}
      >
        {running
          ? <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> Running</>
          : <Play className="h-3 w-3" />}
      </Button>
      <Button size="sm" variant="ghost" onClick={del} className="text-destructive hover:text-destructive" title="Delete screen and its test cases, scripts, mappings, and results"><Trash2 className="h-3 w-3" /></Button>
      <ReportDialog tree={tree} report={r} open={edit} onOpenChange={setEdit} />
    </div>
  );
}

function NewReportDialog({ tree }: { tree: any }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4 mr-1" /> Add screen</Button>
      <ReportDialog tree={tree} open={open} onOpenChange={setOpen} />
    </>
  );
}

export function ReportDialog({
  tree,
  report,
  open,
  onOpenChange,
}: {
  tree: any;
  report?: any;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const isEdit = !!report;
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [refUrl, setRefUrl] = useState("");
  const [wsId, setWsId] = useState("");
  const [credId, setCredId] = useState("");
  const [refCredId, setRefCredId] = useState("");
  const [whId, setWhId] = useState("");
  const [tplId, setTplId] = useState("");

  // Hydrate when opening
  React.useEffect(() => {
    if (!open) return;
    setName(report?.name || "");
    setUrl(report?.url || "");
    setRefUrl(report?.reference_url || "");
    setWsId(report?.workstream_id || "");
    setCredId(report?.credential_profile_id || "");
    setRefCredId((report as any)?.reference_credential_profile_id || "");
    setWhId(report?.warehouse_connector_id || "");
    setTplId(report?.default_sql_template_id || "");
  }, [open, report]);

  const { data: creds } = useQuery({
    queryKey: ["cred-profiles"],
    queryFn: async () => (await supabase.from("credential_profiles").select("id,name,username").order("name")).data ?? [],
    enabled: open,
  });
  const { data: warehouses } = useQuery({
    queryKey: ["wh-connectors"],
    queryFn: async () => (await supabase.from("warehouse_connectors").select("id,name,kind").order("created_at", { ascending: false })).data ?? [],
    enabled: open,
  });
  const { data: tpls } = useQuery({
    queryKey: ["sql-templates-bind"],
    queryFn: async () => (await supabase.from("sql_templates").select("id,name,scope").order("name")).data ?? [],
    enabled: open,
  });

  const save = async () => {
    if (!wsId) return toast.error("Report is required");
    if (!name || !url) return toast.error("Name and URL are required");
    const payload = {
      name,
      url,
      reference_url: refUrl || null,
      workstream_id: wsId,
      credential_profile_id: credId || null,
      reference_credential_profile_id: refCredId || null,
      warehouse_connector_id: whId || null,
      default_sql_template_id: tplId || null,
    } as any;
    const { error } = isEdit
      ? await supabase.from("reports").update(payload).eq("id", report.id)
      : await supabase.from("reports").insert(payload);
    if (error) return toast.error(error.message);
    toast.success(isEdit ? "Screen updated" : "Screen added");
    onOpenChange(false);
    qc.invalidateQueries({ queryKey: ["report-tree"] });
    if (isEdit) qc.invalidateQueries({ queryKey: ["report", report.id] });
  };

  const openCredsTab = () => {
    const qs = url ? `&loginUrl=${encodeURIComponent(url)}` : "";
    window.open(`/settings?tab=creds${qs}`, "_blank");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl sm:max-w-3xl">
        <DialogHeader><DialogTitle>{isEdit ? "Edit screen" : "New screen"}</DialogTitle></DialogHeader>
        <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
          <div className="space-y-2">
            <Label>Report <span className="text-destructive">*</span></Label>
            <Select
              value={wsId}
              onValueChange={async (v) => {
                if (v === "__add_new__") {
                  const name = window.prompt("New report name:")?.trim();
                  if (!name) return;
                  const { data, error } = await supabase
                    .from("workstreams")
                    .insert({ name })
                    .select("id")
                    .single();
                  if (error) return toast.error(error.message);
                  toast.success("Report created");
                  qc.invalidateQueries({ queryKey: ["report-tree"] });
                  setWsId(data!.id as string);
                  return;
                }
                setWsId(v);
              }}
            >
              <SelectTrigger><SelectValue placeholder="Select report" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__add_new__" className="text-primary">
                  <span className="inline-flex items-center gap-1"><Plus className="h-3 w-3" />Create new report</span>
                </SelectItem>
                {(tree?.ws || []).map((w: any) => <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Screen Name <span className="text-destructive">*</span></Label>
            <Input placeholder="Screen name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Screen URL <span className="text-destructive">*</span></Label>
            <Input placeholder="Primary URL" value={url} onChange={(e) => setUrl(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Reference URL <span className="text-xs text-muted-foreground font-normal">(required for Reference matching scenarios)</span></Label>
            <Input placeholder="Reference report URL" value={refUrl} onChange={(e) => setRefUrl(e.target.value)} />
          </div>

          <div className="border-t pt-3 space-y-3">
            <div className="text-xs font-semibold uppercase text-muted-foreground">Test Script Configuration</div>
            <div className="space-y-2">
              <Label>Screen Login Credentials</Label>
              <Select
                value={credId || "__none__"}
                onOpenChange={(o) => { if (o) qc.invalidateQueries({ queryKey: ["cred-profiles"] }); }}
                onValueChange={(v) => {
                  if (v === "__add_new__") { openCredsTab(); return; }
                  setCredId(v === "__none__" ? "" : v);
                }}
              >
                <SelectTrigger><SelectValue placeholder="— Select credentials —" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">— None —</SelectItem>
                  {(creds || []).map((c: any) => (
                    <SelectItem key={c.id} value={c.id}>{c.name}{c.username ? ` · ${c.username}` : ""}</SelectItem>
                  ))}
                  <SelectItem value="__add_new__" className="text-primary">
                    <span className="inline-flex items-center gap-1"><Plus className="h-3 w-3" />Add New Credentials<ExternalLink className="h-3 w-3 ml-1" /></span>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Reference URL Login Credentials <span className="text-xs text-muted-foreground font-normal">(used when running the reference script)</span></Label>
              <Select
                value={refCredId || "__none__"}
                onOpenChange={(o) => { if (o) qc.invalidateQueries({ queryKey: ["cred-profiles"] }); }}
                onValueChange={(v) => {
                  if (v === "__add_new__") { openCredsTab(); return; }
                  setRefCredId(v === "__none__" ? "" : v);
                }}
              >
                <SelectTrigger><SelectValue placeholder="— Select credentials —" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">— None —</SelectItem>
                  {(creds || []).map((c: any) => (
                    <SelectItem key={c.id} value={c.id}>{c.name}{c.username ? ` · ${c.username}` : ""}</SelectItem>
                  ))}
                  <SelectItem value="__add_new__" className="text-primary">
                    <span className="inline-flex items-center gap-1"><Plus className="h-3 w-3" />Add New Credentials<ExternalLink className="h-3 w-3 ml-1" /></span>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="border-t pt-3 space-y-3">
            <div className="text-xs font-semibold uppercase text-muted-foreground">Warehouse SQL Configuration</div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Warehouse</Label>
                <Select
                  value={whId || "__none__"}
                  onOpenChange={(o) => { if (o) qc.invalidateQueries({ queryKey: ["wh-connectors"] }); }}
                  onValueChange={(v) => {
                    if (v === "__add_new__") { window.open(`/settings?tab=warehouse`, "_blank"); return; }
                    setWhId(v === "__none__" ? "" : v);
                  }}
                >
                  <SelectTrigger><SelectValue placeholder="— Select warehouse —" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">— None —</SelectItem>
                    {(warehouses || []).map((c: any) => (
                      <SelectItem key={c.id} value={c.id}>{c.name} · {c.kind}</SelectItem>
                    ))}
                    <SelectItem value="__add_new__" className="text-primary">
                      <span className="inline-flex items-center gap-1"><Plus className="h-3 w-3" />Add New Warehouse<ExternalLink className="h-3 w-3 ml-1" /></span>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>SQL Template</Label>
                <Select
                  value={tplId || "__none__"}
                  onOpenChange={(o) => { if (o) qc.invalidateQueries({ queryKey: ["sql-templates-bind"] }); }}
                  onValueChange={(v) => setTplId(v === "__none__" ? "" : v)}
                >
                  <SelectTrigger><SelectValue placeholder="— Select SQL template —" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">— None —</SelectItem>
                    {(tpls || []).map((t: any) => (
                      <SelectItem key={t.id} value={t.id}>{t.name} · {t.scope}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        </div>
        <DialogFooter><Button onClick={save}>Save</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

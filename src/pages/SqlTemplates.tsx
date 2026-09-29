import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { AppLayout } from "@/components/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useState } from "react";
import { toast } from "sonner";
import { Pencil, Trash2 } from "lucide-react";

export function SqlTemplatesContent() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["sql-templates"],
    queryFn: async () => (await supabase.from("sql_templates").select("*, reports!sql_templates_report_id_fkey(name)").order("created_at", { ascending: false })).data ?? [],
  });
  const { data: reports } = useQuery({
    queryKey: ["sql-templates-reports"],
    queryFn: async () => (await supabase.from("reports").select("id,name").order("name")).data ?? [],
  });
  const [name, setName] = useState("");
  const [sql, setSql] = useState("");
  const [scope, setScope] = useState<"project" | "report">("project");
  const [reportId, setReportId] = useState("");

  const [editing, setEditing] = useState<any | null>(null);
  const [eName, setEName] = useState("");
  const [eSql, setESql] = useState("");
  const [eScope, setEScope] = useState<"project" | "report">("project");
  const [eReportId, setEReportId] = useState("");

  const save = async () => {
    if (!name || !sql) return toast.error("Name and SQL required");
    if (scope === "report" && !reportId) return toast.error("Select a report");
    const { error } = await supabase.from("sql_templates").insert({
      name, sql_text: sql, scope, report_id: scope === "report" ? reportId : null,
    });
    if (error) return toast.error(error.message);
    setName(""); setSql(""); setReportId(""); toast.success("Saved");
    qc.invalidateQueries({ queryKey: ["sql-templates"] });
  };
  const del = async (id: string) => {
    if (!confirm("Delete this SQL template?")) return;
    const { error } = await supabase.from("sql_templates").delete().eq("id", id);
    if (error) return toast.error(`Delete failed: ${error.message}`);
    toast.success("Deleted");
    qc.invalidateQueries({ queryKey: ["sql-templates"] });
    qc.invalidateQueries({ queryKey: ["sql-templates-bind"] });
  };
  const openEdit = (t: any) => {
    setEditing(t);
    setEName(t.name);
    setESql(t.sql_text);
    setEScope(t.scope);
    setEReportId(t.report_id || "");
  };
  const saveEdit = async () => {
    if (!editing) return;
    if (!eName || !eSql) return toast.error("Name and SQL required");
    if (eScope === "report" && !eReportId) return toast.error("Select a report");
    const { error } = await supabase.from("sql_templates").update({
      name: eName, sql_text: eSql, scope: eScope, report_id: eScope === "report" ? eReportId : null,
    }).eq("id", editing.id);
    if (error) return toast.error(`Update failed: ${error.message}`);
    toast.success("Updated");
    setEditing(null);
    qc.invalidateQueries({ queryKey: ["sql-templates"] });
    qc.invalidateQueries({ queryKey: ["sql-templates-bind"] });
  };
  return (
    <div className="space-y-6 mt-4">
      <Card>
        <CardHeader><CardTitle>New template</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <div className="grid grid-cols-3 gap-2">
            <Input placeholder="kpi_total_sales" value={name} onChange={(e) => setName(e.target.value)} />
            <Select value={scope} onValueChange={(v: any) => setScope(v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="project">Project (global)</SelectItem>
                <SelectItem value="report">Specific report</SelectItem>
              </SelectContent>
            </Select>
            {scope === "report" && (
              <Select value={reportId} onValueChange={setReportId}>
                <SelectTrigger><SelectValue placeholder="Report" /></SelectTrigger>
                <SelectContent>
                  {(reports || []).map((r: any) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
          </div>
          <Textarea placeholder="SELECT ... FROM ... WHERE :param = ..." value={sql} onChange={(e) => setSql(e.target.value)} className="mono text-xs min-h-[120px]" />
          <Button onClick={save}>Save</Button>
        </CardContent>
      </Card>
      <div className="space-y-3">
        {(data || []).map((t: any) => (
          <Card key={t.id}>
            <CardHeader className="pb-2 flex-row items-center justify-between">
              <CardTitle className="text-sm mono">
                {t.name}
                <span className="text-xs text-muted-foreground ml-2">· {t.scope}{t.reports?.name ? ` · ${t.reports.name}` : ""}</span>
              </CardTitle>
              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" onClick={() => openEdit(t)}><Pencil className="h-3 w-3" /></Button>
                <Button size="sm" variant="ghost" onClick={() => del(t.id)}><Trash2 className="h-3 w-3" /></Button>
              </div>
            </CardHeader>
            <CardContent>
              <pre className="text-[11px] mono bg-secondary/50 p-2 rounded whitespace-pre-wrap">{t.sql_text}</pre>
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>Edit SQL template</DialogTitle></DialogHeader>
          <div className="space-y-2">
            <div className="grid grid-cols-3 gap-2">
              <Input placeholder="kpi_total_sales" value={eName} onChange={(e) => setEName(e.target.value)} />
              <Select value={eScope} onValueChange={(v: any) => setEScope(v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="project">Project (global)</SelectItem>
                  <SelectItem value="report">Specific report</SelectItem>
                </SelectContent>
              </Select>
              {eScope === "report" && (
                <Select value={eReportId} onValueChange={setEReportId}>
                  <SelectTrigger><SelectValue placeholder="Report" /></SelectTrigger>
                  <SelectContent>
                    {(reports || []).map((r: any) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}
            </div>
            <Textarea value={eSql} onChange={(e) => setESql(e.target.value)} className="mono text-xs min-h-[200px]" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button onClick={saveEdit}>Save changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function SqlTemplates() {
  return (
    <AppLayout>
      <div className="p-8 space-y-6">
        <h1 className="text-2xl font-semibold">SQL Templates</h1>
        <SqlTemplatesContent />
      </div>
    </AppLayout>
  );
}

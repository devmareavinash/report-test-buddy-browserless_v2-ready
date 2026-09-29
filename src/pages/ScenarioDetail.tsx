import { useQuery, useMutation, useQueryClient, QueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { invokeFunction } from "@/lib/functions";
import { useParams, Link, useNavigate } from "react-router-dom";
import { AppLayout } from "@/components/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useState, useEffect, useMemo } from "react";
import { toast } from "sonner";
import { Play, Wand2, Plus, Trash2, ArrowLeft, History, RotateCcw, Sparkles, Check, X, Pencil, ExternalLink, Save, ChevronDown, Undo2, Copy, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { extractFirstTableAlias, qualifyColumn } from "@/lib/sqlFilter";
import { duplicateScenario } from "@/lib/duplicateEntities";
import {
  applyAllFilterCombosToScope,
  applyFilterComboToScope,
  applyKeyMapToWorkstream,
  type ApplyScope,
} from "@/lib/applyScope";
import { compareTables, summarizeTableCompare } from "@/lib/tableCompare";
import { attachTrendFields, trendStatusFromValues } from "@/lib/trend-payload";
import { fetchCanonicalScript, persistCanonicalScript } from "@/lib/canonicalScript";

const canonFilters = (f: Record<string, string>) => {
  const keys = Object.keys(f || {}).map((k) => k.trim()).filter(Boolean).sort();
  return JSON.stringify(keys.map((k) => [k, String((f as any)[k] ?? "").trim()]));
};

function invalidateLatestStatusViews(qc: QueryClient, scenarioId: string, reportId?: string) {
  qc.invalidateQueries({ queryKey: ["scenario-results", scenarioId] });
  qc.invalidateQueries({ queryKey: ["scenario-latest-state", scenarioId] });
  qc.invalidateQueries({ queryKey: ["tests-overview"] });
  qc.invalidateQueries({ queryKey: ["dashboard-scenarios"] });
  qc.invalidateQueries({ queryKey: ["scenarios-pivot"] });
  qc.invalidateQueries({ queryKey: ["report-status-map"] });
  qc.invalidateQueries({ queryKey: ["runs"] });
  if (reportId) qc.invalidateQueries({ queryKey: ["runs-report", reportId] });
}

export default function ScenarioDetail() {
  const { id } = useParams();
  const qc = useQueryClient();
  const { data: scenario } = useQuery({
    queryKey: ["scenario", id],
    queryFn: async () => (await supabase.from("scenarios").select("*, reports(id,name,url,reference_url,warehouse_connector_id,credential_profile_id,reference_credential_profile_id,default_sql_template_id)").eq("id", id!).maybeSingle()).data,
  });
  const { data: connectors } = useQuery({
    queryKey: ["wh-connectors"],
    queryFn: async () => (await supabase.from("warehouse_connectors").select("id,name,kind").order("created_at", { ascending: false })).data ?? [],
  });
  const bindConnector = async (value: string) => {
    const reportId = (scenario as any)?.reports?.id;
    if (!reportId) return;
    const v = value === "__none__" ? null : value;
    const { error } = await supabase.from("reports").update({ warehouse_connector_id: v }).eq("id", reportId);
    if (error) { toast.error(error.message); return; }
    toast.success("Warehouse bound");
    qc.invalidateQueries({ queryKey: ["scenario", id] });
  };
  const { data: script } = useQuery({
    queryKey: ["script", id],
    queryFn: async () => {
      const q = await fetchCanonicalScript(id!);
      if (q.error) throw q.error;
      return q.data;
    },
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    gcTime: 0,
  });
  const { data: templates, isFetching: templatesFetching } = useQuery({
    queryKey: ["sql-templates-bind"],
    queryFn: async () => (await supabase.from("sql_templates").select("id,name,scope,report_id,sql_text")).data ?? [],
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    placeholderData: undefined,
    gcTime: 0,
  });

  const [code, setCode] = useState("");
  const [refCode, setRefCode] = useState("");
  const [spec, setSpec] = useState("{}");
  const [tplId, setTplId] = useState("");
  const [credId, setCredId] = useState("");
  const [refCredId, setRefCredId] = useState("");
  const [liveUrl, setLiveUrl] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<any>(null);
  const [running, setRunning] = useState<null | "headed" | "headless">(null);
  const [detailTab, setDetailTab] = useState("script");
  const [healing, setHealing] = useState(false);
  const [healProposal, setHealProposal] = useState<{ patched_playwright_code?: string; rationale?: string; changes?: string[] } | null>(null);
  const [maxRetries, setMaxRetries] = useState(10);
  const [autoHealing, setAutoHealing] = useState(false);
  const [autoHealLog, setAutoHealLog] = useState<string[]>([]);

  // Reference-script runtime (separate state from main runtime)
  const [refLiveUrl, setRefLiveUrl] = useState<string | null>(null);
  const [refRunError, setRefRunError] = useState<string | null>(null);
  const [refRunResult, setRefRunResult] = useState<any>(null);
  const [refRunning, setRefRunning] = useState<null | "headed" | "headless">(null);

  // SQL runner
  const [sqlResult, setSqlResult] = useState<any>(null);
  const [sqlRunning, setSqlRunning] = useState(false);
  const [editedSqlText, setEditedSqlText] = useState("");
  const [savingSqlText, setSavingSqlText] = useState(false);
  const [newTplOpen, setNewTplOpen] = useState(false);
  const [editingSql, setEditingSql] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [comboResults, setComboResults] = useState<Record<string, any>>({});
  const [comboRunning, setComboRunning] = useState<string | null>(null);
  const [comboScriptRunning, setComboScriptRunning] = useState<string | null>(null);
  const [comboScriptBlocks, setComboScriptBlocks] = useState<Record<string, any>>({});
  const [allCombosRunning, setAllCombosRunning] = useState(false);
  const [kpiTolerances, setKpiTolerances] = useState<Record<string, Tolerance>>({});
  const [savingTolerances, setSavingTolerances] = useState(false);
  const [updatingRunResult, setUpdatingRunResult] = useState(false);
  /** Overall status as shown in the Latest result table (grids/KPIs) — used by Sync. */
  const [tableLiveOverall, setTableLiveOverall] = useState<"pass" | "fail" | "pending" | null>(null);
  const [kpiEditorOpen, setKpiEditorOpen] = useState(false);
  const [kpiDraft, setKpiDraft] = useState<string[]>([]);
  const [kpiNew, setKpiNew] = useState("");
  const [applyCredDialog, setApplyCredDialog] = useState<null | {
    field: "credential_profile_id" | "reference_credential_profile_id";
    value: string | null;
  }>(null);
  const [applyCredBusy, setApplyCredBusy] = useState(false);
  const [deletingHistoryId, setDeletingHistoryId] = useState<string | null>(null);
  const [historyDays, setHistoryDays] = useState<7 | 14 | 30>(7);

  const scenarioType: string = (scenario as any)?.type || "warehouse_match";
  const isReferenceMatch = scenarioType === "reference_match";
  const isTrendCheck = scenarioType === "trend";
  const referenceUrl: string = (scenario as any)?.reports?.reference_url || "";
  const primaryReportUrl: string = (scenario as any)?.reports?.url || "";
  const reportId = (scenario as any)?.reports?.id;
  const [refUrlDialogOpen, setRefUrlDialogOpen] = useState(false);
  const [refUrlDraft, setRefUrlDraft] = useState("");
  const [pendingSyncCode, setPendingSyncCode] = useState<string | null>(null);

  // Rewrite the main script so ALL references to the primary report URL point at
  // the reference URL. The auto-injected auth preamble hard-codes the report URL
  // in a `__reportUrl = "..."` literal AND calls `page.goto(__reportUrl, ...)`
  // multiple times, so a single first-occurrence swap on `page.goto` isn't
  // enough — we must replace every occurrence of the report URL literal.
  const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const swapGotoUrl = (src: string, newUrl: string): string => {
    if (!src) return src;
    let out = src;
    // 1) Replace every literal occurrence of the primary report URL with the reference URL.
    if (primaryReportUrl && newUrl && primaryReportUrl !== newUrl) {
      out = out.replace(new RegExp(escapeRegex(primaryReportUrl), "g"), newUrl);
    }
    // 2) Fallback: also swap the first `page.goto('...')` target in case the URL literal
    //    isn't the primary report URL (older/hand-edited scripts).
    const re = /(page\s*\.\s*goto\s*\(\s*)(['"`])([^'"`]*)\2/;
    if (re.test(out) && !out.includes(newUrl)) {
      out = out.replace(re, (_m, p1, q) => `${p1}${q}${newUrl}${q}`);
    }
    return out;
  };

  const syncRefFromMain = (sourceCode?: string) => {
    const src = sourceCode ?? code;
    if (!src) { toast.error("Generate the main script first"); return; }
    if (!referenceUrl) {
      setPendingSyncCode(src);
      setRefUrlDraft("");
      setRefUrlDialogOpen(true);
      return;
    }
    const swapped = swapGotoUrl(src, referenceUrl);
    setRefCode(swapped);
    toast.success("Reference script populated from main script");
  };

  const saveReferenceUrl = async () => {
    const url = refUrlDraft.trim();
    if (!url) { toast.error("Enter a reference URL"); return; }
    if (!reportId) { toast.error("No report bound"); return; }
    const { error } = await supabase.from("reports").update({ reference_url: url }).eq("id", reportId);
    if (error) { toast.error(error.message); return; }
    toast.success("Reference URL saved");
    qc.invalidateQueries({ queryKey: ["scenario", id] });
    const src = pendingSyncCode ?? code;
    if (src) setRefCode(swapGotoUrl(src, url));
    setPendingSyncCode(null);
    setRefUrlDialogOpen(false);
  };


  useEffect(() => {
    setCode("");
    setRefCode("");
    setSpec("{}");
  }, [id]);

  useEffect(() => {
    const reportDefaults: any = (scenario as any)?.reports || {};
    if (script) {
      setCode(script.playwright_code || "");
      const as: any = script.assertion_spec || {};
      setRefCode(as.__reference_playwright_code || "");
      setSpec(JSON.stringify(as, null, 2));
      setTplId(script.sql_template_id || reportDefaults.default_sql_template_id || "");
      setCredId((script as any).credential_profile_id || reportDefaults.credential_profile_id || "");
      setRefCredId((script as any).reference_credential_profile_id || reportDefaults.reference_credential_profile_id || "");
      setKpiTolerances(normalizeTolerances(as.kpi_tolerances));
    } else if (scenario) {
      setCode("");
      setRefCode("");
      setTplId(reportDefaults.default_sql_template_id || "");
      setCredId(reportDefaults.credential_profile_id || "");
      setRefCredId(reportDefaults.reference_credential_profile_id || "");
    }
  }, [script, scenario]);

  const saveKpiTolerances = async (next: Record<string, Tolerance>) => {
    setKpiTolerances(next);
    if (!script) {
      toast.error("Save a test script first, then configure KPIs");
      return false;
    }
    setSavingTolerances(true);
    try {
      const as: any = script.assertion_spec || {};
      // Keep assertion_spec.kpis in sync so Add/Remove is the source of truth
      // (otherwise old kpis / last-run keys reappear in the tolerances list).
      const updated = { ...as, kpi_tolerances: next, kpis: Object.keys(next) };
      const { data, error } = await supabase.from("scripts").update({ assertion_spec: updated }).eq("id", script.id).select().single();
      if (error) {
        toast.error(error.message);
        return false;
      }
      qc.setQueryData(["script", id], data);
      qc.invalidateQueries({ queryKey: ["scenario-tolerances", id] });
      qc.invalidateQueries({ queryKey: ["scenario-script-tolerance", id] });
      setSpec(JSON.stringify((data as any)?.assertion_spec || updated, null, 2));
      return true;
    } finally {
      setSavingTolerances(false);
    }
  };

  const { data: credProfiles } = useQuery({
    queryKey: ["cred-profiles"],
    queryFn: async () => (await supabase.from("credential_profiles").select("id,name,login_url,username").order("name")).data ?? [],
  });

  // Persist a credential field to the script row immediately on selection.
  // If no script exists yet, keep it in local state only (it will be saved when
  // the script is first created / generated).
  const persistCredField = async (
    field: "credential_profile_id" | "reference_credential_profile_id",
    value: string | null,
  ) => {
    if (!script?.id) return;
    const { error } = await supabase.from("scripts").update({ [field]: value } as any).eq("id", script.id);
    if (error) { toast.error(error.message); return; }
    qc.invalidateQueries({ queryKey: ["script", id] });
    toast.success("Credentials updated");
  };

  const credProfileLabel = (value: string | null, field: string) => {
    if (!value) return field === "reference_credential_profile_id" ? "report default (reference)" : "report default";
    const match = (credProfiles || []).find((c: any) => c.id === value);
    return match?.name ? `${match.name}${match.username ? ` · ${match.username}` : ""}` : "selected profile";
  };

  const applyCredToAllInReport = async () => {
    if (!applyCredDialog || !reportId) return;
    setApplyCredBusy(true);
    try {
      const { field, value } = applyCredDialog;
      const { error: reportErr } = await supabase.from("reports").update({ [field]: value }).eq("id", reportId);
      if (reportErr) throw reportErr;
      const { data: scenarios, error: scenErr } = await supabase.from("scenarios").select("id").eq("report_id", reportId);
      if (scenErr) throw scenErr;
      const scenarioIds = (scenarios || []).map((s) => s.id);
      if (scenarioIds.length) {
        const { error: scriptErr } = await supabase.from("scripts").update({ [field]: value } as any).in("scenario_id", scenarioIds);
        if (scriptErr) throw scriptErr;
      }
      qc.invalidateQueries({ queryKey: ["scenario", id] });
      qc.invalidateQueries({ queryKey: ["script", id] });
      toast.success(
        value
          ? `Applied "${credProfileLabel(value, field)}" to this report and ${scenarioIds.length} scenario(s)`
          : `Cleared credentials on this report and ${scenarioIds.length} scenario(s)`,
      );
      setApplyCredDialog(null);
    } catch (e: any) {
      toast.error(e?.message || "Failed to apply credentials");
    } finally {
      setApplyCredBusy(false);
    }
  };

  const deleteHistoryRow = async (row: any) => {
    if (!row?.id) return;
    if (!confirm("Delete this execution log? This cannot be undone.")) return;
    setDeletingHistoryId(row.id);
    try {
      const { error } = await supabase.from("test_results").delete().eq("id", row.id);
      if (error) throw error;
      if (row.run_id) {
        const { count } = await supabase
          .from("test_results")
          .select("id", { count: "exact", head: true })
          .eq("run_id", row.run_id);
        if ((count ?? 0) === 0) {
          await supabase.from("runs").delete().eq("id", row.run_id);
        } else {
          const { data: remaining } = await supabase
            .from("test_results")
            .select("status")
            .eq("run_id", row.run_id);
          const pass = (remaining || []).filter((r: any) => r.status === "pass").length;
          const fail = (remaining || []).filter((r: any) => r.status === "fail").length;
          const pending = (remaining || []).filter((r: any) => r.status === "pending").length;
          await supabase.from("runs").update({
            status: fail > 0 ? "failed" : (pending > 0 ? "running" : "completed"),
            summary: { pass, fail, pending, total: (remaining || []).length },
          }).eq("id", row.run_id);
        }
      }
      toast.success("Execution log deleted");
      invalidateLatestStatusViews(qc, id!, reportId);
      qc.invalidateQueries({ queryKey: ["runs"] });
      qc.invalidateQueries({ queryKey: ["all-runs"] });
    } catch (e: any) {
      toast.error(e?.message || "Failed to delete log");
    } finally {
      setDeletingHistoryId(null);
    }
  };

  const hasMainCode = Boolean(code?.trim());
  const hasRefCode = Boolean(refCode?.trim());
  const genMainLabel = isReferenceMatch
    ? (hasMainCode ? "Regenerate main script" : "Generate main script")
    : (hasMainCode ? "Regenerate" : "Generate");
  const genMainPending = isReferenceMatch
    ? (hasMainCode ? "Regenerating main script…" : "Generating main script…")
    : (hasMainCode ? "Regenerating…" : "Generating…");

  const genScript = useMutation({
    mutationFn: async () => {
      toast.info(
        isTrendCheck
          ? "Generating trend script (Weekly / Monthly / Quarterly)…"
          : "Generating script… validation will run after generate (up to 5 attempts)",
      );
      const { data, error } = await invokeFunction("agent-scripts", { scenario_id: id });
      if (error) throw error;
      if ((data as any)?.error) {
        throw new Error((data as any).message || (data as any).error || "Generation failed");
      }
      const codeOut = String((data as any)?.script?.playwright_code || "").trim();
      if (!codeOut) {
        throw new Error("Generator returned no playwright_code. Check that local agent-scripts is running and the skill template matched.");
      }
      return data;
    },
    onSuccess: async (data: any) => {
      const codeOut = String(data?.script?.playwright_code || "");
      if (codeOut) setCode(codeOut);
      const by = data?.generated_by ? ` (${data.generated_by})` : "";
      const v = data?.validation;
      if (v?.enabled && v?.passed) {
        toast.success(
          `${hasMainCode ? "Script regenerated" : "Script generated"}${by} — validation passed in ${v.attempts}/${v.max_attempts} attempt(s)`,
        );
      } else if (v?.enabled && !v?.passed) {
        const last = Array.isArray(v.reports) ? v.reports[v.reports.length - 1] : null;
        toast.error(
          `Script saved but validation failed after ${v.attempts} attempt(s): ${last?.summary || "nav/filters/extract"}`,
        );
      } else if (v?.skipped_reason) {
        toast.success(`${hasMainCode ? "Script regenerated" : "Script generated"}${by} (validation skipped: ${v.skipped_reason})`);
      } else {
        toast.success((hasMainCode ? "Script regenerated" : "Script generated") + by);
      }
      if (data?.script) qc.setQueryData(["script", id], data.script);
      qc.invalidateQueries({ queryKey: ["script", id] });
    },
    onError: (e: any) => toast.error(e?.message || "Generation failed"),
  });

  const genReferenceScript = useMutation({
    mutationFn: async () => {
      toast.info("Generating reference script… validation will run after generate (up to 5 attempts)");
      const { data, error } = await invokeFunction("agent-scripts", { scenario_id: id, target: "reference" });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      return data;
    },
    onSuccess: async (data: any) => {
      const genCode = data?.script?.assertion_spec?.__reference_playwright_code || "";
      if (genCode) setRefCode(genCode);
      const v = data?.validation;
      if (v?.enabled && v?.passed) {
        toast.success(
          `${hasRefCode ? "Reference regenerated" : "Reference generated"} — validation passed in ${v.attempts}/${v.max_attempts} attempt(s)`,
        );
      } else if (v?.enabled && !v?.passed) {
        const last = Array.isArray(v.reports) ? v.reports[v.reports.length - 1] : null;
        toast.error(
          `Reference script saved but validation failed after ${v.attempts} attempt(s): ${last?.summary || "checks failed"}`,
        );
      } else {
        toast.success(hasRefCode ? "Reference script regenerated from description" : "Reference script generated from description");
      }
      if (data?.script) qc.setQueryData(["script", id], data.script);
      qc.invalidateQueries({ queryKey: ["script", id] });
    },
    onError: (e: any) => toast.error(e?.message || "Reference script generation failed"),
  });


  const saveScript = async () => {
    let parsedSpec: any = {};
    try { parsedSpec = JSON.parse(spec); } catch { return toast.error("Assertion spec is not valid JSON"); }
    parsedSpec.__reference_playwright_code = refCode || undefined;
    const payload: any = { playwright_code: code, assertion_spec: parsedSpec, sql_template_id: tplId || null, credential_profile_id: credId || null, reference_credential_profile_id: refCredId || null };
    const { data, error } = await persistCanonicalScript(id!, payload, script?.id);
    if (error) { toast.error(error.message || "Failed to save script"); return; }
    if (data) qc.setQueryData(["script", id], data);
    toast.success("Script saved");
    await qc.invalidateQueries({ queryKey: ["script", id] });
    qc.invalidateQueries({ queryKey: ["scenario-tolerances"] });
    qc.invalidateQueries({ queryKey: ["scenario-script-tolerance"] });
  };

  const runMode = async (mode: "headed" | "headless") => {
    setRunError(null); setRunResult(null); setLiveUrl(null); setRunning(mode);
    try {
      const freshQ = await fetchCanonicalScript(id!, "id, playwright_code, assertion_spec, created_at");
      if (freshQ.error) throw freshQ.error;
      const fresh = freshQ.data;
      if (fresh) qc.setQueryData(["script", id], (prev: any) => ({ ...(prev || {}), ...fresh }));
      const dbCode = String((fresh as any)?.playwright_code || "").trim();
      const editorCode = String(code || "").trim();
      const runCode = dbCode || editorCode;
      if (!runCode) {
        const msg = "No saved script for this scenario. Generate or Save first.";
        setRunError(msg);
        toast.error(msg);
        return;
      }
      if (dbCode && dbCode !== editorCode) setCode(dbCode);
      const { data, error } = await invokeFunction("playwright-runtime", { mode, scenario_id: id, code: runCode });
      const errorMessage = data?.message || error?.message || (data?.ok === false ? data?.error : null) || (!data ? "Run failed" : null);
      if (errorMessage) { setRunError(errorMessage); toast.error(errorMessage); return; }
      if (mode === "headed") {
        if (data?.live_url) setLiveUrl(data.live_url);
        else if (data?.requested_mode === "headed" && data?.mode === "headless") {
          setRunResult(data);
          toast.info(data.fallback_reason || "Live debug is unavailable; ran headless instead.");
          setDetailTab("result");
          void persistManualHeadlessRun({
            scenarioId: id!,
            reportId: (scenario as any)?.reports?.id,
            payload: data,
            combos: combos || [],
            criticality: (scenario as any)?.criticality,
            referencePayload: refRunResult,
            storedRows: latestResults || [],
            tolerances: kpiTolerances,
            sqlByCombo: comboResults,
            sqlResult,
            isReferenceMatch,
          }).then((ok) => {
            if (ok) invalidateLatestStatusViews(qc, id!, (scenario as any)?.reports?.id);
            else toast.error("Run finished but latest status was not saved");
          });
        }
        else setRunError("Runtime did not return a live_url");
      } else {
        setRunResult(data);
        const kpis = extractKpisFromRun(data);
        if (kpis) toast.success(`Extracted ${Object.keys(kpis).length} KPIs`);
        else toast.success("Headless run finished");
        setDetailTab("result");
        void persistManualHeadlessRun({
          scenarioId: id!,
          reportId: (scenario as any)?.reports?.id,
          payload: data,
          combos: combos || [],
          criticality: (scenario as any)?.criticality,
          referencePayload: refRunResult,
          storedRows: latestResults || [],
          tolerances: kpiTolerances,
          sqlByCombo: comboResults,
          sqlResult,
          isReferenceMatch,
        }).then((ok) => {
          if (ok) invalidateLatestStatusViews(qc, id!, (scenario as any)?.reports?.id);
          else toast.error("Run finished but latest status was not saved");
        });
      }
    } catch (e: any) {
      setRunError(String(e?.message || e));
    } finally {
      setRunning(null);
    }
  };

  const healScript = async () => {
    setHealing(true); setHealProposal(null);
    try {
      const screenshot_b64 =
        runResult?.screenshot_b64 ||
        runResult?.extracted?.screenshot ||
        (runResult?.screenshot_url ? null : null);
      const { data, error } = await invokeFunction("agent-heal-script", {
        scenario_id: id,
        code,
        error: runError || (runResult?.ok === false ? runResult?.error : "") || "Script ran without an explicit error — improve robustness and KPI extraction.",
        run_result: runResult,
        screenshot_b64,
        screenshot_url: runResult?.screenshot_url || null,
      });
      if (error) throw error;
      if (!data?.proposal?.patched_playwright_code) throw new Error("No proposal returned");
      setHealProposal(data.proposal);
      toast.success("Healing proposal ready — review below");
    } catch (e: any) {
      toast.error(e?.message || "Healing failed");
    } finally {
      setHealing(false);
    }
  };

  const approveHeal = async () => {
    if (!healProposal?.patched_playwright_code) return;
    const newCode = healProposal.patched_playwright_code;
    setCode(newCode);
    const payload: any = { playwright_code: newCode, assertion_spec: (() => { try { return JSON.parse(spec); } catch { return {}; } })(), sql_template_id: tplId || null, credential_profile_id: credId || null, reference_credential_profile_id: refCredId || null };
    const { data, error } = await persistCanonicalScript(id!, payload, script?.id);
    if (error) { toast.error(error.message || "Failed to save healed script"); return; }
    if (data) qc.setQueryData(["script", id], data);
    setHealProposal(null); setRunError(null);
    toast.success("Script updated with healed version");
    await qc.invalidateQueries({ queryKey: ["script", id] });
  };

  const autoHeal = async () => {
    if (autoHealing) return;
    setAutoHealing(true);
    setAutoHealLog([]);
    setHealProposal(null);
    const log = (m: string) => setAutoHealLog((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${m}`]);
    let currentCode = code;
    let lastResult: any = runResult;
    let lastError: string | null = runError;
    // Accumulated history of attempts so the heal agent learns from past errors
    const priorAttempts: Array<{ attempt: number; error: string | null; rationale?: string; changes?: string[]; run_result_excerpt?: any }> = [];
    const max = Math.max(1, Math.min(50, Number(maxRetries) || 10));
    try {
      for (let attempt = 1; attempt <= max; attempt++) {
        // 1. Run
        log(`Attempt ${attempt}/${max}: running headless…`);
        setRunning("headless"); setRunError(null); setLiveUrl(null);
        const { data: runData, error: runErr } = await invokeFunction("playwright-runtime", { mode: "headless", scenario_id: id, code: currentCode });
        setRunning(null);
        const errMsg = runData?.message || runErr?.message || (runData?.ok === false ? runData?.error : null);
        setRunResult(runData || null);
        lastResult = runData;
        lastError = errMsg || null;
        if (runData?.ok && !errMsg) {
          log(`✓ Script succeeded on attempt ${attempt}.`);
          toast.success(`Auto-heal converged after ${attempt} attempt(s)`);
          setRunError(null);
          setDetailTab("result");
          void persistManualHeadlessRun({
            scenarioId: id!,
            reportId: (scenario as any)?.reports?.id,
            payload: runData,
            combos: combos || [],
            criticality: (scenario as any)?.criticality,
            referencePayload: refRunResult,
            storedRows: latestResults || [],
            tolerances: kpiTolerances,
            sqlByCombo: comboResults,
            sqlResult,
            isReferenceMatch,
          }).then((ok) => {
            if (ok) invalidateLatestStatusViews(qc, id!, (scenario as any)?.reports?.id);
            else toast.error("Run finished but latest status was not saved");
          });
          return;
        }
        setRunError(errMsg || "Run failed");
        log(`✗ Failed: ${(errMsg || "unknown").slice(0, 200)}`);
        priorAttempts.push({
          attempt,
          error: lastError,
          run_result_excerpt: lastResult ? { ok: lastResult.ok, error: lastResult.error, extracted: lastResult.extracted } : null,
        });
        if (attempt === max) {
          log(`Reached max retries (${max}).`);
          toast.error(`Auto-heal exhausted ${max} attempts`);
          return;
        }
        // 2. Heal — pass full history so the agent learns from past failures
        log(`Requesting heal proposal (with ${priorAttempts.length} prior error(s))…`);
        const { data: healData, error: healErr } = await invokeFunction("agent-heal-script", {
          scenario_id: id,
          code: currentCode,
          error: lastError || "Improve robustness and KPI extraction.",
          run_result: lastResult,
          screenshot_b64: lastResult?.screenshot_b64 || lastResult?.extracted?.screenshot || null,
          screenshot_url: lastResult?.screenshot_url || null,
          playwright_version: "1.47.0",
          prior_attempts: priorAttempts,
        });
        if (healErr || !healData?.proposal?.patched_playwright_code) {
          log(`Heal failed: ${healErr?.message || "no proposal"}`);
          toast.error("Healing agent returned no proposal");
          return;
        }
        currentCode = healData.proposal.patched_playwright_code;
        setCode(currentCode);
        setHealProposal(healData.proposal);
        // Annotate the just-recorded attempt with what the agent tried
        const lastEntry = priorAttempts[priorAttempts.length - 1];
        if (lastEntry) {
          lastEntry.rationale = healData.proposal.rationale;
          lastEntry.changes = healData.proposal.changes;
        }
        // 3. Save
        const payload: any = { playwright_code: currentCode, assertion_spec: (() => { try { return JSON.parse(spec); } catch { return {}; } })(), sql_template_id: tplId || null, credential_profile_id: credId || null, reference_credential_profile_id: refCredId || null };
        const { data: saved, error: saveErr } = await persistCanonicalScript(id!, payload, script?.id);
        if (saveErr) {
          log(`Save failed: ${saveErr.message}`);
          toast.error(saveErr.message || "Failed to save healed script");
          return;
        }
        if (saved) qc.setQueryData(["script", id], saved);
        log(`Applied heal v${attempt}: ${(healData.proposal.rationale || "").slice(0, 120)}`);
      }
    } catch (e: any) {
      log(`Error: ${e?.message || e}`);
      toast.error(e?.message || "Auto-heal failed");
    } finally {
      setAutoHealing(false);
      qc.invalidateQueries({ queryKey: ["script", id] });
    }
  };

  const runSingleCombo = async (combo: any, idx: number) => {
    const label = combo.label || `Filter #${idx + 1}`;
    setComboScriptRunning(combo.id);
    toast.loading(`Running ${label}…`, { id: `combo-run-${combo.id}` });
    try {
      const freshQ = await fetchCanonicalScript(id!, "playwright_code");
      if (freshQ.error) throw freshQ.error;
      const runCode = String((freshQ.data as any)?.playwright_code || code || "").trim();
      if (!runCode) throw new Error("No saved script for this scenario. Generate or Save first.");
      const { data, error } = await invokeFunction("playwright-runtime", {
        mode: "headless",
        scenario_id: id,
        code: runCode,
        filter_combinations: [{ label, filters: combo.filters || {} }],
      });
      const errorMessage = data?.message || error?.message
        || (data?.ok === false ? data?.error : null) || (!data ? "Run failed" : null);
      if (errorMessage) {
        toast.error(errorMessage, { id: `combo-run-${combo.id}` });
        return;
      }
      const block = singleComboBlock(data, label, idx, combo.id);
      if (!block) {
        toast.error(`No result returned for ${label}`, { id: `combo-run-${combo.id}` });
        return;
      }
      setComboScriptBlocks((prev) => ({ ...prev, [combo.id]: block }));
      setDetailTab("result");
      toast.success(`${label} re-run complete`, { id: `combo-run-${combo.id}` });
    } catch (e: any) {
      toast.error(String(e?.message || e), { id: `combo-run-${combo.id}` });
    } finally {
      setComboScriptRunning(null);
    }
  };

  const runRefMode = async (mode: "headed" | "headless") => {
    setRefRunError(null); setRefRunResult(null); setRefLiveUrl(null); setRefRunning(mode);
    try {
      const freshQ = await fetchCanonicalScript(id!, "assertion_spec");
      if (freshQ.error) throw freshQ.error;
      const dbRef = String((freshQ.data as any)?.assertion_spec?.__reference_playwright_code || "").trim();
      const runRef = dbRef || String(refCode || "").trim();
      if (!runRef) {
        const msg = "No saved reference script for this scenario. Generate or Save first.";
        setRefRunError(msg);
        toast.error(msg);
        return;
      }
      if (dbRef && dbRef !== String(refCode || "").trim()) setRefCode(dbRef);
      const { data, error } = await invokeFunction("playwright-runtime", { mode, scenario_id: id, code: runRef, target: "reference" });
      const errorMessage = data?.message || error?.message || (data?.ok === false ? data?.error : null) || (!data ? "Run failed" : null);
      if (errorMessage) { setRefRunError(errorMessage); toast.error(errorMessage); return; }
      if (mode === "headed") {
        if (data?.live_url) setRefLiveUrl(data.live_url);
        else if (data?.requested_mode === "headed" && data?.mode === "headless") {
          setRefRunResult(data);
          toast.info(data.fallback_reason || "Live debug is unavailable; ran headless instead.");
        } else setRefRunError("Runtime did not return a live_url");
      } else {
        setRefRunResult(data);
        const kpis = extractKpisFromRun(data);
        toast.success(kpis ? `Reference: extracted ${Object.keys(kpis).length} KPIs` : "Reference run finished");
        setDetailTab("result");
        void persistReferenceHeadlessRun({
          scenarioId: id!,
          payload: data,
          combos: combos || [],
          tolerances: kpiTolerances,
        }).then((ok) => {
          if (ok) invalidateLatestStatusViews(qc, id!, (scenario as any)?.reports?.id);
        });
      }
    } catch (e: any) {
      setRefRunError(String(e?.message || e));
    } finally {
      setRefRunning(null);
    }
  };

  const runSql = async () => {
    setSqlRunning(true); setSqlResult(null);
    try {
      const { data, error } = await invokeFunction("run-warehouse-sql", { sql_template_id: tplId || null, scenario_id: id, limit: 5 });
      if (error) throw error;
      setSqlResult(data);
      if (data?.ok) {
        toast.success(`${data.source === "snowflake" ? "Snowflake" : "Mock"}: ${data.row_count} row(s)`);
        void persistWarehouseExpected({
          scenarioId: id!,
          reportId: (scenario as any)?.reports?.id,
          combos: combos || [],
          sqlByCombo: comboResults,
          sqlResult: data,
          tolerances: kpiTolerances,
        }).then((ok) => {
          if (ok) invalidateLatestStatusViews(qc, id!, (scenario as any)?.reports?.id);
        });
      } else toast.error(data?.error || "SQL failed");
    } catch (e: any) {
      setSqlResult({ ok: false, error: e?.message || "SQL run failed" });
      toast.error(e?.message || "SQL run failed");
    } finally {
      setSqlRunning(false);
    }
  };

  // Filter combinations + FE↔BE key map (cached; shared with FilterCombinations component)
  const { data: combos } = useQuery({
    queryKey: ["scenario-filter-matrix", id],
    queryFn: async () =>
      ((await supabase
        .from("scenario_filter_matrix")
        .select("id,label,filters")
        .eq("scenario_id", id!)
        .order("created_at", { ascending: true })).data ?? []) as any[],
  });
  const reportIdForMap = (scenario as any)?.reports?.id as string | undefined;
  const { data: keyMap } = useQuery({
    queryKey: ["report-filter-key-map", reportIdForMap],
    enabled: !!reportIdForMap,
    queryFn: async () =>
      ((await supabase
        .from("scenario_filter_key_map")
        .select("id,fe_label,be_column")
        .eq("report_id", reportIdForMap!)
        .order("created_at", { ascending: true })).data ?? []) as any[],
  });

  const buildWhereForCombo = (combo: any): { where: string; pairs: { fe: string; be: string; value: string }[]; missing: string[] } => {
    const map = new Map<string, string>((keyMap ?? []).map((k: any) => [k.fe_label, k.be_column] as [string, string]));
    const pairs: { fe: string; be: string; value: string }[] = [];
    const missing: string[] = [];
    for (const [fe, v] of Object.entries(combo?.filters || {})) {
      const val = String(v ?? "");
      // "Total" is a UI-only sentinel — apply it on the page for Playwright, but skip in SQL WHERE.
      if (val.trim().toLowerCase() === "total") continue;
      const be = map.get(fe);
      if (!be) { missing.push(fe); continue; }
      pairs.push({ fe, be, value: val });
    }
    const tplSql =
      editedSqlText ||
      String((templates || []).find((t: any) => t.id === tplId)?.sql_text || "");
    const firstAlias = extractFirstTableAlias(tplSql);
    const esc = (s: string) => s.replace(/'/g, "''");
    const where = pairs
      .map((p) => `${qualifyColumn(p.be, firstAlias)} = '${esc(p.value)}'`)
      .join(" AND ");
    return { where, pairs, missing };
  };

  const runComboSql = async (combo: any) => {
    if (!tplId) { toast.error("Select a SQL template first"); return; }
    const { where, pairs, missing } = buildWhereForCombo(combo);
    if (!where) {
      const msg = missing.length
        ? `No FE→BE mapping for: ${missing.join(", ")}. Add mappings via "FE ↔ BE key mapping".`
        : "This combination has no filters to apply.";
      setComboResults((prev) => ({ ...prev, [combo.id]: { ok: false, error: msg } }));
      toast.error(msg);
      return;
    }
    setComboRunning(combo.id);
    try {
      const { data, error } = await invokeFunction("run-warehouse-sql", {
        sql_template_id: tplId,
        scenario_id: id,
        where_clause: where,
        filter_pairs: pairs.map((p) => ({ be: p.be, value: p.value })),
        limit: 5,
      });
      if (error) throw error;
      const nextCombo = { ...comboResults, [combo.id]: { ...data, where_clause: where, pairs, missing } };
      setComboResults(nextCombo);
      if (data?.ok) {
        toast.success(`${combo.label || "Combination"}: ${data.row_count} row(s)`);
        void persistWarehouseExpected({
          scenarioId: id!,
          reportId: (scenario as any)?.reports?.id,
          combos: combos || [],
          sqlByCombo: nextCombo,
          sqlResult: data,
          tolerances: kpiTolerances,
        }).then((ok) => {
          if (ok) invalidateLatestStatusViews(qc, id!, (scenario as any)?.reports?.id);
        });
      } else toast.error(data?.error || "SQL failed");
    } catch (e: any) {
      setComboResults((prev) => ({ ...prev, [combo.id]: { ok: false, error: e?.message || "SQL failed", where_clause: where } }));
      toast.error(e?.message || "SQL failed");
    } finally {
      setComboRunning(null);
    }
  };

  const runAllCombos = async () => {
    if (!combos?.length) { toast.error("No filter combinations defined"); return; }
    if (!tplId) { toast.error("Select a SQL template first"); return; }
    setAllCombosRunning(true);
    try {
      for (const c of combos) {
        await runComboSql(c);
      }
    } finally {
      setAllCombosRunning(false);
    }
  };


  const { data: latestResults } = useQuery({
    queryKey: ["scenario-results", id, historyDays],
    queryFn: async () => {
      const cutoff = new Date(Date.now() - historyDays * 24 * 60 * 60 * 1000).toISOString();
      const { data } = await supabase
        .from("test_results")
        .select("id, run_id, status, expected, actual, diff, analysis, screenshot_url, created_at")
        .eq("scenario_id", id!)
        .gte("created_at", cutoff)
        .order("created_at", { ascending: false })
        .limit(80);
      return data ?? [];
    },
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
  // "Latest result" is the newest stored row for EACH configured combination,
  // not merely every row from the newest run. A single-combination rerun must
  // update that combination without hiding the other combinations.
  const { data: latestStateResults } = useQuery({
    queryKey: ["scenario-latest-state", id],
    queryFn: async () =>
      (await supabase
        .from("test_results")
        .select("id, run_id, status, expected, actual, diff, analysis, screenshot_url, created_at")
        .eq("scenario_id", id!)
        .order("created_at", { ascending: false })
        .limit(1000)).data ?? [],
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
  const latestPerComboResults = useMemo(() => {
    const newest = new Map<string, any>();
    for (const row of latestStateResults || []) {
      const label = String(
        row?.actual?.filter ??
        row?.expected?.filter ??
        row?.actual?.combo ??
        row?.expected?.combo ??
        "__single__",
      ).trim().toLowerCase() || "__single__";
      if (!newest.has(label)) newest.set(label, row);
    }
    return Array.from(newest.values()).sort(
      (a: any, b: any) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
  }, [latestStateResults]);
  const historyRows = (latestResults || []).slice(0, 20);
  const { data: lastPwJob } = useQuery({
    queryKey: ["playwright-job-latest", id],
    queryFn: async () =>
      (await supabase
        .from("playwright_jobs")
        .select("last_event, created_at, status")
        .eq("scenario_id", id!)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()).data,
    staleTime: 0,
    refetchOnMount: "always",
  });
  const latest = latestPerComboResults[0] || latestResults?.[0];
  const selectedTpl = (templates || []).find((t: any) => t.id === tplId);
  useEffect(() => {
    setEditedSqlText((selectedTpl as any)?.sql_text || "");
    setEditingSql(false);
  }, [tplId, (selectedTpl as any)?.sql_text]);
  const sqlDirty = !!selectedTpl && editedSqlText !== ((selectedTpl as any)?.sql_text || "");
  const saveSqlText = async (): Promise<boolean> => {
    if (!selectedTpl) return false;
    setSavingSqlText(true);
    const { error } = await supabase.from("sql_templates").update({ sql_text: editedSqlText }).eq("id", (selectedTpl as any).id);
    setSavingSqlText(false);
    if (error) { toast.error(`Save failed: ${error.message}`); return false; }
    toast.success("SQL template updated");
    qc.invalidateQueries({ queryKey: ["sql-templates-bind"] });
    qc.invalidateQueries({ queryKey: ["sql-templates"] });
    return true;
  };
  const saveAndRunSql = async () => {
    if (sqlDirty) {
      const ok = await saveSqlText();
      if (!ok) return;
    }
    setEditingSql(false);
    await runSql();
  };
  const cancelEditSql = () => {
    if (sqlDirty) { setDiscardOpen(true); return; }
    setEditingSql(false);
  };
  const confirmDiscard = () => {
    setEditedSqlText(((selectedTpl as any)?.sql_text) || "");
    setEditingSql(false);
    setDiscardOpen(false);
  };


  // Build "manual" latest from in-memory run results: Test Script (Run headless/headed)
  // populates the Actual column; Warehouse SQL (Run) populates the Expected column
  // (or the Reference Script output when this is a reference_match scenario).
  const manualActual = (() => {
    const raw = extractKpisFromRun(runResult);
    return raw ? aliasConfiguredKpis(raw, kpiTolerances) : null;
  })();
  const manualReference = (() => {
    if (!isReferenceMatch) return null;
    const raw = extractKpisFromRun(refRunResult);
    return raw ? aliasConfiguredKpis(raw, kpiTolerances) : null;
  })();
  const manualExpected = (() => {
    if (isReferenceMatch) return manualReference;
    if (!sqlResult?.ok) return null;
    if (sqlResult.scalar !== undefined && sqlResult.scalar !== null) {
      const col = sqlResult.columns?.[0] || "value";
      return { [col]: sqlResult.scalar };
    }
    const row = sqlResult.rows?.[0];
    if (row && typeof row === "object") {
      const out: Record<string, any> = {};
      for (const [k, v] of Object.entries(row)) {
        if (v === null || typeof v === "object") continue;
        out[k] = v;
      }
      return Object.keys(out).length ? out : null;
    }
    return null;
  })();
  const hasComboData = Object.keys(comboResults).length > 0 || !!refRunResult;
  const liveComboHasKpis = !!(combos?.length && runResult && (combos as any[]).some((c: any, idx: number) => {
    const root = pickResultRoot(runResult);
    const label = c.label || `Filter #${idx + 1}`;
    const block = pickComboBlock(root, label, idx, c.id);
    return Object.keys(extractKpisFromBlock(block)).length > 0;
  }));
  const hasManual = !!(manualActual || manualExpected) || liveComboHasKpis || hasComboData;
  // Suite-stored test_results wrap KPI maps under `.values` (alongside filter / filters_applied / source).
  // Unwrap so KpiRowsTable receives a flat KPI map, matching the live (manual) shape.
  const unwrapSuiteKpis = (block: any): any => {
    if (!block || typeof block !== "object") return block;
    if (block.values && typeof block.values === "object" && !Array.isArray(block.values)) return block.values;
    return block;
  };
  const displayActual = (hasManual && manualActual)
    ? manualActual
    : (kpiMapFromStored(latest?.actual) || unwrapSuiteKpis(latest?.actual) || {});
  const displayExpected = (hasManual && manualExpected)
    ? manualExpected
    : (kpiMapFromStored(latest?.expected) || unwrapSuiteKpis(latest?.expected) || {});
  const displayDiff = hasManual ? null : latest?.diff;

  // Hydrate FilterComparisonTable from stored test_results (and the last playwright job
  // if the stored row has an empty values map).
  const suiteRunData = (() => {
    if (!combos?.length) return null;
    const rows = latestPerComboResults;
    const pwResult: Record<string, any> = {};
    const refResult: Record<string, any> = {};
    const comboMap: Record<string, any> = {};
    const jobRoot = lastPwJob?.last_event ? pickResultRoot(lastPwJob.last_event) : null;
    for (const c of combos as any[]) {
      const idx = (combos as any[]).indexOf(c);
      const row = rows.find((r: any) =>
        normComboLabel(r.actual?.filter || r.expected?.filter || "") === normComboLabel(c.label || "")
      ) || rows[idx];
      const label = c.label || row?.actual?.filter || `combo_${idx + 1}`;
      const fromStored = row ? kpiMapFromStored(row.actual) : null;
      const fromJob = jobRoot ? extractKpisFromBlock(pickComboBlock(jobRoot, label, idx, c.id)) : null;
      const actualValues = aliasConfiguredKpis(
        (fromStored && Object.keys(fromStored).length)
          ? fromStored
          : (fromJob && Object.keys(fromJob).length ? fromJob : {}),
        kpiTolerances,
      );
      const hasActual = Object.keys(actualValues).length > 0;
      const expectedValues = row
        ? aliasConfiguredKpis(kpiMapFromStored(row.expected) || {}, kpiTolerances)
        : null;
      const filtersApplied = row?.actual?.filters_applied || null;
      if (hasActual) pwResult[label] = { ...actualValues, filters_applied: filtersApplied };
      if (expectedValues && Object.keys(expectedValues).length) {
        if (isReferenceMatch) {
          refResult[label] = { ...expectedValues };
        } else {
          const cols = Object.keys(expectedValues);
          comboMap[c.id] = { ok: true, rows: [expectedValues], columns: cols };
        }
      }
    }
    return {
      runResult: Object.keys(pwResult).length ? { result: pwResult } : (jobRoot ? lastPwJob?.last_event : null),
      refRunResult: Object.keys(refResult).length ? { result: refResult } : null,
      comboResults: comboMap,
    };
  })();
  const effectiveRunResult = (runResult && (liveComboHasKpis || manualActual))
    ? runResult
    : (suiteRunData?.runResult || runResult || lastPwJob?.last_event || null);
  const effectiveRefRunResult = refRunResult || suiteRunData?.refRunResult || null;
  const effectiveComboResults = (Object.keys(comboResults).length ? comboResults : (suiteRunData?.comboResults || {}));

  // ----- Compute displayed overall status (drives "Update run suite result" button) -----
  const _rootOf = (rr: any) => pickResultRoot(rr);
  const _blockFor = (root: any, label: string, idx: number, comboId?: string) =>
    pickComboBlock(root, label, idx, comboId);

  const manualPerCombo = (() => {
    if (!combos?.length) return null;
    const pwRoot = _rootOf(runResult);
    const refRoot = _rootOf(refRunResult);
    return combos.map((c: any, idx: number) => {
      const label = comboPersistLabel(c, idx);
      const pwBlock = _blockFor(pwRoot, label, idx, c.id);
      const refBlock = _blockFor(refRoot, label, idx, c.id);
      const actualMap = aliasConfiguredKpis(extractKpisFromBlock(pwBlock), kpiTolerances);
      const refKpis = refBlock ? aliasConfiguredKpis(extractKpisFromBlock(refBlock), kpiTolerances) : null;
      const sqlRes = comboResults[c.id] || (sqlResult?.ok ? sqlResult : null);
      const expectedMap: Record<string, any> = {};
      const passes: (boolean | null)[] = [];
      const configuredNames = Object.keys(kpiTolerances || {}).filter((k) => !isKpiNoiseKey(k));
      const names = configuredNames.length ? configuredNames : Object.keys(actualMap);
      for (const k of names) {
        const v = resolveKpiValue(k, actualMap, pwBlock, runResult);
        const exp = isReferenceMatch
          ? resolveKpiValue(k, refKpis, manualReference, refBlock, refRunResult)
          : expectedForKpi(sqlRes, k);
        expectedMap[k] = exp;
        passes.push(evalPass(v, exp, getTol(kpiTolerances, k)));
      }
      const status = overallFromPassResults(passes);
      return { combo: c, label, actualMap, expectedMap, status, filters: c.filters || {} };
    });
  })();

  const computedStatus: "pass" | "fail" | "pending" = (() => {
    if (manualPerCombo && manualPerCombo.length) {
      if (manualPerCombo.some((p) => p.status === "fail")) return "fail";
      if (manualPerCombo.some((p) => p.status === "pending")) return "pending";
      if (manualPerCombo.every((p) => p.status === "pass")) return "pass";
      return "pending";
    }
    return statusFromKpis(displayActual, displayExpected, kpiTolerances);
  })();
  const persistedStatus: "pass" | "fail" | "pending" | undefined =
    latest?.status === "pass" || latest?.status === "fail" || latest?.status === "pending"
      ? latest.status
      : undefined;
  // Live KPI/grid comparison wins when available (including pending); saved DB is fallback.
  const tableOverall =
    tableLiveOverall === "pass" || tableLiveOverall === "fail" || tableLiveOverall === "pending"
      ? tableLiveOverall
      : null;
  const displayedStatus: "pass" | "fail" | "pending" = (() => {
    if (tableOverall) return tableOverall;
    if (hasManual) return computedStatus;
    if (computedStatus !== "pending") return computedStatus;
    return persistedStatus || computedStatus;
  })();
  const syncLiveOverall: "pass" | "fail" | "pending" =
    tableOverall && tableOverall !== "pending"
      ? tableOverall
      : computedStatus !== "pending"
        ? computedStatus
        : displayedStatus;
  const storedSource = latest?.expected?.source || latest?.actual?.source;

  // Tolerances that were stored alongside the latest run (per-run snapshot).
  // Used both to detect "has the user changed tolerances since the last run?"
  // and to enable the Reset button so the user can revert to the last run's values.
  const lastRunTolerances: Record<string, Tolerance> = (() => {
    if (!latestPerComboResults.length) return {};
    const rows = latestPerComboResults;
    const merged: Record<string, any> = {};
    for (const r of rows) {
      const snap = r?.actual?.tolerances_snapshot;
      if (snap && typeof snap === "object") {
        for (const [k, v] of Object.entries(snap)) if (!(k in merged)) merged[k] = v;
      }
      const d = r?.diff;
      if (d && typeof d === "object") {
        for (const [k, v] of Object.entries(d as any)) {
          if (!(k in merged) && v && typeof v === "object" && (v as any).tolerance) merged[k] = (v as any).tolerance;
        }
      }
    }
    return normalizeTolerances(merged);
  })();

  const tolerancesChanged = (() => {
    const keys = new Set<string>([...Object.keys(kpiTolerances || {}), ...Object.keys(lastRunTolerances || {})]);
    for (const k of keys) {
      const a = kpiTolerances[k] || { value: 0, unit: "pct", op: "eq" };
      const b = lastRunTolerances[k] || { value: 0, unit: "pct", op: "eq" };
      if (Number(a.value || 0) !== Number(b.value || 0)) return true;
      if ((a.unit || "pct") !== (b.unit || "pct")) return true;
      if ((a.op || "eq") !== (b.op || "eq")) return true;
    }
    return false;
  })();

  const canUpdateRunResult =
    !!latest?.run_id &&
    (
      tolerancesChanged ||
      hasManual ||
      (syncLiveOverall !== "pending" && syncLiveOverall !== latest?.status) ||
      (computedStatus !== "pending" && computedStatus !== latest?.status) ||
      (displayedStatus !== "pending" && displayedStatus !== latest?.status)
    );

  const resetTolerancesToLastRun = () => {
    if (!Object.keys(lastRunTolerances).length) {
      toast.info("No previous run tolerances to reset to");
      return;
    }
    saveKpiTolerances(lastRunTolerances);
    toast.success("Tolerances reset to last run");
  };

  const updateRunResult = async () => {
    if (!latest?.run_id || !canUpdateRunResult) {
      toast.info("Nothing to sync — run the scenario again, or change KPI tolerances first.");
      return;
    }
    setUpdatingRunResult(true);
    try {
      // Build a serializable snapshot of the tolerances the user just committed.
      const snapshot: Record<string, any> = {};
      for (const [k, v] of Object.entries(kpiTolerances || {})) {
        snapshot[k] = { value: Number(v?.value) || 0, unit: v?.unit === "abs" ? "abs" : "pct", op: isValidOp(v?.op) ? v.op : "eq" };
      }
      const hasKpiValues = (map: any) =>
        !!map && typeof map === "object" && Object.values(map).some((v) => v !== null && v !== undefined);
      const mergeKpiValues = (prev: Record<string, any>, next: Record<string, any>) => {
        const merged = { ...(prev || {}) };
        for (const [k, v] of Object.entries(next || {})) {
          if (v !== null && v !== undefined) merged[k] = v;
        }
        return merged;
      };
      const valuesFromStoredBlock = (block: any): Record<string, any> => {
        if (!block || typeof block !== "object") return {};
        if (block.values && typeof block.values === "object" && !Array.isArray(block.values)) return block.values;
        return extractKpisFromBlock(block);
      };
      const statusForValues = (actualValues: Record<string, any>, expectedValues: Record<string, any>): "pass" | "fail" | "pending" =>
        statusFromKpis(actualValues, expectedValues, kpiTolerances);
      // Live overall from the Latest result table (grids/KPIs) — not parent-only KPI maps.
      const liveOverall: "pass" | "fail" | "pending" =
        syncLiveOverall !== "pending" ? syncLiveOverall
          : computedStatus !== "pending" ? computedStatus
          : displayedStatus !== "pending" ? displayedStatus
          : "pending";
      const preferLiveStatus = (fallback: "pass" | "fail" | "pending") =>
        liveOverall === "pass" || liveOverall === "fail" ? liveOverall : fallback;
      // Always fetch existing rows so we can MERGE tolerances_snapshot without
      // wiping the recorded actual/expected values from that run.
      const { data: runRows } = await supabase
        .from("test_results")
        .select("id, actual, expected, status")
        .eq("scenario_id", id!)
        .eq("run_id", latest.run_id);

      const hasLiveManualPerCombo = !!manualPerCombo?.some((p) => hasKpiValues(p.actualMap) || hasKpiValues(p.expectedMap));
      if (manualPerCombo && hasLiveManualPerCombo) {
        const byLabel = new Map<string, any>();
        (runRows || []).forEach((r: any) => {
          const lbl = storedRowFilterLabel(r);
          if (lbl) byLabel.set(lbl, r);
        });
        // If the stored rows for this run don't carry combo labels (typical for
        // synthetic error rows written by the orchestrator when script generation
        // failed), we can't match them to the current filter combos. Wipe those
        // rows and insert one fresh row per combo so Sync actually replaces the
        // failure with the manual results.
        const noLabelledRows = byLabel.size === 0 && (runRows || []).length > 0;
        if (noLabelledRows) {
          const idsToDelete = (runRows || []).map((r: any) => r.id);
          if (idsToDelete.length) {
            await supabase.from("test_results").delete().in("id", idsToDelete);
          }
          for (const p of manualPerCombo) {
            const nextActualValues = hasKpiValues(p.actualMap) ? mergeKpiValues({}, p.actualMap) : {};
            const nextExpectedValues = hasKpiValues(p.expectedMap) ? mergeKpiValues({}, p.expectedMap) : {};
            await supabase.from("test_results").insert({
              run_id: latest.run_id,
              scenario_id: id!,
              status: preferLiveStatus(statusForValues(nextActualValues, nextExpectedValues)),
              actual: { filter: p.label, values: nextActualValues, filters_applied: p.filters ?? null, tolerances_snapshot: snapshot },
              expected: {
                filter: p.label,
                values: nextExpectedValues,
                source: isReferenceMatch ? "reference_script" : "warehouse_sql",
              },
              diff: null,
              analysis: "Updated from manual scenario run",
            });
          }
        } else {
          let matched = 0;
          for (let i = 0; i < manualPerCombo.length; i++) {
            const p = manualPerCombo[i];
            const existing = matchStoredComboRow(runRows || [], p.combo, i, p.label) || byLabel.get(p.label);
            if (!existing) continue;
            matched += 1;
            const prevActual = (existing.actual && typeof existing.actual === "object") ? existing.actual : {};
            const prevExpected = (existing.expected && typeof existing.expected === "object") ? existing.expected : {};
            const prevActualValues = valuesFromStoredBlock(prevActual);
            const prevExpectedValues = valuesFromStoredBlock(prevExpected);
            // Sync means "make the stored run match Latest Result". When live
            // values exist, replace the old raw extractor keys instead of
            // preserving them beside the configured KPI aliases.
            const nextActualValues = hasKpiValues(p.actualMap) ? mergeKpiValues({}, p.actualMap) : prevActualValues;
            const nextExpectedValues = hasKpiValues(p.expectedMap) ? mergeKpiValues({}, p.expectedMap) : prevExpectedValues;
            const { error: updErr } = await supabase.from("test_results").update({
              status: p.status === "pending"
                ? statusForValues(nextActualValues, nextExpectedValues)
                : p.status,
              actual: { ...prevActual, filter: p.label, values: nextActualValues, filters_applied: p.filters ?? prevActual.filters_applied ?? null, tolerances_snapshot: snapshot },
              expected: {
                ...prevExpected,
                filter: p.label,
                values: nextExpectedValues,
                source: isReferenceMatch ? "reference_script" : (prevExpected.source || "warehouse_sql"),
              },
              diff: null,
              analysis: "Updated from manual scenario run",
            }).eq("id", existing.id);
            if (updErr) throw updErr;
          }
          if (matched === 0) {
            // Fall through: still force live overall onto all rows for this run.
            if (liveOverall !== "pass" && liveOverall !== "fail") {
              throw new Error("Could not match this session's results to the last run. Run the test script again, then Sync.");
            }
          }
        }
      } else {
        // No combos: merge live manual run values (test/reference script output) into the
        // stored row so a fresh manual run updates the recorded actual/expected/status,
        // not just the tolerance snapshot.
        const liveActual = (manualActual && typeof manualActual === "object") ? manualActual : {};
        const liveExpected = (manualExpected && typeof manualExpected === "object") ? manualExpected : {};
        for (const row of (runRows || [])) {
          const prevActual = (row.actual && typeof row.actual === "object") ? row.actual : {};
          const prevExpected = (row.expected && typeof row.expected === "object") ? row.expected : {};
          const prevActualValues = valuesFromStoredBlock(prevActual);
          const prevExpectedValues = valuesFromStoredBlock(prevExpected);
          const nextActualValues = hasKpiValues(liveActual) ? mergeKpiValues({}, liveActual) : prevActualValues;
          const nextExpectedValues = hasKpiValues(liveExpected) ? mergeKpiValues({}, liveExpected) : prevExpectedValues;
          const nextActual: any = { ...prevActual, tolerances_snapshot: snapshot };
          const nextExpected: any = { ...prevExpected };
          if (hasKpiValues(liveActual) || prevActual.values) nextActual.values = nextActualValues;
          if (hasKpiValues(liveExpected) || prevExpected.values) nextExpected.values = nextExpectedValues;
          await supabase.from("test_results").update({
            status: preferLiveStatus(statusForValues(nextActualValues, nextExpectedValues)),
            actual: nextActual,
            expected: nextExpected,
            diff: null,
            analysis: hasKpiValues(liveActual) || hasKpiValues(liveExpected) ? "Updated from manual scenario run" : (row as any).analysis ?? null,
          }).eq("id", row.id);
        }
      }

      // Roll up to the run row so the Runs list/badge reflect the corrected status.
      const { data: allRows } = await supabase.from("test_results").select("status").eq("run_id", latest.run_id);
      const pass = (allRows || []).filter((r: any) => r.status === "pass").length;
      const fail = (allRows || []).filter((r: any) => r.status === "fail").length;
      await supabase.from("runs").update({
        status: fail > 0 ? "failed" : "completed",
        summary: { pass, fail, total: (allRows || []).length },
      }).eq("id", latest.run_id);
      toast.success(liveOverall === "pass" ? "Synced — overall status set to PASS" : "Synced to last run");
      invalidateLatestStatusViews(qc, id!, (scenario as any)?.reports?.id);
      qc.invalidateQueries({ queryKey: ["run", latest.run_id] });
    } catch (e: any) {
      toast.error(e?.message || "Failed to update");
    } finally {
      setUpdatingRunResult(false);
    }
  };


  if (!scenario) return <AppLayout><div className="p-8">Loading…</div></AppLayout>;

  return (
    <AppLayout>
      <div className="p-8 space-y-4">
        <Link to={`/reports/${(scenario as any).reports?.id}`} className="text-xs text-muted-foreground inline-flex items-center gap-1 hover:text-foreground">
          <ArrowLeft className="h-3 w-3" /> {(scenario as any).reports?.name}
        </Link>
        <ScenarioMeta s={scenario} />

        {(() => {
          // Tolerances / Add-Remove must use configured KPIs only.
          // Merging last-run actual/expected keys made removals appear to fail
          // (deleted KPIs immediately reappeared from the latest result).
          const kpiKeys = Object.keys(kpiTolerances || {})
            .filter((k) => k && !k.startsWith("__") && !isKpiNoiseKey(k))
            .sort();
          const seedFromRunOrScript = () => {
            const extracted = new Set<string>();
            for (const k of Object.keys(displayActual || {})) {
              if (!k.startsWith("__") && !isKpiNoiseKey(k)) extracted.add(k);
            }
            for (const k of Object.keys(displayExpected || {})) {
              if (!k.startsWith("__") && !isKpiNoiseKey(k)) extracted.add(k);
            }
            const scriptKpis = (script as any)?.assertion_spec?.kpis;
            if (Array.isArray(scriptKpis)) {
              for (const k of scriptKpis) if (typeof k === "string" && k.trim() && !isKpiNoiseKey(k)) extracted.add(k.trim());
            } else if (scriptKpis && typeof scriptKpis === "object") {
              for (const k of Object.keys(scriptKpis)) if (!isKpiNoiseKey(k)) extracted.add(k);
            }
            return Array.from(extracted).sort();
          };
          return (
            <TolerancesEditor
              kpiKeys={kpiKeys}
              tolerances={kpiTolerances}
              onChange={saveKpiTolerances}
              saving={savingTolerances}
              showOperator={isReferenceMatch}
              onReset={resetTolerancesToLastRun}
              canReset={tolerancesChanged && Object.keys(lastRunTolerances).length > 0}
              onAddRemove={() => {
                setKpiDraft(kpiKeys.length ? kpiKeys : seedFromRunOrScript());
                setKpiNew("");
                setKpiEditorOpen(true);
              }}
            />
          );
        })()}

        <Dialog open={kpiEditorOpen} onOpenChange={setKpiEditorOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add / Remove KPIs</DialogTitle>
            </DialogHeader>
            <div className="space-y-2 text-xs">
              <div className="text-muted-foreground">
                KPIs listed here appear in the tolerances table. Pass/fail is evaluated using the tolerance value, unit (% or absolute) and condition set for each KPI.
              </div>
              <div className="space-y-1 max-h-72 overflow-auto">
                {kpiDraft.length === 0 && (
                  <div className="text-muted-foreground text-[11px] py-1">No KPIs yet — add one below.</div>
                )}
                {kpiDraft.map((k, i) => (
                  <div key={`${k}-${i}`} className="flex items-center gap-2">
                    <Input
                      value={k}
                      onChange={(e) => {
                        const next = [...kpiDraft];
                        next[i] = e.target.value;
                        setKpiDraft(next);
                      }}
                      className="h-7 text-xs mono flex-1"
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0 text-destructive"
                      onClick={() => setKpiDraft(kpiDraft.filter((_, idx) => idx !== i))}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-2 border-t border-border pt-2">
                <Input
                  placeholder="New KPI name (e.g. impressions)"
                  value={kpiNew}
                  onChange={(e) => setKpiNew(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const v = kpiNew.trim();
                      if (v && !kpiDraft.includes(v)) setKpiDraft([...kpiDraft, v]);
                      setKpiNew("");
                    }
                  }}
                  className="h-7 text-xs mono flex-1"
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => {
                    const v = kpiNew.trim();
                    if (v && !kpiDraft.includes(v)) setKpiDraft([...kpiDraft, v]);
                    setKpiNew("");
                  }}
                >
                  <Plus className="h-3 w-3 mr-1" />Add
                </Button>
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => setKpiEditorOpen(false)}>Cancel</Button>
              <Button
                size="sm"
                onClick={async () => {
                  const cleaned = Array.from(new Set(kpiDraft.map((s) => s.trim()).filter(Boolean)));
                  const globalOp = getGlobalOp(kpiTolerances);
                  const next: Record<string, Tolerance> = {};
                  for (const k of cleaned) {
                    next[k] = kpiTolerances[k] ?? { value: 0, unit: "pct", op: globalOp };
                  }
                  const ok = await saveKpiTolerances(next);
                  if (ok) {
                    setKpiEditorOpen(false);
                    toast.success("KPIs updated");
                  }
                }}
              >
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <FilterCombinations scenarioId={id!} reportId={(scenario as any).reports?.id} />

        <Tabs value={detailTab} onValueChange={setDetailTab}>
          <TabsList>
            <TabsTrigger value="script">Test script</TabsTrigger>
            {isReferenceMatch && <TabsTrigger value="ref">Reference script</TabsTrigger>}
            {!isReferenceMatch && !isTrendCheck && <TabsTrigger value="sql">Warehouse SQL</TabsTrigger>}
            <TabsTrigger value="result">Latest result</TabsTrigger>
          </TabsList>

          {/* TAB 1 — Test script + embedded runtime */}
          <TabsContent value="script" className="space-y-3 mt-4">
            <Card>
              <CardHeader className="pb-2 flex-row items-center justify-between">
                <CardTitle className="text-sm">Playwright code · {((script as any)?.assertion_spec?.__main_uses_reference_source) ? "reference report" : "main report"}</CardTitle>
                <div className="flex gap-2 items-center flex-wrap justify-end">
                  <span className="text-xs text-muted-foreground">Credentials:</span>
                  <Select value={credId || "__none__"} onOpenChange={(o) => { if (o) qc.invalidateQueries({ queryKey: ["cred-profiles"] }); }} onValueChange={(v) => {
                    if (v === "__add_new__") {
                      const reportUrl = (scenario as any)?.reports?.url || "";
                      const qs = reportUrl ? `&loginUrl=${encodeURIComponent(reportUrl)}` : "";
                      window.open(`/settings?tab=creds${qs}`, "_blank");
                      return;
                    }
                    setCredId(v === "__none__" ? "" : v);
                    persistCredField("credential_profile_id", v === "__none__" ? null : v);
                  }}>
                    <SelectTrigger className="h-9 w-56 text-xs">
                      <SelectValue placeholder="— Use report default —">
                        {credId ? ((credProfiles || []).find((c: any) => c.id === credId)?.name ?? "—") : "— Use report default —"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">— Use report default —</SelectItem>
                      {(credProfiles || []).map((c: any) => (
                        <SelectItem key={c.id} value={c.id}>{c.name}{c.username ? ` · ${c.username}` : ""}</SelectItem>
                      ))}
                      <SelectItem value="__add_new__" className="text-primary">
                        <span className="inline-flex items-center gap-1"><Plus className="h-3 w-3" />Add New Credentials<ExternalLink className="h-3 w-3 ml-1" /></span>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-9 text-xs"
                    disabled={!reportId}
                    onClick={() => setApplyCredDialog({ field: "credential_profile_id", value: credId || null })}
                  >
                    Apply to all in report
                  </Button>
                  <ScriptHistory
                    scenarioId={id!}
                    scriptId={script?.id}
                    kind="main"
                    onRestore={(v) => {
                      setCode(v.playwright_code || "");
                      setSpec(JSON.stringify(v.assertion_spec || {}, null, 2));
                      setTplId(v.sql_template_id || "");
                      toast.success(`Loaded v${v.version} — click Save to persist`);
                    }}
                  />
                  <Button size="sm" variant="outline" disabled={genScript.isPending} onClick={() => genScript.mutate()}>
                    {hasMainCode ? <RotateCcw className="h-3 w-3 mr-1" /> : <Wand2 className="h-3 w-3 mr-1" />}
                    {genScript.isPending ? genMainPending : genMainLabel}
                  </Button>
                  <Button size="sm" onClick={saveScript}>Save</Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                <Textarea className="mono text-xs min-h-[260px]" value={code} onChange={(e) => setCode(e.target.value)} placeholder="// Playwright code…" />
              </CardContent>
            </Card>
            <RuntimeBlock
              title="Runtime · main"
              running={running}
              onRun={runMode}
              liveUrl={liveUrl}
              runError={runError}
              runResult={runResult}
              extra={
                <>
                  <div className="flex items-center gap-1 ml-2 border border-border rounded px-2 py-1">
                    <span className="text-[10px] uppercase text-muted-foreground">Max retries</span>
                    <Input type="number" min={1} max={50} value={maxRetries} onChange={(e) => setMaxRetries(Number(e.target.value) || 1)} className="h-7 w-16 text-xs" disabled={autoHealing} />
                    <Button size="sm" disabled={autoHealing || !!running} onClick={autoHeal}>
                      <Sparkles className="h-3 w-3 mr-1" />{autoHealing ? "Auto-healing…" : "Auto-heal"}
                    </Button>
                  </div>
                </>
              }
              footer={
                <>
                  {autoHealLog.length > 0 && (
                    <div className="rounded border border-border bg-secondary/30 text-[11px] p-2 mono max-h-48 overflow-auto">
                      <div className="font-semibold mb-1 text-foreground">Auto-heal log</div>
                      {autoHealLog.map((l, i) => <div key={i} className="text-muted-foreground whitespace-pre-wrap">{l}</div>)}
                    </div>
                  )}
                  {healProposal && (
                    <div className="rounded border border-primary/40 bg-primary/5 text-xs p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="font-semibold text-foreground">Healing proposal</div>
                        <div className="flex gap-2">
                          <Button size="sm" variant="ghost" onClick={() => setHealProposal(null)}><X className="h-3 w-3 mr-1" />Reject</Button>
                          <Button size="sm" onClick={approveHeal}><Check className="h-3 w-3 mr-1" />Approve & save</Button>
                        </div>
                      </div>
                      {healProposal.rationale && <div className="text-muted-foreground whitespace-pre-wrap">{healProposal.rationale}</div>}
                      {!!healProposal.changes?.length && (
                        <ul className="list-disc pl-5 text-muted-foreground">{healProposal.changes.map((c, i) => <li key={i}>{c}</li>)}</ul>
                      )}
                      <pre className="mono text-[10px] p-2 rounded bg-secondary/40 overflow-auto max-h-80 border border-border">{healProposal.patched_playwright_code}</pre>
                    </div>
                  )}
                </>
              }
            />
          </TabsContent>

          {/* TAB 2 — Reference script + embedded runtime */}
          {isReferenceMatch && (
            <TabsContent value="ref" className="space-y-3 mt-4">
              <Card>
                <CardHeader className="pb-2 flex-row items-center justify-between">
                  <CardTitle className="text-sm">Playwright code · reference report</CardTitle>
                  <div className="flex items-center gap-2 flex-wrap justify-end">
                    <ScriptHistory
                      scenarioId={id!}
                      scriptId={script?.id}
                      kind="reference"
                      onRestore={(v) => {
                        const as: any = v.assertion_spec || {};
                        setRefCode(as.__reference_playwright_code || "");
                        toast.success(`Loaded v${v.version} — click Save to persist`);
                      }}
                    />
                    <Button
                      size="sm"
                      onClick={() => genReferenceScript.mutate()}
                      disabled={genReferenceScript.isPending || !(scenario as any)?.description?.trim()}
                      title={!(scenario as any)?.description?.trim() ? "Add a scenario description first" : "Generate a dedicated reference script from the scenario description (use for two-screen comparisons)"}
                    >
                      <Sparkles className="h-3 w-3 mr-1" />
                      {genReferenceScript.isPending
                        ? (hasRefCode ? "Regenerating from description…" : "Generating…")
                        : (hasRefCode ? "Regenerate from description" : "Generate reference script")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => syncRefFromMain()}
                      disabled={!code}
                      title="Copy the main script and swap the report URL to the reference URL (use for same-screen / different-env comparisons)"
                    >
                      <RotateCcw className="h-3 w-3 mr-1" />Sync from main (swap URL)
                    </Button>
                    <Button size="sm" onClick={saveScript}>Save</Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-muted-foreground">
                      Reference URL: <span className="mono">{referenceUrl || <em className="text-amber-600 dark:text-amber-400">not set (will use primary report URL)</em>}</span>
                    </span>
                    <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => { setRefUrlDraft(referenceUrl); setPendingSyncCode(null); setRefUrlDialogOpen(true); }}>
                      <Pencil className="h-3 w-3 mr-1" />{referenceUrl ? "Edit" : "Set"} reference URL
                    </Button>
                  </div>
                  <div className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="text-muted-foreground whitespace-nowrap">Reference login credentials:</span>
                    <div className="flex flex-1 items-center gap-2 min-w-0">
                      <Select
                        value={refCredId || "__none__"}
                        onOpenChange={(o) => { if (o) qc.invalidateQueries({ queryKey: ["cred-profiles"] }); }}
                        onValueChange={(v) => {
                          if (v === "__add_new__") { window.open(`/settings?tab=creds`, "_blank"); return; }
                          setRefCredId(v === "__none__" ? "" : v);
                          persistCredField("reference_credential_profile_id", v === "__none__" ? null : v);
                        }}
                      >
                        <SelectTrigger className="h-8 flex-1"><SelectValue placeholder="— Select credentials —" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">— None —</SelectItem>
                          {(credProfiles || []).map((c: any) => (
                            <SelectItem key={c.id} value={c.id}>{c.name}{c.username ? ` · ${c.username}` : ""}</SelectItem>
                          ))}
                          <SelectItem value="__add_new__" className="text-primary">
                            <span className="inline-flex items-center gap-1"><Plus className="h-3 w-3" />Add New Credentials<ExternalLink className="h-3 w-3 ml-1" /></span>
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 text-[11px] shrink-0"
                        disabled={!reportId}
                        onClick={() => setApplyCredDialog({ field: "reference_credential_profile_id", value: refCredId || null })}
                      >
                        Apply to all
                      </Button>
                    </div>
                  </div>
                  <Textarea className="mono text-xs min-h-[260px]" value={refCode} onChange={(e) => setRefCode(e.target.value)} placeholder="// Playwright code for reference report…" />
                  <div className="text-[11px] text-muted-foreground">
                    Two ways to populate this reference script: <b>Generate</b> uses the scenario description to build a dedicated script that scrapes the <em>second</em> screen of a two-screen comparison (same report URL, different tab/view). <b>Sync from main (swap URL)</b> copies the main script and only swaps the report URL to the reference URL — use it when comparing the same screen across two environments. The reference script logs in with the credentials selected above (falling back to the report's reference credentials, then the main login). Use the same KPI keys so values can be compared in the Latest result tab.
                  </div>
                </CardContent>
              </Card>

              <RuntimeBlock
                title="Runtime · reference"
                running={refRunning}
                onRun={runRefMode}
                liveUrl={refLiveUrl}
                runError={refRunError}
                runResult={refRunResult}
              />
            </TabsContent>
          )}

          {/* TAB 3 — Warehouse SQL */}
          <TabsContent value="sql" className="space-y-3 mt-4">
            <Card>
              <CardHeader className="pb-2 flex-row items-center justify-between">
                <CardTitle className="text-sm">Bound SQL template</CardTitle>
                <div className="flex gap-2 items-center flex-wrap justify-end">
                  <span className="text-xs text-muted-foreground">Warehouse:</span>
                  <Select
                    value={(scenario as any)?.reports?.warehouse_connector_id || "__none__"}
                    onOpenChange={(o) => { if (o) qc.invalidateQueries({ queryKey: ["wh-connectors"] }); }}
                    onValueChange={(v) => {
                      if (v === "__add_new__") {
                        window.open(`/settings?tab=warehouse`, "_blank");
                        return;
                      }
                      bindConnector(v);
                    }}
                  >
                    <SelectTrigger className="w-52"><SelectValue placeholder="— No warehouse —" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">— No warehouse —</SelectItem>
                      {(connectors || []).map((c: any) => (
                        <SelectItem key={c.id} value={c.id}>{c.name} · {c.kind}</SelectItem>
                      ))}
                      <SelectItem value="__add_new__" className="text-primary">
                        <span className="inline-flex items-center gap-1"><Plus className="h-3 w-3" />Add New Warehouse<ExternalLink className="h-3 w-3 ml-1" /></span>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <span className="text-xs text-muted-foreground">SQL Template:</span>
                  <Select
                    value={tplId || "__none"}
                    onValueChange={(v) => {
                      if (v === "__new") { setNewTplOpen(true); return; }
                      setTplId(v === "__none" ? "" : v);
                    }}
                    disabled={templatesFetching && !templates}
                  >
                    <SelectTrigger className="w-64">
                      {templatesFetching && !templates
                        ? <span className="text-xs text-muted-foreground">Loading templates…</span>
                        : <SelectValue placeholder="(none)" />}
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none">(none)</SelectItem>
                      {(templates || []).map((t: any) => (
                        <SelectItem key={t.id} value={t.id}>{t.name} · {t.scope}</SelectItem>
                      ))}
                      <SelectItem value="__new">+ Add New Template</SelectItem>
                    </SelectContent>
                  </Select>
                  <NewSqlTemplateInline
                    open={newTplOpen}
                    onOpenChange={setNewTplOpen}
                    reportId={(scenario as any).reports?.id}
                    onCreated={(newId) => { setTplId(newId); qc.invalidateQueries({ queryKey: ["sql-templates-bind"] }); }}
                  />
                  <Button size="sm" onClick={saveScript} variant="outline">Save binding</Button>
                  <Button size="sm" disabled={!tplId || sqlRunning} onClick={runSql}>
                    <Play className="h-3 w-3 mr-1" />{sqlRunning ? "Running…" : "Run SQL"}
                  </Button>
                </div>

              </CardHeader>
              <CardContent className="space-y-3">
                {!tplId && <div className="text-xs text-muted-foreground">No SQL template bound. Select or create one above.</div>}
                {selectedTpl && (
                  <div className="flex items-center justify-between rounded-md border bg-card px-3 py-2">
                    <div className="text-sm font-semibold mono">{(selectedTpl as any).name}</div>
                    <Button size="sm" variant="outline" onClick={() => { setEditedSqlText(((selectedTpl as any)?.sql_text) || ""); setEditingSql(true); }} title="Edit template">
                      <Pencil className="h-3 w-3 mr-1" />Edit template
                    </Button>
                  </div>
                )}
                <Dialog open={editingSql} onOpenChange={(o) => { if (!o) cancelEditSql(); else setEditingSql(true); }}>
                  <DialogContent className="max-w-3xl">
                    <DialogHeader>
                      <DialogTitle>Edit SQL template{selectedTpl ? `: ${(selectedTpl as any).name}` : ""}</DialogTitle>
                    </DialogHeader>
                    <Textarea
                      className="mono text-xs min-h-[280px]"
                      value={editedSqlText}
                      onChange={(e) => setEditedSqlText(e.target.value)}
                    />
                    <DialogFooter>
                      <Button size="sm" variant="outline" onClick={cancelEditSql}>
                        <X className="h-3 w-3 mr-1" />Cancel
                      </Button>
                      <Button size="sm" onClick={saveAndRunSql} disabled={savingSqlText || sqlRunning}>
                        <Play className="h-3 w-3 mr-1" />{savingSqlText ? "Saving…" : sqlRunning ? "Running…" : "Save & Run SQL"}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
                <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
                      <AlertDialogDescription>
                        You have unsaved edits to this SQL template. Do you want to discard them?
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>No</AlertDialogCancel>
                      <AlertDialogAction onClick={confirmDiscard}>Yes, discard</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>

                {sqlResult && (
                  <div className="space-y-2 text-xs">
                    {!sqlResult.ok && (
                      <div className="rounded border border-destructive/40 bg-destructive/10 text-destructive p-2 mono whitespace-pre-wrap">
                        Error{sqlResult.source ? ` (${sqlResult.source})` : ""}: {sqlResult.error}
                      </div>
                    )}
                    {sqlResult.ok && (
                      <div className="mono text-muted-foreground">
                        {sqlResult.source === "snowflake" ? `Snowflake · ${sqlResult.connector || ""}` : "Mock warehouse"} · {sqlResult.row_count} row(s){sqlResult.scalar != null ? ` · scalar = ${JSON.stringify(sqlResult.scalar)}` : ""} · showing top {Math.min(5, sqlResult.rows?.length || 0)}
                      </div>
                    )}
                    {sqlResult.resolved_sql && (
                      <pre className="mono text-[10px] p-2 rounded bg-secondary/40 border border-border whitespace-pre-wrap">{sqlResult.resolved_sql}</pre>
                    )}
                    {!!sqlResult.rows?.length && (
                      <div className="overflow-auto border border-border rounded">
                        <table className="w-full text-[11px] mono">
                          <thead className="bg-secondary/40">
                            <tr>
                              {(sqlResult.columns || Object.keys(sqlResult.rows[0])).map((c: string) => (
                                <th key={c} className="text-left px-2 py-1 border-b border-border">{c}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {sqlResult.rows.slice(0, 5).map((r: any, i: number) => (
                              <tr key={i} className="border-b border-border/40">
                                {(sqlResult.columns || Object.keys(sqlResult.rows[0])).map((c: string) => (
                                  <td key={c} className="px-2 py-1 align-top">{r[c] == null ? <span className="text-muted-foreground">null</span> : typeof r[c] === "object" ? JSON.stringify(r[c]) : String(r[c])}</td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}

                {!!combos?.length && (
                  <div className="space-y-3 pt-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs font-semibold text-foreground">Results per filter combination</div>
                      <Button size="sm" variant="secondary" disabled={!tplId || !combos?.length || allCombosRunning || !!comboRunning} onClick={runAllCombos}>
                        <Play className="h-3 w-3 mr-1" />{allCombosRunning ? "Running all…" : "Run per combination"}
                      </Button>
                    </div>
                    {combos.map((c: any, idx: number) => {
                      const res = comboResults[c.id];
                      const { where, missing } = buildWhereForCombo(c);
                      return (
                        <div key={c.id} className="rounded-md border border-border bg-card p-3 space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <div className="text-xs">
                              <span className="font-semibold">Filter #{idx + 1}{c.label ? ` · ${c.label}` : ""}</span>
                              <div className="mono text-[11px] text-muted-foreground mt-0.5">
                                {Object.entries(c.filters || {}).map(([k, v]) => `${k}=${v}`).join(" · ")}
                              </div>
                            </div>
                            <Button size="sm" variant="outline" disabled={!tplId || comboRunning === c.id} onClick={() => runComboSql(c)}>
                              <Play className="h-3 w-3 mr-1" />{comboRunning === c.id ? "Running…" : "Run"}
                            </Button>
                          </div>
                          {!!missing.length && (
                            <div className="text-[11px] text-amber-600 dark:text-amber-400">
                              Missing FE→BE mapping for: {missing.join(", ")}
                            </div>
                          )}
                          {where && (
                            <div className="mono text-[11px]">
                              <span className="text-muted-foreground">WHERE</span> {where}
                            </div>
                          )}
                          {res && (
                            <div className="space-y-2 text-xs">
                              {!res.ok && (
                                <div className="rounded border border-destructive/40 bg-destructive/10 text-destructive p-2 mono whitespace-pre-wrap">
                                  Error{res.source ? ` (${res.source})` : ""}: {res.error}
                                </div>
                              )}
                              {res.ok && (
                                <div className="mono text-muted-foreground">
                                  {res.source === "snowflake" ? `Snowflake · ${res.connector || ""}` : "Mock warehouse"} · {res.row_count} row(s){res.scalar != null ? ` · scalar = ${JSON.stringify(res.scalar)}` : ""} · showing top {Math.min(5, res.rows?.length || 0)}
                                </div>
                              )}
                              {res.resolved_sql && (
                                <pre className="mono text-[10px] p-2 rounded bg-secondary/40 border border-border whitespace-pre-wrap">{res.resolved_sql}</pre>
                              )}
                              {!!res.rows?.length && (
                                <div className="overflow-auto border border-border rounded">
                                  <table className="w-full text-[11px] mono">
                                    <thead className="bg-secondary/40">
                                      <tr>
                                        {(res.columns || Object.keys(res.rows[0])).map((col: string) => (
                                          <th key={col} className="text-left px-2 py-1 border-b border-border">{col}</th>
                                        ))}
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {res.rows.slice(0, 5).map((r: any, i: number) => (
                                        <tr key={i} className="border-b border-border/40">
                                          {(res.columns || Object.keys(res.rows[0])).map((col: string) => (
                                            <td key={col} className="px-2 py-1 align-top">{r[col] == null ? <span className="text-muted-foreground">null</span> : typeof r[col] === "object" ? JSON.stringify(r[col]) : String(r[col])}</td>
                                          ))}
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>



          {/* TAB 5 — Latest test execution result */}
          <TabsContent value="result" className="space-y-3 mt-4">
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-sm">
                    Latest execution result
                    {hasManual
                      ? <span className="text-xs text-muted-foreground font-normal"> · live (this session)</span>
                      : latest?.created_at && <span className="text-xs text-muted-foreground font-normal"> · {new Date(latest.created_at).toLocaleString()}</span>}
                  </CardTitle>
                  {latest?.run_id && (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span tabIndex={0}>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!canUpdateRunResult || updatingRunResult}
                              onClick={updateRunResult}
                            >
                              <Save className="h-3 w-3 mr-1" />
                              {updatingRunResult ? "Saving…" : "Sync to last run"}
                            </Button>
                          </span>
                        </TooltipTrigger>
                        {!canUpdateRunResult && (
                          <TooltipContent>
                            Run the scenario manually or update KPI Tolerances first.
                          </TooltipContent>
                        )}
                      </Tooltip>
                    </TooltipProvider>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-3 text-xs">
                {!latest && !hasManual && <div className="text-muted-foreground">No executions recorded yet. Run the Test Script (headless/headed){isTrendCheck ? " to check consecutive Weekly/Monthly/Quarterly periods." : ` and ${isReferenceMatch ? "Reference Script" : "Warehouse SQL"} to populate this view.`}</div>}
                {(latest || hasManual) && (
                  <>
                    <div className="flex gap-4 items-center">
                      <div><span className="text-muted-foreground">Source:</span> <span className="mono font-semibold">{hasManual ? `${manualActual ? "Test script" : "—"} + ${manualExpected ? (isReferenceMatch ? "Reference script" : "Warehouse SQL") : "—"}` : (storedSource || "stored")}</span></div>
                      <div><span className="text-muted-foreground">Check:</span> <span className="mono">{isTrendCheck ? "consecutive graph periods" : isReferenceMatch ? "main vs reference report" : `main vs ${scenarioType.replace("_match","")}`}</span></div>
                      {!hasManual && latest?.run_id && <Link to={`/runs/${latest.run_id}`} className="text-accent hover:underline ml-auto">open run →</Link>}
                    </div>
                    {!!combos?.length ? (
                      <FilterComparisonTable
                        combos={combos}
                        comboResults={effectiveComboResults}
                        runResult={effectiveRunResult}
                        tolerances={kpiTolerances}
                        onTolerancesChange={saveKpiTolerances}
                        savingTolerances={savingTolerances}
                        isReferenceMatch={isReferenceMatch}
                        isTrendCheck={isTrendCheck}
                        referenceKpis={manualReference}
                        refRunResult={effectiveRefRunResult}
                        globalSqlResult={sqlResult}
                        onResetTolerances={resetTolerancesToLastRun}
                        canResetTolerances={tolerancesChanged && Object.keys(lastRunTolerances).length > 0}
                        onRunCombo={runSingleCombo}
                        runningComboId={comboScriptRunning}
                        comboBlockOverrides={comboScriptBlocks}
                        persistedStatus={!hasManual ? persistedStatus : undefined}
                        onLiveOverallChange={setTableLiveOverall}
                        scriptKpiLabels={[
                          ...parseKpiLabelsFromPlaywright(code),
                          ...parseKpiLabelsFromPlaywright(refCode),
                        ]}
                      />
                    ) : (
                      <KpiRowsTable
                        actual={displayActual}
                        sqlRes={isReferenceMatch || isTrendCheck ? null : sqlResult}
                        fallbackExpected={isTrendCheck ? { "Trend check": 1 } : displayExpected}
                        tolerances={kpiTolerances}
                        onTolerancesChange={saveKpiTolerances}
                        savingTolerances={savingTolerances}
                        isReferenceMatch={isReferenceMatch}
                        isTrendCheck={isTrendCheck}
                        onResetTolerances={resetTolerancesToLastRun}
                        canResetTolerances={tolerancesChanged && Object.keys(lastRunTolerances).length > 0}
                        persistedStatus={!hasManual ? persistedStatus : undefined}
                        onLiveOverallChange={setTableLiveOverall}
                        scriptKpiLabels={[
                          ...parseKpiLabelsFromPlaywright(code),
                          ...parseKpiLabelsFromPlaywright(refCode),
                        ]}
                      />
                    )}
                    {/* Stale RCA/analysis from prior runs intentionally hidden — only manual Test Script + Warehouse SQL output should drive Latest Result. */}
                    {hasManual && !combos?.length && (!manualActual || (!isTrendCheck && !manualExpected)) && (
                      <div className="text-muted-foreground text-[11px] border-t border-border pt-2">
                        {!manualActual && "↳ Run the Test Script (headless or headed) to populate Actual. "}
                        {!isTrendCheck && !manualExpected && (isReferenceMatch ? "↳ Run the Reference Script to populate Reference URL." : "↳ Run the Warehouse SQL to populate Expected.")}
                      </div>
                    )}
                  </>
                )}

              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* Bottom — execution history log */}
        <Card>
          <CardHeader className="pb-2 flex-row items-center justify-between gap-2">
            <CardTitle className="text-sm">Execution history</CardTitle>
            <div className="flex items-center gap-1 text-[11px]">
              <span className="text-muted-foreground mr-1">Last</span>
              {([7, 14, 30] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setHistoryDays(d)}
                  className={`px-2 py-0.5 rounded border ${historyDays === d ? "border-accent text-accent" : "border-border text-muted-foreground"}`}
                >
                  {d}d
                </button>
              ))}
            </div>
          </CardHeader>
          <CardContent>
            {!historyRows.length && <div className="text-xs text-muted-foreground">No executions in the last {historyDays} days.</div>}
            {(latestResults || []).length > historyRows.length && (
              <div className="text-[11px] text-muted-foreground mb-2">
                Showing {historyRows.length} of {(latestResults || []).length} rows in this window.
              </div>
            )}
            <div className="divide-y divide-border">
              {historyRows.map((r: any) => {
                const shown = r.status;
                return (
                <div key={r.id} className="flex items-center gap-3 py-2 text-xs hover:bg-secondary/30 px-2 rounded">
                  <Link to={r.run_id ? `/runs/${r.run_id}` : "#"} className="flex items-center gap-3 flex-1 min-w-0">
                    <span className={`mono uppercase text-[10px] px-1.5 py-0.5 rounded ${shown === "pass" ? "bg-emerald-500/15 text-emerald-500" : shown === "fail" ? "bg-destructive/15 text-destructive" : "bg-secondary text-muted-foreground"}`}>{shown}</span>
                    <span className="mono text-muted-foreground">{new Date(r.created_at).toLocaleString()}</span>
                    <span className="flex-1 truncate text-muted-foreground">{r.analysis || (r.actual ? JSON.stringify(r.actual).slice(0, 120) : "—")}</span>
                    {r.run_id && <span className="mono text-muted-foreground">run {r.run_id.slice(0, 8)}</span>}
                  </Link>
                  <button
                    type="button"
                    title="Delete this log"
                    disabled={deletingHistoryId === r.id}
                    onClick={() => void deleteHistoryRow(r)}
                    className="text-muted-foreground hover:text-destructive shrink-0 disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        <Dialog open={refUrlDialogOpen} onOpenChange={(o) => { if (!o) { setRefUrlDialogOpen(false); setPendingSyncCode(null); } }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Reference report URL</DialogTitle>
            </DialogHeader>
            <div className="space-y-2 text-xs">
              <p className="text-muted-foreground">
                This URL is used by the Reference Script (it replaces <span className="mono">page.goto(...)</span> in the main script).
              </p>
              <Input
                autoFocus
                placeholder="https://…"
                value={refUrlDraft}
                onChange={(e) => setRefUrlDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveReferenceUrl(); } }}
              />
            </div>
            <DialogFooter>
              <Button size="sm" variant="outline" onClick={() => { setRefUrlDialogOpen(false); setPendingSyncCode(null); }}>Cancel</Button>
              <Button size="sm" onClick={saveReferenceUrl}>Save</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <AlertDialog open={!!applyCredDialog} onOpenChange={(open) => { if (!open && !applyCredBusy) setApplyCredDialog(null); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Apply credentials to entire report?</AlertDialogTitle>
              <AlertDialogDescription>
                {applyCredDialog && (
                  <>
                    Set <b>{credProfileLabel(applyCredDialog.value, applyCredDialog.field)}</b> as the{" "}
                    {applyCredDialog.field === "credential_profile_id" ? "main login" : "reference login"} credentials
                    on <b>{(scenario as any)?.reports?.name || "this report"}</b> and every scenario in it.
                    Existing per-scenario overrides will be replaced.
                  </>
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={applyCredBusy}>Cancel</AlertDialogCancel>
              <AlertDialogAction disabled={applyCredBusy} onClick={(e) => { e.preventDefault(); void applyCredToAllInReport(); }}>
                {applyCredBusy ? "Applying…" : "Apply to all"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </AppLayout>
  );
}


function RuntimeBlock({
  title, running, onRun, liveUrl, runError, runResult, extra, footer,
}: {
  title: string;
  running: null | "headed" | "headless";
  onRun: (m: "headed" | "headless") => void;
  liveUrl: string | null;
  runError: string | null;
  runResult: any;
  extra?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-sm">{title}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2 flex-wrap items-center">
          <Button disabled={!!running} onClick={() => onRun("headless")}><Play className="h-3 w-3 mr-1" />{running === "headless" ? "Running…" : "Run headless"}</Button>
          {extra}
        </div>
        <p className="text-xs text-muted-foreground">
          Headed / live browser is not available on self-hosted Browserless OSS. Scripts run headless via /chromium/function and return screenshots.
        </p>
        {footer}
        {runError && (
          <div className="rounded border border-destructive/40 bg-destructive/10 text-destructive text-xs p-3 whitespace-pre-wrap mono">
            <div className="font-semibold mb-1">Runtime error</div>{runError}
          </div>
        )}
        {liveUrl && (
          <div className="space-y-1">
            <div className="text-[10px] uppercase text-muted-foreground">Live browser · {liveUrl}</div>
            <iframe src={liveUrl} className="w-full h-[640px] rounded border border-border bg-secondary/40" />
          </div>
        )}
        {runResult && !runError && (
          <div className="space-y-2">
            {(runResult.screenshot_url || runResult.screenshot_b64 || runResult.extracted?.screenshot) && (
              <img src={runResult.screenshot_url || `data:image/png;base64,${runResult.screenshot_b64 || runResult.extracted?.screenshot}`} alt="Final screenshot" className="w-full rounded border border-border" />
            )}
            {runResult.extracted && (
              <pre className="mono text-xs p-3 rounded border border-border bg-secondary/40 overflow-auto">{JSON.stringify(runResult.extracted, null, 2)}</pre>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function deriveMetricFromTitle(title?: string): string {
  if (!title) return "Primary KPI";
  const cleaned = title.replace(/^\s*Compare\s+/i, "").trim();
  const m = cleaned.match(/^(.+?)\s+(?:under|in|on|from|vs|against|by|for)\b/i);
  if (m) return m[1].trim();
  const v = cleaned.split(/\s+vs\s+/i)[0].trim();
  return v || title;
}

function pickPrimary(obj: any): { key: string | null; value: any } {
  if (!obj || typeof obj !== "object") return { key: null, value: obj ?? null };
  const entries = Object.entries(obj).filter(([k]) => !k.startsWith("__"));
  // prefer numeric
  for (const [k, v] of entries) {
    if (typeof v === "number") return { key: k, value: v };
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(String(v).replace(/[,\s]/g, "")))) return { key: k, value: v };
  }
  if (entries.length) return { key: entries[0][0], value: entries[0][1] };
  return { key: null, value: null };
}

function fmt(v: any): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return v.toLocaleString();
  if (typeof v === "string") return v;
  if (Array.isArray(v) || (v && typeof v === "object")) {
    const n = structuredSize(v);
    const json = JSON.stringify(v);
    if (json.length <= 140) return json;
    const kind = Array.isArray(v) ? "rows" : (v.rows || v.data || v.series) ? "rows" : "keys";
    return `${json.slice(0, 120)}… (${n} ${kind})`;
  }
  return JSON.stringify(v);
}

function recordsToTable(records: any[]): { columns: string[]; rows: any[][] } | null {
  if (!records?.length || typeof records[0] !== "object" || Array.isArray(records[0])) return null;
  const columns: string[] = [];
  for (const rec of records) {
    for (const k of Object.keys(rec || {})) {
      if (isKpiNoiseKey(k) || /^col_\d+$/i.test(k)) continue;
      if (!columns.includes(k)) columns.push(k);
    }
  }
  if (!columns.length) return null;
  return { columns, rows: records.map((rec) => columns.map((c) => rec?.[c] ?? "")) };
}

function columnLabel(c: any, i: number) {
  if (c == null) return `Col ${i + 1}`;
  if (typeof c === "string" || typeof c === "number") return String(c);
  return String(c.name || c.label || c.title || c.key || `Col ${i + 1}`);
}

function toTableModel(v: any): { columns: string[]; rows: any[][] } | null {
  if (v == null || typeof v === "boolean" || typeof v === "number" || typeof v === "string") return null;
  if (Array.isArray(v)) {
    if (!v.length) return null;
    if (typeof v[0] === "object" && v[0] && !Array.isArray(v[0])) return recordsToTable(v);
    if (Array.isArray(v[0])) {
      const first = v[0].map((c: any, i: number) => columnLabel(c, i));
      const restLooksLikeHeader = v[0].every((c: any) => typeof c === "string" && Number.isNaN(toNum(c)));
      if (restLooksLikeHeader && v.length > 1) {
        return { columns: first, rows: v.slice(1) };
      }
      return { columns: first.map((_, i) => `Col ${i + 1}`), rows: v };
    }
    return { columns: ["Value"], rows: v.map((cell) => [cell]) };
  }
  if (typeof v !== "object") return null;

  const nested = [v.data, v.grid, v.graph, v.table, v.tableData, v.dataset]
    .find((x) => x && (Array.isArray(x) || typeof x === "object"));
  if (nested && nested !== v) {
    const inner = toTableModel(nested);
    if (inner) return inner;
  }

  if (Array.isArray(v.rows)) {
    const cols = Array.isArray(v.columns) ? v.columns.map(columnLabel) : null;
    if (v.rows[0] && typeof v.rows[0] === "object" && !Array.isArray(v.rows[0])) {
      return recordsToTable(v.rows);
    }
    if (Array.isArray(v.rows[0])) {
      if (cols) return { columns: cols, rows: v.rows };
      return toTableModel(v.rows);
    }
  }

  if (Array.isArray(v.series)) {
    const cats = v.categories || v.labels || v.x || [];
    const columns = ["Label", ...v.series.map((s: any, i: number) => s?.name || s?.label || `Series ${i + 1}`)];
    const len = Math.max(
      cats.length,
      ...v.series.map((s: any) => (s?.data || s?.values || s?.points || []).length),
    );
    const rows = Array.from({ length: len }, (_, i) => [
      cats[i] ?? i + 1,
      ...v.series.map((s: any) => (s?.data || s?.values || s?.points || [])[i] ?? ""),
    ]);
    return rows.length ? { columns, rows } : null;
  }

  if (Array.isArray(v.labels) && Array.isArray(v.values)) {
    return { columns: ["Label", "Value"], rows: v.labels.map((l: any, i: number) => [l, v.values[i]]) };
  }

  const primitiveEntries = Object.entries(v).filter(([k, val]) => {
    if (isKpiNoiseKey(k) || STRUCTURED_KPI_KEYS.has(k.toLowerCase().replace(/[^a-z0-9]/g, ""))) return false;
    return val !== null && val !== undefined && typeof val !== "object";
  });
  if (primitiveEntries.length >= 2) {
    return { columns: ["Key", "Value"], rows: primitiveEntries.map(([k, val]) => [k, val]) };
  }
  return null;
}

function MiniDataTable({ columns, rows, large }: { columns: string[]; rows: any[][]; large?: boolean }) {
  return (
    <div className={`${large ? "max-h-96" : "max-h-64"} max-w-full overflow-auto rounded border border-border bg-background`}>
      <table className="w-max min-w-full text-[11px] leading-tight">
        <thead className="sticky top-0 bg-secondary/80 text-muted-foreground">
          <tr>
            {columns.map((c) => (
              <th key={c} className="text-left px-2 py-1 font-medium whitespace-nowrap">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-t border-border/70">
              {columns.map((_, j) => (
                <td key={j} className="px-2 py-0.5 mono whitespace-nowrap">{fmt(row?.[j] ?? "")}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Side-by-side Actual vs Reference grids (Geography / Performance Trend style). */
function GridComparePanels({ actual, expected, leftLabel, rightLabel }: {
  actual: any; expected: any; leftLabel: string; rightLabel: string;
}) {
  const a = toTableModel(actual);
  const e = toTableModel(expected);
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 w-full min-w-0">
      <div className="min-w-0 space-y-1">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{leftLabel}</div>
        {a ? <MiniDataTable columns={a.columns} rows={a.rows} large /> : (
          <div className="text-muted-foreground text-[11px] border border-dashed border-border rounded p-2">No grid data</div>
        )}
      </div>
      <div className="min-w-0 space-y-1">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{rightLabel}</div>
        {e ? <MiniDataTable columns={e.columns} rows={e.rows} large /> : (
          <div className="text-muted-foreground text-[11px] border border-dashed border-border rounded p-2">No grid data</div>
        )}
      </div>
    </div>
  );
}

function KpiValue({ value, large }: { value: any; large?: boolean }) {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground">—</span>;
  }
  const table = toTableModel(value);
  if (table) return <MiniDataTable columns={table.columns} rows={table.rows} large={large} />;
  return <span className="mono font-semibold">{fmt(value)}</span>;
}

function ComparisonTable({ expected, actual, diff, leftLabel, rightLabel, scenarioTitle }: { expected: any; actual: any; diff: any; leftLabel: string; rightLabel: string; scenarioTitle?: string }) {
  const metricLabel = deriveMetricFromTitle(scenarioTitle);
  const primaryActual = pickPrimary(actual);
  const primaryExpected = pickPrimary(expected);
  const hasPrimary = primaryActual.value !== null || primaryExpected.value !== null;
  const aNum = Number(String(primaryActual.value ?? "").replace(/[,\s]/g, ""));
  const eNum = Number(String(primaryExpected.value ?? "").replace(/[,\s]/g, ""));
  const bothNumeric = Number.isFinite(aNum) && Number.isFinite(eNum);
  const deltaAbs = bothNumeric ? aNum - eNum : null;
  const deltaPct = bothNumeric && eNum !== 0 ? (deltaAbs! / Math.abs(eNum)) * 100 : null;
  const mismatch = bothNumeric
    ? aNum !== eNum
    : JSON.stringify(primaryActual.value) !== JSON.stringify(primaryExpected.value);

  const keys = Array.from(new Set([...Object.keys(actual || {}), ...Object.keys(expected || {})])).filter((k) => !k.startsWith("__"));

  return (
    <div className="space-y-3">
      {hasPrimary && (
        <div className="border border-border rounded overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-secondary/40 text-muted-foreground">
              <tr>
                <th className="text-left p-2">KPI</th>
                <th className="text-left p-2">{leftLabel}</th>
                <th className="text-left p-2">{rightLabel}</th>
                <th className="text-left p-2">Diff</th>
              </tr>
            </thead>
            <tbody>
              <tr className={`border-t border-border ${mismatch ? "bg-destructive/5" : ""}`}>
                <td className="p-2">
                  <div className="font-semibold">{metricLabel}</div>
                  <div className="text-[10px] text-muted-foreground mono">
                    {primaryActual.key || "—"} ↔ {primaryExpected.key || "—"}
                  </div>
                </td>
                <td className="p-2 mono font-semibold">{fmt(primaryActual.value)}</td>
                <td className="p-2 mono font-semibold">{fmt(primaryExpected.value)}</td>
                <td className="p-2 mono">
                  {deltaAbs !== null ? (
                    <span className={mismatch ? "text-destructive" : "text-muted-foreground"}>
                      {deltaAbs > 0 ? "+" : ""}{fmt(deltaAbs)}
                      {deltaPct !== null && (
                        <span className="text-muted-foreground ml-1">
                          ({deltaPct > 0 ? "+" : ""}{deltaPct.toFixed(2)}%)
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">{mismatch ? "≠" : "="}</span>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {keys.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            Raw extracted values ({keys.length})
          </summary>
          <div className="border border-border rounded overflow-hidden mt-2">
            <table className="w-full text-xs">
              <thead className="bg-secondary/40 text-muted-foreground">
                <tr><th className="text-left p-2">Key</th><th className="text-left p-2">{leftLabel}</th><th className="text-left p-2">{rightLabel}</th><th className="text-left p-2">Diff</th></tr>
              </thead>
              <tbody>
                {keys.map((k) => {
                  const a = (actual || {})[k];
                  const e = (expected || {})[k];
                  const d = (diff || {})[k];
                  const mm = JSON.stringify(a) !== JSON.stringify(e);
                  return (
                    <tr key={k} className={`border-t border-border ${mm ? "bg-destructive/5" : ""}`}>
                      <td className="p-2 mono">{k}</td>
                      <td className="p-2 mono">{JSON.stringify(a)}</td>
                      <td className="p-2 mono">{JSON.stringify(e)}</td>
                      <td className="p-2 mono text-muted-foreground">{d != null ? JSON.stringify(d) : (mm ? "≠" : "=")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {!hasPrimary && keys.length === 0 && (
        <div className="grid grid-cols-2 gap-2">
          <div><div className="text-[10px] uppercase text-muted-foreground mb-1">{leftLabel}</div><pre className="mono text-[11px] p-2 rounded border border-border bg-secondary/40 overflow-auto max-h-64">{JSON.stringify(actual ?? null, null, 2)}</pre></div>
          <div><div className="text-[10px] uppercase text-muted-foreground mb-1">{rightLabel}</div><pre className="mono text-[11px] p-2 rounded border border-border bg-secondary/40 overflow-auto max-h-64">{JSON.stringify(expected ?? null, null, 2)}</pre></div>
        </div>
      )}
    </div>
  );
}

const KPI_SKIP_KEYS = new Set([
  "filters_applied", "nbrx_elements_found", "extraction_error", "raw_value", "raw_extraction",
  "screenshot", "screenshot_b64", "screenshot_url", "error", "ok", "note",
  "title", "url", "result", "extracted", "report_url", "debug", "page_snapshot",
]);

/** Playwright / a11y locator fields — not KPI numbers. */
const KPI_META_KEYS = new Set([
  "via", "role", "nth", "selector", "locator", "snapshot", "clicked", "opened",
  "option", "clickedText", "job_id", "source", "filter", "filters",
  // Filter / scrape bookkeeping — not the grid or graph payload.
  "metric", "time_bucket", "timebucket", "navigation", "area", "region", "territory",
  "time_grain", "time_grain_retry", "chart_title", "show_data_error", "mstr_error_dismissed",
  "tabledata_rejected", "filters_applied", "dossier_ready",
  "periods", "missing", "unparsed_periods", "consecutive", "trend_error", "grains",
  "show_data_debug", "show_data_error", "extract_via", "first_col0", "selected_grain",
  "time_grain_click", "grain_retries", "headers", "tableData", "tabledata",
]);

const STRUCTURED_KPI_KEYS = new Set([
  "grid", "graph", "data", "table", "tabledata", "series", "chart", "rows",
  "heatmap", "viz", "dataset",
]);

const KPI_NOISE_NORM = new Set(
  [...KPI_SKIP_KEYS, ...KPI_META_KEYS].map((k) => k.toLowerCase().replace(/[^a-z0-9]/g, "")),
);

function isKpiNoiseKey(k: string) {
  const raw = String(k || "");
  if (!raw || raw.startsWith("__")) return true;
  if (KPI_SKIP_KEYS.has(raw) || KPI_META_KEYS.has(raw)) return true;
  if (
    /(?:^|[_\s-])(grid_ready|show_data|show_data_debug|show_data_error|open_result|navigation|filters_applied|popup_debug|debug)$/i.test(raw) ||
    /_(grid_ready|show_data|show_data_debug|show_data_error|open_result|navigation|filters_applied|popup_debug|debug)$/i.test(raw)
  ) return true;
  return KPI_NOISE_NORM.has(raw.toLowerCase().replace(/[^a-z0-9]/g, ""));
}

function looksLikeLocatorJunk(v: any): boolean {
  if (typeof v !== "string") return false;
  const s = v.trim().toLowerCase();
  return s.startsWith("aria-") || s === "via" || s.includes("locator") || s.includes("row-grid");
}

/** Same label persist + sync must use. Empty combo.label used to become Filter #N in the UI and combo_N in history. */
function comboPersistLabel(combo: any, idx: number): string {
  return String(combo?.label || `combo_${idx + 1}`);
}

function storedRowFilterLabel(row: any): string {
  return String(row?.actual?.filter || row?.expected?.filter || row?.actual?.filters_applied?.__label || "");
}

function matchStoredComboRow(runRows: any[], combo: any, idx: number, liveLabel: string) {
  const aliases = new Set(
    [liveLabel, comboPersistLabel(combo, idx), combo?.id, `combo_${idx + 1}`, `Filter #${idx + 1}`]
      .filter(Boolean)
      .map(String),
  );
  return (runRows || []).find((r) => aliases.has(storedRowFilterLabel(r))) || runRows?.[idx] || null;
}

function looksLikeComboLabel(k: string) {
  return / \/ /.test(k) || /^combo[_ ]?\d+/i.test(k) || /^filter #\d+/i.test(k);
}

/** Primitive, array, or graph-series object. Not a Playwright locator. */
function unwrapKpiLeaf(v: any): any {
  if (v === null || v === undefined || typeof v === "boolean") return undefined;
  if (looksLikeLocatorJunk(v)) return undefined;
  if (typeof v === "number" || typeof v === "string") return v;
  if (Array.isArray(v)) return v.length ? v : undefined;
  if (typeof v !== "object") return undefined;
  if (v.value !== undefined) {
    const inner = unwrapKpiLeaf(v.value);
    if (inner !== undefined) return inner;
  }
  const keys = Object.keys(v).filter((k) => !isKpiNoiseKey(k));
  if (!keys.length) return undefined;
  if (keys.some((k) => looksLikeComboLabel(k))) return undefined;
  const cleaned: Record<string, any> = {};
  for (const k of keys) {
    const u = unwrapKpiLeaf(v[k]);
    if (u !== undefined) cleaned[k] = u;
  }
  return Object.keys(cleaned).length ? cleaned : undefined;
}

function findNamedKpi(node: any, name: string, depth = 0): any {
  if (!node || typeof node !== "object" || depth > 8) return undefined;
  if (Array.isArray(node)) return undefined;
  const want = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "");
  for (const [k, v] of Object.entries(node)) {
    if (String(k).toLowerCase().replace(/[^a-z0-9]+/g, "") === want) {
      const u = unwrapKpiLeaf(v);
      if (u !== undefined) return u;
    }
  }
  for (const [k, v] of Object.entries(node)) {
    if (isKpiNoiseKey(k) && k !== "extracted" && k !== "result" && k !== "results") continue;
    if (v && typeof v === "object") {
      const found = findNamedKpi(v, name, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function isStructuredKpiValue(v: any): boolean {
  if (v == null || typeof v === "boolean") return false;
  if (Array.isArray(v)) {
    if (!v.length) return false;
    const first = v[0];
    return Array.isArray(first) || (first && typeof first === "object") || v.length > 1;
  }
  if (typeof v !== "object") return false;
  const keys = Object.keys(v).filter((k) => !isKpiNoiseKey(k));
  return keys.some((k) => STRUCTURED_KPI_KEYS.has(k.toLowerCase().replace(/[^a-z0-9]/g, "")))
    || keys.length >= 2;
}

function looksLikeStructuredKpiName(name: string) {
  return /segment|summary|grid|graph|table|chart|series|heatmap|viz|dataset|geography|performance|overall/.test(String(name).toLowerCase());
}

function isStructuredKeyName(k: string) {
  return STRUCTURED_KPI_KEYS.has(String(k).toLowerCase().replace(/[^a-z0-9]/g, ""));
}

function collectStructuredKeys(...maps: Array<Record<string, any> | null | undefined>): string[] {
  const keys = new Set<string>();
  for (const map of maps) {
    if (!map || typeof map !== "object") continue;
    for (const [k, v] of Object.entries(map)) {
      if (isKpiNoiseKey(k)) continue;
      if (isStructuredKeyName(k) || isStructuredKpiValue(v)) keys.add(k);
    }
  }
  return Array.from(keys);
}

function structuredSize(v: any): number {
  if (Array.isArray(v)) return v.length;
  if (v && typeof v === "object") {
    if (Array.isArray(v.rows)) return v.rows.length;
    if (Array.isArray(v.data)) return v.data.length;
    if (Array.isArray(v.series)) return v.series.length;
    return Object.keys(v).length;
  }
  return 0;
}

/** Script output uses keys like grid/data/graph; the scenario KPI is often "Segment Summary". */
function pickStructuredKpi(map: any): any {
  if (!map || typeof map !== "object" || Array.isArray(map)) return undefined;
  const td = map.tableData || map.tabledata;
  if (td && isStructuredKpiValue(td)) return td;
  const entries = Object.entries(map).filter(([k, v]) => !isKpiNoiseKey(k) && isStructuredKpiValue(v));
  if (!entries.length) return undefined;
  const preferred = entries.find(([k]) => STRUCTURED_KPI_KEYS.has(k.toLowerCase().replace(/[^a-z0-9]/g, "")));
  if (preferred) return preferred[1];
  if (entries.length === 1) return entries[0][1];
  return entries.slice().sort((a, b) => structuredSize(b[1]) - structuredSize(a[1]))[0][1];
}

function lookupKpiExact(obj: any, k: string): any {
  if (!obj || typeof obj !== "object") return undefined;
  if (obj[k] !== undefined) return obj[k];
  const t = String(k).toLowerCase().replace(/[^a-z0-9]+/g, "");
  const f = Object.keys(obj).find((rk) => String(rk).toLowerCase().replace(/[^a-z0-9]+/g, "") === t);
  return f ? obj[f] : undefined;
}

function resolveKpiValue(name: string, ...sources: any[]): any {
  for (const src of sources) {
    if (!src || typeof src !== "object") continue;
    const direct = lookupKpiExact(src, name);
    if (direct !== undefined && direct !== null) return direct;
    const named = findNamedKpi(src, name);
    if (named !== undefined) return named;
  }
  const normalizedName = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (normalizedName === "count") {
    for (const src of sources) {
      if (!src || typeof src !== "object" || Array.isArray(src)) continue;
      const map = src.values && typeof src.values === "object" && !Array.isArray(src.values)
        ? src.values
        : src;
      const rowCountKeys = Object.keys(map).filter((key) =>
        /^rowcount/.test(String(key).toLowerCase().replace(/[^a-z0-9]+/g, ""))
      );
      if (rowCountKeys.length === 1 && map[rowCountKeys[0]] != null) {
        return map[rowCountKeys[0]];
      }
    }
  }
  const allowFallback = looksLikeStructuredKpiName(name);
  for (const src of sources) {
    if (!src || typeof src !== "object" || Array.isArray(src)) continue;
    const map = src.values && typeof src.values === "object" && !Array.isArray(src.values)
      ? { ...extractKpisFromBlock(src.values), ...src }
      : src;
    const structured = pickStructuredKpi(map) ?? pickStructuredKpi(extractKpisFromBlock(map));
    if (structured === undefined) continue;
    const structuredCount = Object.entries(map).filter(([k, v]) => !isKpiNoiseKey(k) && isStructuredKpiValue(v)).length;
    const scalarCount = Object.entries(map).filter(([k, v]) => !isKpiNoiseKey(k) && !isStructuredKpiValue(v) && v != null).length;
    // Only treat the lone grid/table as this KPI when the name itself is a
    // table-like label. Do not alias every configured column onto the grid.
    if (allowFallback || (structuredCount === 1 && scalarCount === 0 && looksLikeStructuredKpiName(name))) return structured;
  }
  return undefined;
}

type TrendPayload = {
  periods: string[];
  missing: string[];
  consecutive: boolean | null;
  time_grain: string | null;
  trend_error: string | null;
  score: number | null;
  grains?: TrendPayload[];
};

function grainLabel(v: any): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (v && typeof v === "object" && typeof v.grain === "string") return v.grain;
  return null;
}

function periodsFromTableData(td: any): string[] {
  if (!td || typeof td !== "object") return [];
  const headers = Array.isArray(td.headers) ? td.headers : [];
  const rows = td.rows || td.data;
  if (!Array.isArray(rows) || !rows.length) return [];
  let col = headers.findIndex((h: any) => /date|month|week|quarter|period|time|bucket/i.test(String(h || "")));
  if (col < 0) col = 0;
  const key = headers[col] || (rows[0] && typeof rows[0] === "object" && !Array.isArray(rows[0])
    ? Object.keys(rows[0])[0]
    : null);
  const out: string[] = [];
  for (const row of rows) {
    let cell: any;
    if (Array.isArray(row)) cell = row[col];
    else if (row && typeof row === "object") cell = key ? row[key] : Object.values(row)[0];
    else cell = row;
    const t = String(cell ?? "").replace(/\s+/g, " ").trim();
    if (t && !/^(total|grand total|sum)$/i.test(t)) out.push(t);
  }
  return out;
}

function sliceToTrendPayload(map: any, grainHint?: string): TrendPayload | null {
  if (!map || typeof map !== "object") return null;
  const td = map.tableData || map.tabledata;
  const periods = Array.isArray(map.periods) && map.periods.length
    ? map.periods.map((p: any) => String(p))
    : periodsFromTableData(td);
  const missing = Array.isArray(map.missing) ? map.missing.map((p: any) => String(p)) : [];
  const consecutive = typeof map.consecutive === "boolean" ? map.consecutive : null;
  const scoreKey = grainHint ? `Trend check ${grainHint}` : "Trend check";
  const score = map[scoreKey] == null && map["Trend check"] == null
    ? null
    : Number(map[scoreKey] ?? map["Trend check"]);
  const time_grain = grainLabel(map.time_grain) || grainHint || null;
  const trend_error = map.trend_error ? String(map.trend_error) : null;
  if (!periods.length && consecutive == null && score == null && !trend_error) return null;
  return { periods, missing, consecutive, time_grain, trend_error, score };
}

function pickTrendPayload(...sources: any[]): TrendPayload | null {
  let best: TrendPayload | null = null;
  for (const src of sources) {
    if (!src || typeof src !== "object") continue;
    const maps = [src, src.values, src.extracted, src.result].filter((x) => x && typeof x === "object");
    for (const map of maps) {
      const grainMap = map.grains && typeof map.grains === "object" && !Array.isArray(map.grains)
        ? map.grains
        : null;
      const grainList: TrendPayload[] = [];
      if (grainMap) {
        for (const name of ["Weekly", "Monthly", "Quarterly"]) {
          const one = sliceToTrendPayload(grainMap[name], name);
          if (one) grainList.push({ ...one, time_grain: name });
        }
      }
      const cand = sliceToTrendPayload(map);
      if (grainList.length) {
        const merged: TrendPayload = {
          ...(cand || { periods: [], missing: [], consecutive: null, time_grain: "Weekly+Monthly+Quarterly", trend_error: null, score: null }),
          grains: grainList,
          consecutive: grainList.every((g) => g.consecutive === true),
          score: grainList.every((g) => g.consecutive === true) ? 1 : 0,
        };
        if (!best || (merged.grains?.length || 0) > (best.grains?.length || 0)) best = merged;
        continue;
      }
      if (!cand) continue;
      if (!best || cand.periods.length > best.periods.length) best = cand;
    }
  }
  return best;
}

function TrendCheckPanel({
  payload,
  filterLabel,
}: {
  payload: TrendPayload | null;
  filterLabel?: string;
}) {
  const badge = (s: "pass" | "fail" | "pending") => {
    const cls = s === "pass"
      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
      : s === "fail"
      ? "bg-destructive/15 text-destructive border-destructive/30"
      : "bg-secondary text-muted-foreground border-border";
    return <span className={`mono uppercase text-[10px] px-1.5 py-0.5 rounded border ${cls}`}>{s}</span>;
  };
  const pass = payload?.consecutive === true || payload?.score === 1;
  const fail = payload?.consecutive === false || payload?.score === 0
    || (payload?.missing && payload.missing.length > 0) || !!payload?.trend_error;
  const status: "pass" | "fail" | "pending" = !payload ? "pending" : (pass && !fail ? "pass" : fail ? "fail" : "pending");
  const grainBlocks = payload?.grains?.length ? payload.grains : (payload ? [payload] : []);
  return (
    <div className="border border-border rounded p-3 space-y-3 text-xs">
      <div className="flex items-center gap-2 flex-wrap">
        {filterLabel && <span className="font-semibold">{filterLabel}</span>}
        <span className="text-muted-foreground">Trend check — all toggles</span>
        {badge(status)}
      </div>
      {payload?.trend_error && grainBlocks.length <= 1 && (
        <div className="text-destructive">{payload.trend_error}</div>
      )}
      {grainBlocks.map((g, gi) => {
        const gPass = g.consecutive === true || g.score === 1;
        const gFail = g.consecutive === false || g.score === 0 || (g.missing || []).length > 0 || !!g.trend_error;
        const gStatus: "pass" | "fail" | "pending" = gPass && !gFail ? "pass" : gFail ? "fail" : "pending";
        const periods = g.periods || [];
        const missing = g.missing || [];
        return (
          <div key={g.time_grain || gi} className="border border-border rounded p-2 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold mono">{g.time_grain || "Period"}</span>
              {badge(gStatus)}
              <span className="text-muted-foreground">{periods.length} period{periods.length === 1 ? "" : "s"}</span>
            </div>
            {g.trend_error && <div className="text-destructive">{g.trend_error}</div>}
            <div>
              <div className="text-[10px] uppercase text-muted-foreground mb-1">Periods on graph</div>
              {periods.length ? (
                <div className="flex flex-wrap gap-1">
                  {periods.map((p, i) => (
                    <span key={`${p}-${i}`} className="mono px-1.5 py-0.5 rounded border border-border bg-secondary/40">
                      {p}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="text-muted-foreground">No labels extracted for this toggle.</div>
              )}
            </div>
            <div>
              <div className="text-[10px] uppercase text-muted-foreground mb-1">Missing (gap in the middle)</div>
              {missing.length ? (
                <div className="flex flex-wrap gap-1">
                  {missing.map((p, i) => (
                    <span key={`${p}-${i}`} className="mono px-1.5 py-0.5 rounded border border-destructive/40 text-destructive">
                      {p}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="text-muted-foreground">{periods.length >= 2 ? "None — consecutive" : "—"}</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function aliasConfiguredKpis(values: Record<string, any>, tolerances?: Record<string, Tolerance>): Record<string, any> {
  const configured = Object.keys(tolerances || {}).filter((k) => !isKpiNoiseKey(k));
  if (configured.length) {
    const selected: Record<string, any> = {};
    for (const name of configured) {
      const resolved = resolveKpiValue(name, values || {}, values || {});
      if (resolved !== undefined) selected[name] = resolved;
    }
    return selected;
  }
  return Object.fromEntries(
    Object.entries(values || {}).filter(([key]) => !isKpiNoiseKey(key)),
  );
}

/** KPI_LABELS from a generated Playwright script (source of truth for what was scraped). */
function parseKpiLabelsFromPlaywright(code?: string | null): string[] {
  if (!code) return [];
  const m = code.match(/const\s+KPI_LABELS\s*=\s*\[([\s\S]*?)\];/);
  if (!m) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const sm of m[1].matchAll(/["']([^"']+)["']/g)) {
    const s = sm[1].trim();
    const key = s.toLowerCase();
    if (!s || seen.has(key) || isKpiNoiseKey(s)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/** Latest result rows: Add/Remove KPI list is the source of truth when configured. */
function resultKpiNames(
  tolerances: Record<string, Tolerance> | undefined,
  scriptLabels: string[] | undefined,
  ...extractedMaps: Array<Record<string, any> | null | undefined>
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const key = String(raw || "").trim();
    if (!key || key.startsWith("__") || isKpiNoiseKey(key) || seen.has(key.toLowerCase())) return;
    seen.add(key.toLowerCase());
    names.push(key);
  };
  for (const k of Object.keys(tolerances || {})) add(k);
  if (names.length) return names;
  for (const k of scriptLabels || []) add(k);
  for (const map of extractedMaps) {
    if (!map || typeof map !== "object") continue;
    for (const k of Object.keys(map)) add(k);
  }
  return names;
}

function extractKpisFromBlock(block: any): Record<string, any> {
  if (!block || typeof block !== "object" || Array.isArray(block)) return {};
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(block)) {
    if (k.startsWith("__")) continue;
    if ((k === "extracted" || k === "result" || k === "results") && v && typeof v === "object" && !Array.isArray(v)) {
      Object.assign(out, extractKpisFromBlock(v));
      continue;
    }
    if (isKpiNoiseKey(k)) continue;
    if (v && typeof v === "object" && !Array.isArray(v) && (looksLikeComboLabel(k) || Object.keys(extractKpisFromBlock(v)).length)) {
      const nested = extractKpisFromBlock(v);
      if (looksLikeComboLabel(k) && Object.keys(nested).length) {
        Object.assign(out, nested);
        continue;
      }
    }
    const leaf = unwrapKpiLeaf(v);
    if (leaf !== undefined && !looksLikeComboLabel(k)) out[k] = leaf;
  }
  const td = block.tableData || block.tabledata;
  if (td && !out.tableData) out.tableData = td;
  if (Object.keys(out).length) return out;
  const nested = Object.entries(block).filter(([k, v]) => {
    if (isKpiNoiseKey(k) && k !== "extracted" && k !== "result" && k !== "results") return false;
    return !!v && typeof v === "object" && !Array.isArray(v);
  });
  if (nested.length === 1) return extractKpisFromBlock(nested[0][1]);
  return out;
}

function flattenResultRoot(c: any): any {
  if (!c || typeof c !== "object" || Array.isArray(c)) return null;
  if (c.results && typeof c.results === "object" && !Array.isArray(c.results)) {
    return flattenResultRoot(c.results);
  }
  // Browserless wrapper: { ok, error, result, url }
  if (c.result && typeof c.result === "object" && !Array.isArray(c.result) && ("ok" in c || "error" in c || "url" in c || "extracted" in c)) {
    return flattenResultRoot(c.result);
  }
  return c;
}

function pickResultRoot(rr: any): any {
  if (!rr || typeof rr !== "object") return null;
  const candidates = [
    rr?.extracted?.result?.results,
    rr?.result?.results,
    rr?.extracted?.result?.result,
    rr?.extracted?.result,
    rr?.result?.result,
    rr?.extracted?.extracted,
    rr?.result,
    rr?.extracted,
    rr,
  ];
  let fallback: any = null;
  for (const c of candidates) {
    const flat = flattenResultRoot(c);
    if (!flat || typeof flat !== "object") continue;
    if (!fallback) fallback = flat;
    if (Object.keys(extractKpisFromBlock(flat)).length) return flat;
  }
  return fallback;
}

function normComboLabel(s: string) {
  return String(s || "").toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
}

function pickComboBlock(root: any, label: string, idx: number, comboId?: string): any {
  if (!root || typeof root !== "object") return null;
  const exact = [
    label,
    `Filter #${idx + 1}`,
    `combo_${idx + 1}`,
    `combo${idx + 1}`,
    comboId,
    String(idx),
    String(idx + 1),
  ].filter(Boolean) as string[];
  for (const k of exact) {
    if (root[k] && typeof root[k] === "object" && !Array.isArray(root[k])) return root[k];
  }
  const want = normComboLabel(label);
  for (const [k, v] of Object.entries(root)) {
    if (KPI_SKIP_KEYS.has(k) || k.startsWith("__")) continue;
    if (v && typeof v === "object" && !Array.isArray(v) && normComboLabel(k) === want) return v;
  }
  const children = Object.entries(root).filter(([k, v]) => {
    if (KPI_SKIP_KEYS.has(k) || k.startsWith("__")) return false;
    if (!v || typeof v !== "object" || Array.isArray(v)) return false;
    return Object.keys(extractKpisFromBlock(v)).length > 0;
  });
  if (children.length === 1) return children[0][1];
  if (Object.keys(extractKpisFromBlock(root)).length) return root;
  return null;
}

function singleComboBlock(rr: any, label: string, idx: number, comboId?: string): any | null {
  const direct = pickComboBlock(pickResultRoot(rr), label, idx, comboId);
  if (direct) return direct;
  const kpis = extractKpisFromRun(rr);
  return kpis && Object.keys(kpis).length ? kpis : null;
}

function kpiMapFromStored(actual: any): Record<string, any> | null {
  if (!actual || typeof actual !== "object") return null;
  if (actual.values && typeof actual.values === "object") {
    const raw = flattenResultRoot(actual.values) || actual.values;
    const fromValues = extractKpisFromBlock(raw);
    const td = raw?.tableData || raw?.tabledata || actual.tableData;
    if (td && !fromValues.tableData) fromValues.tableData = td;
    if (Object.keys(fromValues).length) return fromValues;
  }
  if (actual.extracted) {
    const fromExtracted = extractKpisFromRun({ extracted: actual.extracted });
    if (fromExtracted && Object.keys(fromExtracted).length) return fromExtracted;
  }
  const flat = extractKpisFromBlock(actual);
  return Object.keys(flat).length ? flat : null;
}

function extractKpisFromRun(rr: any): Record<string, any> | null {
  if (!rr) return null;
  const candidates = [
    rr?.extracted?.result?.kpis,
    rr?.extracted?.result?.extracted,
    rr?.extracted?.result,
    rr?.extracted?.kpis,
    rr?.extracted?.extracted,
    rr?.result?.extracted,
    rr?.result,
    rr?.extracted,
    rr,
  ];
  for (const ex of candidates) {
    if (!ex || typeof ex !== "object" || Array.isArray(ex)) continue;
    if (ex.kpis && typeof ex.kpis === "object" && !Array.isArray(ex.kpis)) {
      const fromKpis = extractKpisFromBlock(ex.kpis);
      if (Object.keys(fromKpis).length) return fromKpis;
    }
    const flat = extractKpisFromBlock(ex);
    if (Object.keys(flat).length) return flat;
    const comboKeys = Object.keys(ex).filter((k) => !k.startsWith("__") && !isKpiNoiseKey(k));
    const comboBlocks = comboKeys.filter((k) => ex[k] && typeof ex[k] === "object" && !Array.isArray(ex[k]));
    if (comboBlocks.length && comboBlocks.length === comboKeys.length) {
      const merged: Record<string, any> = {};
      for (const ck of comboBlocks) Object.assign(merged, extractKpisFromBlock(ex[ck]));
      if (Object.keys(merged).length) return merged;
    }
  }
  return null;
}

function expectedValuesFromStoredRow(row: any): Record<string, any> {
  const exp = row?.expected;
  if (exp?.values && typeof exp.values === "object") {
    const fromValues = extractKpisFromBlock(flattenResultRoot(exp.values) || exp.values);
    if (Object.keys(fromValues).length) return fromValues;
  }
  return kpiMapFromStored(exp) || {};
}

function findStoredExpected(rows: any[] | undefined, label?: string): Record<string, any> {
  if (!rows?.length) return {};
  if (label) {
    const match = rows.find((r) => {
      const lbl = r?.actual?.filter || r?.expected?.filter || r?.actual?.filters_applied?.__label;
      return lbl && String(lbl) === String(label);
    });
    const fromMatch = expectedValuesFromStoredRow(match);
    if (Object.keys(fromMatch).length) return fromMatch;
  }
  for (const r of rows) {
    const v = expectedValuesFromStoredRow(r);
    if (Object.keys(v).length) return v;
  }
  return {};
}

function expectedFromSql(sqlRes: any, actualKeys: string[]): Record<string, any> {
  const out: Record<string, any> = {};
  if (!sqlRes?.ok) return out;
  for (const k of actualKeys) {
    const exp = expectedForKpi(sqlRes, k);
    if (exp !== null && exp !== undefined) out[k] = exp;
  }
  return out;
}

function resolveExpectedValues(opts: {
  label: string;
  idx: number;
  comboId?: string;
  actualKeys: string[];
  isReferenceMatch?: boolean;
  referencePayload?: any;
  storedRows?: any[];
  sqlByCombo?: Record<string, any>;
  sqlResult?: any;
}): Record<string, any> {
  const { label, idx, comboId, actualKeys, isReferenceMatch, referencePayload, storedRows, sqlByCombo, sqlResult } = opts;
  if (isReferenceMatch) {
    if (referencePayload) {
      const block = pickComboBlock(pickResultRoot(referencePayload), label, idx, comboId);
      const fromBlock = extractKpisFromBlock(block);
      if (Object.keys(fromBlock).length) return fromBlock;
      const fromRun = extractKpisFromRun(referencePayload);
      if (fromRun && Object.keys(fromRun).length) return fromRun;
    }
    return findStoredExpected(storedRows, label);
  }
  const sqlRes = (comboId && sqlByCombo?.[comboId]) || sqlResult;
  const fromSql = expectedFromSql(sqlRes, actualKeys);
  if (Object.keys(fromSql).length) return fromSql;
  // Warehouse SQL ran first and was already saved — reuse those expected values.
  return findStoredExpected(storedRows, label);
}

function lookupKpi(obj: any, k: string): any {
  const exact = lookupKpiExact(obj, k);
  if (exact !== undefined && exact !== null) return exact;
  return resolveKpiValue(k, obj) ?? null;
}

/** Aggregate many KPI comparisons: any fail → fail; any pending → pending; else pass. */
function overallFromPassResults(passes: Array<boolean | null | undefined>): "pass" | "fail" | "pending" {
  if (!passes.length) return "pending";
  if (passes.some((p) => p === false)) return "fail";
  if (passes.some((p) => p !== true)) return "pending";
  return "pass";
}

function statusFromKpis(
  actualValues: Record<string, any> | null | undefined,
  expectedValues: Record<string, any> | null | undefined,
  tolerances: Record<string, Tolerance> | undefined,
  scrapeFailed?: boolean,
): "pass" | "fail" | "pending" {
  if (scrapeFailed) return "fail";
  const actual = actualValues && typeof actualValues === "object" ? actualValues : {};
  const trendStatus = trendStatusFromValues(actual);
  if (trendStatus) return trendStatus;
  const expected = expectedValues && typeof expectedValues === "object" ? expectedValues : {};
  const configured = Object.keys(tolerances || {}).filter((k) => !isKpiNoiseKey(k));
  const structured = collectStructuredKeys(actual, expected);
  const extractedScalars = [actual, expected].flatMap((map) =>
    Object.keys(map || {}).filter((k) => !isKpiNoiseKey(k) && !isStructuredKeyName(k) && !isStructuredKpiValue(map[k])),
  );
  const scalarKeys = Array.from(new Set([
    ...configured.filter((k) => !isStructuredKeyName(k)),
    ...extractedScalars,
  ]));
  const keys = Array.from(new Set([...structured, ...scalarKeys]));
  if (!keys.length) return "pending";
  const passes = keys.map((k) => {
    const a = resolveKpiValue(k, actual);
    const e = resolveKpiValue(k, expected);
    // Grid/table vs a leftover named scalar is not a real KPI miss — skip it.
    if ((isStructuredKpiValue(a) || isStructuredKeyName(k)) && e != null && !isStructuredKpiValue(e) && !isStructuredKeyName(k)) return null;
    if ((isStructuredKpiValue(e) || isStructuredKeyName(k)) && a != null && !isStructuredKpiValue(a) && !isStructuredKeyName(k)) return null;
    return evalPass(a, e, getTol(tolerances || {}, k));
  });
  return overallFromPassResults(passes);
}

async function persistManualHeadlessRun(opts: {
  scenarioId: string;
  reportId?: string;
  payload: any;
  combos: any[];
  criticality?: string;
  referencePayload?: any;
  storedRows?: any[];
  tolerances?: Record<string, Tolerance>;
  sqlByCombo?: Record<string, any>;
  sqlResult?: any;
  isReferenceMatch?: boolean;
}): Promise<boolean> {
  const {
    scenarioId, reportId, payload, combos, criticality,
    referencePayload, storedRows, tolerances, sqlByCombo, sqlResult, isReferenceMatch,
  } = opts;
  if (!scenarioId || !reportId || !payload) return false;
  const extractedValues = extractKpisFromRun(payload) || {};
  const rawScrapeError = payload?.extracted?.ok === false || !!payload?.extracted?.error || !!payload?.error;
  // Wrapper payloads always carry `error: null` / leftover notes. Only treat the
  // scrape as failed when nothing usable (including values.grid) was extracted.
  const scrapeFailed = rawScrapeError && !Object.keys(extractedValues).length;
  const crit = criticality || "medium";
  const { data: run, error: runErr } = await supabase.from("runs").insert({
    scope_type: "scenario",
    scope_id: scenarioId,
    trigger_source: "manual",
    status: scrapeFailed ? "failed" : "completed",
    finished_at: new Date().toISOString(),
    summary: { source: "headless", total: 0 },
  }).select("id").single();
  if (runErr || !run) return false;

  const root = pickResultRoot(payload);
  const rows: any[] = [];
  if (combos?.length) {
    for (let i = 0; i < combos.length; i++) {
      const c = combos[i];
      const label = comboPersistLabel(c, i);
      const block = pickComboBlock(root, label, i, c.id);
      let values = extractKpisFromBlock(block);
      if (!Object.keys(values).length) values = extractKpisFromRun(payload) || {};
      values = attachTrendFields(values, block, payload, payload?.extracted, payload?.extracted?.result);
      values = aliasConfiguredKpis(values, tolerances);
      const expectedValues = resolveExpectedValues({
        label, idx: i, comboId: c.id, actualKeys: Object.keys(values),
        isReferenceMatch, referencePayload, storedRows, sqlByCombo, sqlResult,
      });
      const status = statusFromKpis(values, expectedValues, tolerances, scrapeFailed);
      rows.push({
        run_id: run.id,
        scenario_id: scenarioId,
        status,
        expected: {
          source: Object.keys(expectedValues).length
            ? (isReferenceMatch ? "reference_script" : "warehouse_sql")
            : "manual_headless",
          filter: label,
          values: expectedValues,
        },
        actual: {
          filter: label,
          values,
          source: "manual_headless",
          extracted: payload?.extracted ?? null,
        },
        diff: null,
        criticality: crit,
        severity: crit,
      });
    }
  } else {
    const values = aliasConfiguredKpis(
      attachTrendFields(extractKpisFromRun(payload) || {}, payload, payload?.extracted, payload?.extracted?.result),
      tolerances,
    );
    const expectedValues = resolveExpectedValues({
      label: "", idx: 0, actualKeys: Object.keys(values),
      isReferenceMatch, referencePayload, storedRows, sqlByCombo, sqlResult,
    });
    const status = statusFromKpis(values, expectedValues, tolerances, scrapeFailed);
    rows.push({
      run_id: run.id,
      scenario_id: scenarioId,
      status,
      expected: {
        source: Object.keys(expectedValues).length
          ? (isReferenceMatch ? "reference_script" : "warehouse_sql")
          : "manual_headless",
        values: expectedValues,
      },
      actual: { values, source: "manual_headless", extracted: payload?.extracted ?? null },
      diff: null,
      criticality: crit,
      severity: crit,
    });
  }
  if (!rows.length) return false;
  const { error: insErr } = await supabase.from("test_results").insert(rows);
  if (insErr) return false;
  const anyFail = rows.some((r) => r.status === "fail");
  await supabase.from("runs").update({
    status: scrapeFailed || anyFail ? "failed" : "completed",
    summary: {
      source: "headless",
      pass: rows.filter((r) => r.status === "pass").length,
      fail: rows.filter((r) => r.status === "fail").length,
      pending: rows.filter((r) => r.status === "pending").length,
      total: rows.length,
    },
  }).eq("id", run.id);
  return true;
}

async function persistWarehouseExpected(opts: {
  scenarioId: string;
  reportId?: string;
  combos: any[];
  sqlByCombo?: Record<string, any>;
  sqlResult?: any;
  tolerances?: Record<string, Tolerance>;
}): Promise<boolean> {
  const { scenarioId, reportId, combos, sqlByCombo, sqlResult, tolerances } = opts;
  if (!scenarioId) return false;
  const { data: recent } = await supabase
    .from("test_results")
    .select("id, run_id, expected, actual, status")
    .eq("scenario_id", scenarioId)
    .order("created_at", { ascending: false })
    .limit(25);
  const latestRunId = recent?.[0]?.run_id;
  let runRows = latestRunId ? (recent || []).filter((r: any) => r.run_id === latestRunId) : [];

  if (!runRows.length) {
    if (!reportId) return false;
    const { data: run, error: runErr } = await supabase.from("runs").insert({
      scope_type: "scenario",
      scope_id: scenarioId,
      trigger_source: "manual",
      status: "pending",
      summary: { source: "warehouse_sql", pass: 0, fail: 0, pending: 0, total: 0 },
    }).select("id").single();
    if (runErr || !run) return false;
    const inserts: any[] = [];
    if (combos?.length) {
      for (let i = 0; i < combos.length; i++) {
        const c = combos[i];
        const label = comboPersistLabel(c, i);
        const sqlRes = sqlByCombo?.[c.id] || (sqlResult?.ok ? sqlResult : null);
        const expectedValues = expectedFromSql(sqlRes, Object.keys(sqlRes?.rows?.[0] || {}));
        if (!Object.keys(expectedValues).length && sqlRes?.ok && sqlRes.scalar != null) {
          const col = sqlRes.columns?.[0] || "value";
          expectedValues[col] = sqlRes.scalar;
        }
        inserts.push({
          run_id: run.id,
          scenario_id: scenarioId,
          status: "pending",
          expected: { source: "warehouse_sql", filter: label, values: expectedValues },
          actual: { filter: label, values: {}, source: "manual_headless" },
          diff: null,
        });
      }
    } else {
      const sqlRes = sqlResult?.ok ? sqlResult : null;
      const expectedValues = expectedFromSql(sqlRes, Object.keys(sqlRes?.rows?.[0] || {}));
      if (!Object.keys(expectedValues).length && sqlRes?.ok && sqlRes.scalar != null) {
        const col = sqlRes.columns?.[0] || "value";
        expectedValues[col] = sqlRes.scalar;
      }
      inserts.push({
        run_id: run.id,
        scenario_id: scenarioId,
        status: "pending",
        expected: { source: "warehouse_sql", values: expectedValues },
        actual: { values: {}, source: "manual_headless" },
        diff: null,
      });
    }
    if (!inserts.length) return false;
    const { error: insErr } = await supabase.from("test_results").insert(inserts);
    if (!insErr) {
      await supabase.from("runs").update({
        status: "pending",
        summary: {
          source: "warehouse_sql",
          pass: 0,
          fail: 0,
          pending: inserts.length,
          total: inserts.length,
        },
      }).eq("id", run.id);
    }
    return !insErr;
  }

  let updated = 0;
  const targets = combos?.length ? combos : [null];
  for (let i = 0; i < targets.length; i++) {
    const c = targets[i];
    const label = c ? comboPersistLabel(c, i) : storedRowFilterLabel(runRows[0]);
    const sqlRes = (c && sqlByCombo?.[c.id]) || (sqlResult?.ok ? sqlResult : null);
    if (!sqlRes?.ok) continue;
    const existing = c ? matchStoredComboRow(runRows, c, i, label) : runRows[0];
    if (!existing) continue;
    const prevActual = (existing.actual && typeof existing.actual === "object") ? existing.actual : {};
    const prevExpected = (existing.expected && typeof existing.expected === "object") ? existing.expected : {};
    const actualValues = (prevActual.values && typeof prevActual.values === "object")
      ? prevActual.values
      : extractKpisFromBlock(prevActual);
    const actualKeys = Object.keys(actualValues || {}).filter((k) => !k.startsWith("__"));
    const expectedValues = expectedFromSql(sqlRes, actualKeys.length ? actualKeys : Object.keys(sqlRes.rows?.[0] || {}));
    if (!Object.keys(expectedValues).length && sqlRes.scalar != null && actualKeys.length === 1) {
      expectedValues[actualKeys[0]] = sqlRes.scalar;
    }
    if (!Object.keys(expectedValues).length) continue;
    const status = statusFromKpis(actualValues, expectedValues, tolerances);
    const { error } = await supabase.from("test_results").update({
      status,
      expected: { ...prevExpected, source: "warehouse_sql", filter: label || prevExpected.filter, values: expectedValues },
      analysis: "Updated from warehouse SQL",
    }).eq("id", existing.id);
    if (!error) updated += 1;
  }
  if (updated && latestRunId) {
    const { data: allRows } = await supabase.from("test_results").select("status").eq("run_id", latestRunId);
    const pass = (allRows || []).filter((r: any) => r.status === "pass").length;
    const fail = (allRows || []).filter((r: any) => r.status === "fail").length;
    const pending = (allRows || []).filter((r: any) => r.status === "pending").length;
    await supabase.from("runs").update({
      status: fail > 0 ? "failed" : (pending > 0 ? "running" : "completed"),
      summary: {
        source: "warehouse_sql",
        pass,
        fail,
        pending,
        total: (allRows || []).length,
      },
    }).eq("id", latestRunId);
  }
  return updated > 0;
}

async function persistReferenceHeadlessRun(opts: {
  scenarioId: string;
  payload: any;
  combos: any[];
  tolerances?: Record<string, Tolerance>;
}): Promise<boolean> {
  const { scenarioId, payload, combos, tolerances } = opts;
  if (!scenarioId || !payload) return false;
  // Only patch the latest run. Updating all recent rows rewrote past history
  // statuses whenever a new reference run failed (e.g. FAIL badge on an older
  // row whose analysis still said "live comparison passed").
  const { data: recent } = await supabase
    .from("test_results")
    .select("id, run_id, expected, actual, status")
    .eq("scenario_id", scenarioId)
    .order("created_at", { ascending: false })
    .limit(25);
  if (!recent?.length) return false;
  const latestRunId = recent[0]?.run_id;
  const runRows = latestRunId
    ? recent.filter((r: any) => r.run_id === latestRunId)
    : [];
  if (!runRows.length) return false;

  const root = pickResultRoot(payload);
  const expectedByLabel = new Map<string, Record<string, any>>();
  if (combos?.length) {
    for (let i = 0; i < combos.length; i++) {
      const lbl = combos[i].label || `combo_${i + 1}`;
      const block = pickComboBlock(root, lbl, i, combos[i].id);
      let vals = extractKpisFromBlock(block);
      if (!Object.keys(vals).length) vals = extractKpisFromRun(payload) || {};
      vals = aliasConfiguredKpis(vals, tolerances);
      if (Object.keys(vals).length) expectedByLabel.set(String(lbl), vals);
    }
  }
  const fallbackValues = extractKpisFromRun(payload) || {};
  if (!expectedByLabel.size && !Object.keys(fallbackValues).length) return false;

  let updated = 0;
  for (const row of runRows) {
    const rowLabel = row.actual?.filter || row.expected?.filter || combos?.[0]?.label;
    const values = (rowLabel && expectedByLabel.get(String(rowLabel)))
      || (expectedByLabel.size === 1 ? [...expectedByLabel.values()][0] : fallbackValues);
    if (!values || !Object.keys(values).length) continue;
    const prevExpected = (row.expected && typeof row.expected === "object") ? row.expected : {};
    const actualValues = kpiMapFromStored(row.actual) || {};
    const status = statusFromKpis(actualValues, values, tolerances);
    const { error } = await supabase.from("test_results").update({
      expected: {
        ...prevExpected,
        source: "reference_script",
        filter: rowLabel || prevExpected.filter || null,
        values,
        extracted: payload?.extracted ?? null,
      },
      status,
    }).eq("id", row.id);
    if (!error) updated += 1;
  }
  if (updated && latestRunId) {
    const { data: allRows } = await supabase.from("test_results").select("status").eq("run_id", latestRunId);
    const pass = (allRows || []).filter((r: any) => r.status === "pass").length;
    const fail = (allRows || []).filter((r: any) => r.status === "fail").length;
    const pending = (allRows || []).filter((r: any) => r.status === "pending").length;
    await supabase.from("runs").update({
      status: fail > 0 ? "failed" : (pending > 0 ? "running" : "completed"),
      summary: {
        source: "reference_script",
        pass,
        fail,
        pending,
        total: (allRows || []).length,
      },
    }).eq("id", latestRunId);
  }
  return updated > 0;
}

function toNum(v: any): number {
  if (v === null || v === undefined) return NaN;
  if (typeof v === "number") return v;
  return Number(String(v).replace(/[,\s%$]/g, ""));
}

function expectedForKpi(sqlRes: any, kpiKey: string): any {
  if (!sqlRes?.ok) return null;
  const cols: string[] = sqlRes.columns || (sqlRes.rows?.[0] ? Object.keys(sqlRes.rows[0]) : []);
  const row = sqlRes.rows?.[0];
  if (row && typeof row === "object") {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const target = norm(kpiKey);
    // exact / case-insensitive / normalized match on column
    const col =
      cols.find((c) => c === kpiKey) ||
      cols.find((c) => c.toLowerCase() === kpiKey.toLowerCase()) ||
      cols.find((c) => norm(c) === target) ||
      cols.find((c) => norm(c).includes(target) || target.includes(norm(c)));
    if (col && row[col] !== undefined) return row[col];
  }
  // Only fall back to a single scalar when the SQL returned exactly ONE numeric
  // value AND the KPI list has just one entry (single-KPI scenarios). Otherwise
  // returning the scalar for every KPI causes all rows to show the same number
  // (e.g. "58.00000000" repeated across every KPI).
  if (
    cols.length <= 1 &&
    sqlRes.scalar !== undefined &&
    sqlRes.scalar !== null
  ) {
    return sqlRes.scalar;
  }
  return null;
}

type CompareOp = "eq" | "lte" | "gte" | "gt" | "lt";
type Tolerance = { value: number; unit: "pct" | "abs"; op?: CompareOp };

const VALID_OPS: CompareOp[] = ["eq","lte","gte","gt","lt"];
const isValidOp = (o: any): o is CompareOp => VALID_OPS.includes(o);

function normalizeTolerances(raw: any): Record<string, Tolerance> {
  const out: Record<string, Tolerance> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "number") {
      out[k] = { value: v, unit: "pct", op: "eq" };
    } else if (v && typeof v === "object" && "value" in (v as any)) {
      const o = v as any;
      const value = Number(o.value);
      const op: CompareOp = isValidOp(o.op) ? o.op : "eq";
      out[k] = { value: Number.isFinite(value) ? value : 0, unit: o.unit === "abs" ? "abs" : "pct", op };
    }
  }
  return out;
}

function getGlobalOp(tolerances: Record<string, Tolerance>): CompareOp {
  for (const v of Object.values(tolerances || {})) {
    if (v && isValidOp(v.op as any)) return v.op as CompareOp;
  }
  return "eq";
}

function getTol(tolerances: Record<string, Tolerance>, k: string): Tolerance {
  const norm = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const direct = tolerances[k];
  const hit = direct ? k : Object.keys(tolerances || {}).find((key) => norm(key) === norm(k));
  const base = (hit ? tolerances[hit] : undefined) ?? { value: 0, unit: "pct" as const, op: "eq" as const };
  return { value: base.value, unit: base.unit ?? "pct", op: isValidOp(base.op) ? base.op : "eq" };
}

function canonicalizeForCompare(v: any): any {
  if (v == null) return v;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = toNum(v);
    return Number.isFinite(n) && /[\d]/.test(v) && !/[a-z]/i.test(v.replace(/[,\s%$().-]/g, "")) ? n : v.trim();
  }
  if (Array.isArray(v)) return v.map(canonicalizeForCompare);
  if (typeof v === "object") {
    const out: Record<string, any> = {};
    for (const [k, val] of Object.entries(v)) {
      if (isKpiNoiseKey(k)) continue;
      out[k] = canonicalizeForCompare(val);
    }
    return out;
  }
  return v;
}

/**
 * Cell-wise detail for a grid/graph row, or null when the pair is not tabular.
 * Used to show WHICH cells broke instead of a bare "≠".
 */
function tableDiffFor(actual: any, expected: any, tol: Tolerance) {
  if (actual == null || expected == null) return null;
  const ta = toTableModel(actual);
  const tb = toTableModel(expected);
  if (!ta || !tb) return null;
  return compareTables(ta as any, tb as any, tol, { skipChangeRows: true });
}

const DATE_VALUE_RE = new RegExp(
  [
    String.raw`\d{1,2}\s*[\/.\-]\s*\d{1,2}\s*[\/.\-]\s*\d{2,4}`,
    String.raw`[A-Za-z]{3,9}\.?\s+\d{1,2}\s*[-,]?\s*\d{2,4}`,
    String.raw`\d{1,2}\s+[A-Za-z]{3,9}\.?\s*[-,]?\s*\d{2,4}`,
    String.raw`\d{4}-\d{2}-\d{2}`,
  ].join("|"),
  "i",
);

function looksLikeDateValue(v: any): boolean {
  return typeof v === "string" && !!v.trim() && DATE_VALUE_RE.test(v.trim());
}

function normalizeDateText(v: any): string {
  return String(v ?? "").replace(/\s+/g, " ").replace(/\s*[-,]\s*/g, " ").trim().toLowerCase();
}

const MONTH_INDEX: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

function utcDateValue(year: number, month: number, day: number): number | null {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  const ts = Date.UTC(year, month, day);
  const d = new Date(ts);
  return d.getUTCFullYear() === year && d.getUTCMonth() === month && d.getUTCDate() === day ? ts : null;
}

function parseDateValue(v: any): number | null {
  if (!looksLikeDateValue(v)) return null;
  const raw = String(v ?? "").trim();
  const yearFirst = raw.match(/^(\d{4})\s*-\s*(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (yearFirst) return utcDateValue(Number(yearFirst[1]), Number(yearFirst[2]) - 1, Number(yearFirst[3]));

  const numeric = raw.match(/^(\d{1,2})\s*[\/.\-]\s*(\d{1,2})\s*[\/.\-]\s*(\d{2,4})$/);
  if (numeric) return utcDateValue(Number(numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3]), Number(numeric[1]) - 1, Number(numeric[2]));

  const monthFirst = raw.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})\s*[-,]?\s*(\d{2,4})$/);
  if (monthFirst) return utcDateValue(Number(monthFirst[3].length === 2 ? `20${monthFirst[3]}` : monthFirst[3]), MONTH_INDEX[monthFirst[1].toLowerCase()], Number(monthFirst[2]));

  const dayFirst = raw.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s*[-,]?\s*(\d{2,4})$/);
  if (dayFirst) return utcDateValue(Number(dayFirst[3].length === 2 ? `20${dayFirst[3]}` : dayFirst[3]), MONTH_INDEX[dayFirst[2].toLowerCase()], Number(dayFirst[1]));
  return null;
}

function evalDatePass(actual: any, expected: any, tol: Tolerance): boolean | null {
  const a = parseDateValue(actual);
  const e = parseDateValue(expected);
  if (a == null || e == null) return normalizeDateText(actual) === normalizeDateText(expected);
  const op: CompareOp = tol?.op ?? "eq";
  const dayMs = 24 * 60 * 60 * 1000;
  const allowance = Number.isFinite(tol?.value) && tol?.unit === "abs" ? Math.abs(tol.value) * dayMs : 0;
  if (op === "lte") return a <= e + allowance;
  if (op === "gte") return a >= e - allowance;
  if (op === "gt") return a > e + allowance;
  if (op === "lt") return a < e - allowance;
  return Math.abs(a - e) <= allowance;
}

function compareSymbol(op?: string) {
  if (op === "lte") return "≤";
  if (op === "gte") return "≥";
  if (op === "gt") return ">";
  if (op === "lt") return "<";
  return "=";
}

function evalPass(actual: any, expected: any, tol: Tolerance): boolean | null {
  if (expected === null || expected === undefined || actual === null || actual === undefined) return null;
  if (looksLikeLocatorJunk(actual) || looksLikeLocatorJunk(expected)) return null;
  const tableA = toTableModel(actual);
  const tableB = toTableModel(expected);
  if (tableA && tableB) {
    // Grid / graph Show Data: compare cell by cell so the configured comparator
    // and tolerance apply, instead of JSON.stringify equality which ignored both
    // and failed the whole visual on any single differing cell.
    // Change/delta rows (NBRx Change, TRx Change, ...) are skipped -- an
    // inequality comparator is meaningless for a period-over-period delta.
    return compareTables(tableA, tableB, tol, { skipChangeRows: true }).pass;
  }
  if (Array.isArray(actual) || Array.isArray(expected) ||
      (typeof actual === "object") || (typeof expected === "object")) {
    return JSON.stringify(canonicalizeForCompare(actual)) === JSON.stringify(canonicalizeForCompare(expected));
  }
  if (looksLikeDateValue(actual) || looksLikeDateValue(expected)) {
    return evalDatePass(actual, expected, tol);
  }
  const a = toNum(actual);
  const e = toNum(expected);
  const both = Number.isFinite(a) && Number.isFinite(e);
  const t = Number.isFinite(tol?.value) ? Math.abs(tol.value) : 0;
  const op: CompareOp = tol?.op ?? "eq";
  if (both) {
    const allowance = tol?.unit === "abs" ? t : (e === 0 ? t : Math.abs(e) * t / 100);
    if (op === "lte") return a <= e + allowance;
    if (op === "gte") return a >= e - allowance;
    if (op === "gt") return a > e + allowance;
    if (op === "lt") return a < e - allowance;
    return Math.abs(a - e) <= allowance;
  }
  return String(actual) === String(expected);
}

function TolerancesEditor({
  kpiKeys, tolerances, onChange, saving, showOperator, onReset, canReset, onAddRemove,
}: {
  kpiKeys: string[];
  tolerances: Record<string, Tolerance>;
  onChange: (next: Record<string, Tolerance>) => void;
  saving?: boolean;
  showOperator?: boolean;
  onReset?: () => void;
  canReset?: boolean;
  onAddRemove?: () => void;
}) {
  if (!kpiKeys.length && !onAddRemove) return null;

  const commit = (k: string, rawVal: string, nextUnit?: "pct" | "abs") => {
    const cur = getTol(tolerances, k);
    const v = parseFloat(rawVal);
    const next = {
      ...tolerances,
      [k]: { value: Number.isFinite(v) ? v : 0, unit: nextUnit ?? cur.unit ?? "pct", op: cur.op ?? "eq" },
    };
    onChange(next);
  };

  const setUnitFor = (k: string, val: "pct" | "abs") => {
    const cur = getTol(tolerances, k);
    onChange({ ...tolerances, [k]: { value: cur.value, unit: val, op: cur.op ?? "eq" } });
  };

  const setGlobalOp = (op: CompareOp) => {
    const next: Record<string, Tolerance> = { ...tolerances };
    const keys = new Set<string>([...kpiKeys, ...Object.keys(tolerances || {})]);
    keys.forEach((k) => {
      const cur = tolerances[k] ?? { value: 0, unit: "pct" as const };
      next[k] = { value: cur.value ?? 0, unit: cur.unit ?? "pct", op };
    });
    onChange(next);
  };

  const globalOp = getGlobalOp(tolerances);

  return (
    <div className="border border-border rounded p-2 bg-secondary/20 text-xs">
      <div className="flex items-center justify-between mb-2 gap-2">
        <div className="flex items-center gap-2">
          <div className="text-xs font-semibold uppercase text-muted-foreground">KPI tolerances</div>
          {onReset && (
            <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" disabled={!canReset} onClick={onReset} title="Reset KPI tolerance values and condition to those of the last run">
              <RotateCcw className="h-3 w-3 mr-1" />Reset to last run
            </Button>
          )}
          {onAddRemove && (
            <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={onAddRemove}>
              <Plus className="h-3 w-3 mr-1" />Add/Remove KPIs
            </Button>
          )}
          {saving && <div className="text-xs text-muted-foreground mono">Saving…</div>}
        </div>
        {showOperator && (
          <div className="flex items-center gap-2">
            <div className="text-xs text-muted-foreground">Condition (all KPIs):</div>
            <Select value={globalOp} onValueChange={(v) => setGlobalOp(v as CompareOp)}>
              <SelectTrigger className="h-8 w-[200px] text-xs mono px-2">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="lte" className="text-xs mono">actual ≤ reference</SelectItem>
                <SelectItem value="lt" className="text-xs mono">actual &lt; reference</SelectItem>
                <SelectItem value="eq" className="text-xs mono">actual = reference</SelectItem>
                <SelectItem value="gte" className="text-xs mono">actual ≥ reference</SelectItem>
                <SelectItem value="gt" className="text-xs mono">actual &gt; reference</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
      </div>
      {kpiKeys.length === 0 ? (
        <div className="text-muted-foreground text-[11px] py-1">No KPIs configured yet. Use "Add/Remove KPIs" to define them.</div>
      ) : (
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
        {kpiKeys.map((k) => {
          const cur = getTol(tolerances, k);
          const unit = (cur.unit ?? "pct") as "pct" | "abs";
          return (
            <div key={k} className="flex items-center gap-2">
              <label className="mono text-xs truncate flex-1" title={k}>{k}</label>
              <div className="relative w-28">
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  defaultValue={cur.value}
                  key={`${k}-${unit}-${cur.value}`}
                  onBlur={(e) => commit(k, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commit(k, (e.target as HTMLInputElement).value);
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                  className="h-7 pr-14 text-xs"
                />
                <ToggleGroup
                  type="single"
                  size="sm"
                  value={unit}
                  onValueChange={(v) => v && setUnitFor(k, v as "pct" | "abs")}
                  className="absolute right-1 top-1/2 -translate-y-1/2 gap-0 border border-border rounded-sm overflow-hidden bg-background"
                >
                  <ToggleGroupItem
                    value="pct"
                    className="h-5 w-5 p-0 text-[10px] mono rounded-none data-[state=on]:bg-accent"
                  >
                    %
                  </ToggleGroupItem>
                  <ToggleGroupItem
                    value="abs"
                    className="h-5 w-5 p-0 text-[10px] mono rounded-none data-[state=on]:bg-accent"
                  >
                    #
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>
            </div>
          );
        })}
      </div>
      )}
    </div>
  );
}


function FilterComparisonTable({
  combos, comboResults, runResult, tolerances, onTolerancesChange, savingTolerances,
  isReferenceMatch, isTrendCheck, referenceKpis, refRunResult, globalSqlResult, onResetTolerances, canResetTolerances,
  onRunCombo, runningComboId, comboBlockOverrides, persistedStatus, onLiveOverallChange, scriptKpiLabels,
}: {
  combos: any[];
  comboResults: Record<string, any>;
  runResult: any;
  tolerances: Record<string, Tolerance>;
  onTolerancesChange: (next: Record<string, Tolerance>) => void;
  savingTolerances?: boolean;
  isReferenceMatch?: boolean;
  isTrendCheck?: boolean;
  referenceKpis?: Record<string, any> | null;
  refRunResult?: any;
  globalSqlResult?: any;
  onResetTolerances?: () => void;
  canResetTolerances?: boolean;
  onRunCombo?: (combo: any, idx: number) => void;
  runningComboId?: string | null;
  comboBlockOverrides?: Record<string, any>;
  persistedStatus?: "pass" | "fail" | "pending";
  onLiveOverallChange?: (status: "pass" | "fail" | "pending") => void;
  scriptKpiLabels?: string[];
}) {
  const [openCombo, setOpenCombo] = useState<any>(null);

  const pwRoot = pickResultRoot(runResult);
  const refRoot = pickResultRoot(refRunResult);

  const blockFor = (root: any, label: string, idx: number, comboId?: string) =>
    pickComboBlock(root, label, idx, comboId);

  type Row = {
    combo: any; comboIdx: number; kpi: string; actual: any; expected: any;
    diff: number | null; deltaPct: number | null; pass: boolean | null;
  };

  const normKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const lookupKpi = (obj: any, k: string): any => {
    if (!obj || typeof obj !== "object") return null;
    if (obj[k] !== undefined) return obj[k];
    const target = normKey(k);
    const found = Object.keys(obj).find((rk) => normKey(rk) === target);
    return found ? obj[found] : null;
  };

  const perCombo = combos.map((c, idx) => {
    const label = c.label || `Filter #${idx + 1}`;
    const pwBlock = comboBlockOverrides?.[c.id] ?? blockFor(pwRoot, label, idx, c.id);
    const refBlock = blockFor(refRoot, label, idx, c.id);
    let kpis = extractKpisFromBlock(pwBlock);
    if (!Object.keys(kpis).length) kpis = extractKpisFromRun(runResult) || {};
    let refKpis = refBlock ? extractKpisFromBlock(refBlock) : null;
    if (!refKpis || !Object.keys(refKpis).length) refKpis = extractKpisFromRun(refRunResult);
    const sqlRes = comboResults[c.id] || (globalSqlResult?.ok ? globalSqlResult : null);
    const kpiNames = resultKpiNames(tolerances, scriptKpiLabels, kpis, refKpis);
    const rows: Row[] = kpiNames.map((k) => {
      const v = resolveKpiValue(k, kpis, pwBlock, runResult);
      const exp = isTrendCheck
        ? (k === "Trend check" || k === "consecutive" ? 1 : null)
        : isReferenceMatch
        ? resolveKpiValue(k, refKpis, referenceKpis, refBlock, refRunResult)
        : expectedForKpi(sqlRes, k);
      const a = toNum(v);
      const e = toNum(exp);
      const both = Number.isFinite(a) && Number.isFinite(e);
      const diff = both ? a - e : null;
      const deltaPct = both && e !== 0 ? (diff! / Math.abs(e)) * 100 : null;
      const pass = evalPass(v, exp, getTol(tolerances, k));
      return { combo: c, comboIdx: idx, kpi: k, actual: v, expected: exp, diff, deltaPct, pass };
    });
    if (!rows.length) {
      const sqlRow = sqlRes?.ok ? (sqlRes.rows?.[0] || null) : null;
      const sqlCols: string[] = sqlRes?.ok ? (sqlRes.columns || (sqlRow ? Object.keys(sqlRow) : [])) : [];
      if (sqlRow && sqlCols.length) {
        for (const col of sqlCols) {
          rows.push({
            combo: c, comboIdx: idx, kpi: col,
            actual: undefined, expected: sqlRow[col],
            diff: null, deltaPct: null, pass: null,
          });
        }
      } else {
        rows.push({
          combo: c, comboIdx: idx, kpi: "—",
          actual: pwBlock ? null : undefined,
          expected: isReferenceMatch ? null : (sqlRes?.ok ? (sqlRes.scalar ?? null) : null),
          diff: null, deltaPct: null, pass: null,
        });
      }
    }
    const trend = isTrendCheck
      ? pickTrendPayload(pwBlock, kpis, refKpis, runResult, refRunResult)
      : null;
    const trendPass = trend
      ? ((trend.consecutive === true || trend.score === 1) && !(trend.missing || []).length && !trend.trend_error)
      : null;
    const overall = isTrendCheck
      ? (trendPass === true ? "pass" : trendPass === false || trend?.trend_error ? "fail" : "pending")
      : overallFromPassResults(rows.map((r) => r.pass));
    return { combo: c, idx, label, rows, overall, trend };
  });


  const computedOverall: "pass" | "fail" | "pending" =
    perCombo.some((p) => p.overall === "fail") ? "fail"
    : perCombo.some((p) => p.overall === "pending") ? "pending"
    : perCombo.every((p) => p.overall === "pass") ? "pass"
    : "pending";
  const overallStatus = computedOverall;

  useEffect(() => {
    onLiveOverallChange?.(computedOverall);
  }, [computedOverall, onLiveOverallChange]);

  const badge = (s: "pass" | "fail" | "pending") => {
    const cls = s === "pass"
      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
      : s === "fail"
      ? "bg-destructive/15 text-destructive border-destructive/30"
      : "bg-secondary text-muted-foreground border-border";
    return <span className={`mono uppercase text-[10px] px-1.5 py-0.5 rounded border ${cls}`}>{s}</span>;
  };

  

  if (isTrendCheck) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Overall Status:</span>
          {badge(overallStatus)}
          <span className="text-muted-foreground">consecutive week / month / quarter periods</span>
        </div>
        {perCombo.map(({ combo, label, trend }) => (
          <TrendCheckPanel key={combo.id || label} payload={trend} filterLabel={label} />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">Overall Status:</span>
        {badge(overallStatus)}
      </div>
      <div className="border border-border rounded overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-secondary/40 text-muted-foreground">
            <tr>
              <th className="text-left p-2">Filter</th>
              <th className="text-left p-2">KPI</th>
              <th className="text-left p-2">Actual (UI main report)</th>
              <th className="text-left p-2">{isReferenceMatch ? "Reference URL" : "Expected (BE / SQL)"}</th>
              <th className="text-left p-2">Diff</th>
              <th className="text-left p-2">Result</th>
              <th className="text-left p-2">Overall Result</th>
            </tr>
          </thead>
          <tbody>
            {perCombo.flatMap(({ combo, idx, label, rows, overall }) =>
              rows.map((r, i) => (
                <tr key={`${combo.id}-${i}`} className={`border-t border-border ${r.pass === false ? "bg-destructive/5" : ""}`}>
                  {i === 0 && (
                    <td className="p-2 align-top" rowSpan={rows.length}>
                      <div className="space-y-1.5">
                        <button className="text-accent hover:underline font-semibold text-left block" onClick={() => setOpenCombo(combo)}>
                          {label}
                        </button>
                        {onRunCombo && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-[10px]"
                            disabled={!!runningComboId}
                            onClick={() => onRunCombo(combo, idx)}
                            title="Re-run the script for this filter combination only"
                          >
                            <Play className="h-3 w-3 mr-1" />
                            {runningComboId === combo.id ? "Running…" : "Run"}
                          </Button>
                        )}
                      </div>
                    </td>
                  )}
                  <td className="p-2 mono align-top">{r.kpi}</td>
                  {isStructuredKpiValue(r.actual) || isStructuredKpiValue(r.expected) ? (
                    <td className="p-2 align-top" colSpan={2}>
                      <GridComparePanels
                        actual={r.actual}
                        expected={r.expected}
                        leftLabel="Actual (UI main report)"
                        rightLabel={isReferenceMatch ? "Reference URL" : "Expected (BE / SQL)"}
                      />
                    </td>
                  ) : (
                    <>
                      <td className="p-2 align-top"><KpiValue value={r.actual} /></td>
                      <td className="p-2 align-top"><KpiValue value={r.expected} /></td>
                    </>
                  )}
                  <td className="p-2 mono">
                    {r.diff !== null ? (
                      <span className={r.pass === false ? "text-destructive" : "text-muted-foreground"}>
                        {r.diff > 0 ? "+" : ""}{fmt(r.diff)}
                        {r.deltaPct !== null && (
                          <span className="text-muted-foreground ml-1">({r.deltaPct > 0 ? "+" : ""}{r.deltaPct.toFixed(2)}%)</span>
                        )}
                      </span>
                    ) : (() => {
                      // Grid / graph: name the offending cells instead of a bare "≠".
                      const tc = tableDiffFor(r.actual, r.expected, getTol(tolerances, r.kpi));
                      if (!tc) {
                        return <span className="text-muted-foreground">{r.pass === false ? "≠" : r.pass === true ? compareSymbol(getTol(tolerances, r.kpi).op) : "—"}</span>;
                      }
                      return (
                        <div className="space-y-0.5">
                          <div className="text-[10px] text-muted-foreground">{summarizeTableCompare(tc)}</div>
                          {tc.failedCells.slice(0, 5).map((c, ci) => (
                            <div key={ci} className="text-[10px] text-destructive whitespace-nowrap">
                              {c.row} / {c.column}: {fmt(c.actual)} vs {fmt(c.expected)}
                              {c.deltaPct !== null && ` (${c.deltaPct > 0 ? "+" : ""}${c.deltaPct.toFixed(1)}%)`}
                            </div>
                          ))}
                          {tc.failedCells.length > 5 && (
                            <div className="text-[10px] text-muted-foreground">+{tc.failedCells.length - 5} more</div>
                          )}
                        </div>
                      );
                    })()}
                  </td>
                  <td className="p-2">{r.pass === null ? badge("pending") : r.pass ? badge("pass") : badge("fail")}</td>
                  {i === 0 && (
                    <td className="p-2 align-top" rowSpan={rows.length}>{badge(overall)}</td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      

      <Dialog open={!!openCombo} onOpenChange={(o) => !o && setOpenCombo(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {openCombo?.label || `Filter #${(combos.findIndex((c) => c.id === openCombo?.id)) + 1}`}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-xs">
            {openCombo && Object.entries(openCombo.filters || {}).map(([k, v]) => (
              <div key={k} className="flex items-start gap-2 border-b border-border pb-1">
                <div className="font-semibold w-40 mono">{k}</div>
                <div className="mono text-muted-foreground flex-1">{String(v)}</div>
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

function KpiRowsTable({
  actual, sqlRes, fallbackExpected, tolerances, onTolerancesChange, savingTolerances, isReferenceMatch, isTrendCheck, onResetTolerances, canResetTolerances, persistedStatus, onLiveOverallChange, scriptKpiLabels,
}: {
  actual: any;
  sqlRes: any;
  fallbackExpected: any;
  tolerances: Record<string, Tolerance>;
  onTolerancesChange: (next: Record<string, Tolerance>) => void;
  savingTolerances?: boolean;
  isReferenceMatch?: boolean;
  isTrendCheck?: boolean;
  onResetTolerances?: () => void;
  canResetTolerances?: boolean;
  persistedStatus?: "pass" | "fail" | "pending";
  onLiveOverallChange?: (status: "pass" | "fail" | "pending") => void;
  scriptKpiLabels?: string[];
}) {
  const badge = (s: "pass" | "fail" | "pending") => {
    const cls = s === "pass"
      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
      : s === "fail"
      ? "bg-destructive/15 text-destructive border-destructive/30"
      : "bg-secondary text-muted-foreground border-border";
    return <span className={`mono uppercase text-[10px] px-1.5 py-0.5 rounded border ${cls}`}>{s}</span>;
  };

  const kpis = actual && typeof actual === "object" ? actual : {};
  const trend = isTrendCheck ? pickTrendPayload(kpis, fallbackExpected, actual) : null;
  const keys = resultKpiNames(tolerances, scriptKpiLabels, kpis, fallbackExpected);

  const rows = keys.map((k) => {
    const a = resolveKpiValue(k, kpis);
    let exp: any = null;
    if (sqlRes?.ok) exp = expectedForKpi(sqlRes, k);
    if ((exp === null || exp === undefined) && fallbackExpected && typeof fallbackExpected === "object") {
      exp = resolveKpiValue(k, fallbackExpected) ?? null;
    }
    const aN = toNum(a);
    const eN = toNum(exp);
    const both = Number.isFinite(aN) && Number.isFinite(eN);
    const diff = both ? aN - eN : null;
    const deltaPct = both && eN !== 0 ? (diff! / Math.abs(eN)) * 100 : null;
    const pass = evalPass(a, exp, getTol(tolerances, k));
    return { k, a, exp, diff, deltaPct, pass };
  });

  const trendPass = trend
    ? ((trend.consecutive === true || trend.score === 1) && !(trend.missing || []).length && !trend.trend_error)
    : null;
  const computedOverall = isTrendCheck
    ? (trendPass === true ? "pass" : trend ? "fail" : "pending")
    : overallFromPassResults(rows.map((r) => r.pass));
  const overall = computedOverall;

  useEffect(() => {
    onLiveOverallChange?.(computedOverall);
  }, [computedOverall, onLiveOverallChange]);

  if (isTrendCheck) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Overall Status:</span>
          {badge(overall)}
        </div>
        <TrendCheckPanel payload={trend} />
      </div>
    );
  }

  if (!keys.length) {
    return <div className="text-muted-foreground text-xs">No KPI values extracted yet.</div>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">Overall Status:</span>
        {badge(overall)}
      </div>
      <div className="border border-border rounded overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-secondary/40 text-muted-foreground">
            <tr>
              <th className="text-left p-2">KPI</th>
              <th className="text-left p-2">Actual (UI main report)</th>
              <th className="text-left p-2">{isTrendCheck ? "Required" : isReferenceMatch ? "Reference URL" : "Expected (BE / SQL)"}</th>
              <th className="text-left p-2">Diff</th>
              <th className="text-left p-2">Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.k} className={`border-t border-border ${r.pass === false ? "bg-destructive/5" : ""}`}>
                <td className="p-2 mono align-top">{r.k}</td>
                <td className="p-2 align-top"><KpiValue value={r.a} /></td>
                <td className="p-2 align-top"><KpiValue value={r.exp} /></td>
                <td className="p-2 mono">
                  {r.diff !== null ? (
                    <span className={r.pass === false ? "text-destructive" : "text-muted-foreground"}>
                      {r.diff > 0 ? "+" : ""}{fmt(r.diff)}
                      {r.deltaPct !== null && (
                        <span className="text-muted-foreground ml-1">({r.deltaPct > 0 ? "+" : ""}{r.deltaPct.toFixed(2)}%)</span>
                      )}
                    </span>
                  ) : (() => {
                    // Grid / graph: name the offending cells instead of a bare "≠".
                    const tc = tableDiffFor(r.a, r.exp, getTol(tolerances, r.k));
                    if (!tc) {
                      return <span className="text-muted-foreground">{r.pass === false ? "≠" : r.pass === true ? compareSymbol(getTol(tolerances, r.k).op) : "—"}</span>;
                    }
                    return (
                      <div className="space-y-0.5">
                        <div className="text-[10px] text-muted-foreground">{summarizeTableCompare(tc)}</div>
                        {tc.failedCells.slice(0, 5).map((c, ci) => (
                          <div key={ci} className="text-[10px] text-destructive whitespace-nowrap">
                            {c.row} / {c.column}: {fmt(c.actual)} vs {fmt(c.expected)}
                            {c.deltaPct !== null && ` (${c.deltaPct > 0 ? "+" : ""}${c.deltaPct.toFixed(1)}%)`}
                          </div>
                        ))}
                        {tc.failedCells.length > 5 && (
                          <div className="text-[10px] text-muted-foreground">+{tc.failedCells.length - 5} more</div>
                        )}
                      </div>
                    );
                  })()}
                </td>
                <td className="p-2">{r.pass === null ? badge("pending") : r.pass ? badge("pass") : badge("fail")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      
    </div>
  );
}




function ScenarioMeta({ s }: { s: any }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [duping, setDuping] = useState(false);
  const update = async (patch: any) => {
    await supabase.from("scenarios").update(patch).eq("id", s.id);
    qc.invalidateQueries({ queryKey: ["scenario", s.id] });
  };
  const dup = async () => {
    setDuping(true);
    try {
      const copy = await duplicateScenario(s.id);
      toast.success(`Duplicated as "${copy.title}"`);
      qc.invalidateQueries({ queryKey: ["scenarios", s.report_id] });
      navigate(`/scenarios/${copy.id}`);
    } catch (e: any) {
      toast.error(e?.message || "Duplicate failed");
    } finally {
      setDuping(false);
    }
  };
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex-1 space-y-2 min-w-0">
        <Input className="text-xl font-semibold" defaultValue={s.title} onBlur={(e) => update({ title: e.target.value })} />
        <Textarea className="text-sm min-h-[120px]" defaultValue={s.description || ""} onBlur={(e) => update({ description: e.target.value })} placeholder="Description…" />
      </div>
      <div className="space-y-2 w-44">
        <div>
          <div className="text-[10px] text-muted-foreground mb-1 uppercase">Type</div>
          <Select value={s.type} onValueChange={(v) => update({ type: v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{[
              {v:"warehouse_match",l:"Warehouse"},
              {v:"reference_match",l:"Reference"},
              {v:"trend",l:"Trend"},
              {v:"range_check",l:"Range"},
              {v:"functional",l:"Functional"},
            ].map((t) => <SelectItem key={t.v} value={t.v}>{t.l}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground mb-1 uppercase">Criticality</div>
          <Select defaultValue={s.criticality} onValueChange={(v) => update({ criticality: v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{["low","medium","high","critical"].map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <Button variant="outline" size="sm" className="w-full" onClick={() => update({ deferred: !s.deferred })}>
          {s.deferred ? "Restore" : "Defer"}
        </Button>
        <Button variant="outline" size="sm" className="w-full" onClick={dup} disabled={duping} title="Duplicate this test case including its saved script, filter combinations, KPI settings, and SQL binding. FE ↔ BE mappings stay on this screen.">
          {duping ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Copy className="h-3 w-3 mr-1" />}
          Duplicate
        </Button>
        <ScenarioHistory scenarioId={s.id} onRestore={(v) => update({ title: v.title, description: v.description, criticality: v.criticality, type: v.type, status: v.status, deferred: v.deferred })} />
      </div>
    </div>
  );
}

function ScenarioHistory({ scenarioId, onRestore }: { scenarioId: string; onRestore: (v: any) => void }) {
  const [open, setOpen] = useState(false);
  const { data: versions } = useQuery({
    queryKey: ["scenario-versions", scenarioId, open],
    queryFn: async () => (await supabase.from("scenario_versions").select("*").eq("scenario_id", scenarioId).order("version", { ascending: false })).data ?? [],
    enabled: open,
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="w-full"><History className="h-3 w-3 mr-1" /> History</Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>Scenario version history</DialogTitle></DialogHeader>
        <ScrollArea className="max-h-[60vh]">
          <div className="space-y-2">
            {(versions || []).map((v: any) => (
              <div key={v.id} className="border border-border rounded p-3 text-xs space-y-1">
                <div className="flex items-center justify-between">
                  <div className="font-semibold">v{v.version} <span className="text-muted-foreground font-normal">· {new Date(v.created_at).toLocaleString()}</span></div>
                  <Button size="sm" variant="ghost" onClick={() => { onRestore(v); setOpen(false); toast.success(`Restored v${v.version}`); }}>Restore</Button>
                </div>
                <div className="font-medium">{v.title}</div>
                {v.description && <div className="text-muted-foreground line-clamp-2">{v.description}</div>}
                <div className="text-[10px] text-muted-foreground">criticality: {v.criticality} · status: {v.status} · deferred: {String(v.deferred)}</div>
              </div>
            ))}
            {!versions?.length && <div className="text-xs text-muted-foreground p-4 text-center">No history yet.</div>}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

function scriptVersionCode(v: any, kind: "main" | "reference") {
  if (kind === "reference") return v?.assertion_spec?.__reference_playwright_code || "";
  return v?.playwright_code || "";
}

function ScriptHistory({
  scenarioId,
  scriptId,
  kind = "main",
  onRestore,
}: {
  scenarioId: string;
  scriptId?: string;
  kind?: "main" | "reference";
  onRestore: (v: any) => void;
}) {
  const [open, setOpen] = useState(false);
  const { data: versions } = useQuery({
    queryKey: ["script-versions", scenarioId, scriptId, kind, open],
    queryFn: async () => {
      const q = supabase.from("script_versions").select("*").eq("scenario_id", scenarioId);
      const filtered = scriptId ? q.eq("script_id", scriptId) : q;
      return (await filtered.order("version", { ascending: false })).data ?? [];
    },
    enabled: open,
  });
  const title = kind === "reference" ? "Reference script version history" : "Test script version history";
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline"><History className="h-3 w-3 mr-1" /> History</Button>
      </DialogTrigger>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-3xl min-w-0 overflow-x-hidden">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">Load a version into the editor to review it, then click Save to persist.</p>
        <div className="max-h-[65vh] min-w-0 space-y-3 overflow-x-hidden overflow-y-auto pr-1">
          {(versions || []).map((v: any) => {
            const preview = scriptVersionCode(v, kind);
            return (
              <div key={v.id} className="min-w-0 max-w-full space-y-2 rounded border border-border p-3 text-xs">
                <div className="flex min-w-0 flex-nowrap items-center justify-between gap-3">
                  <div className="min-w-0 truncate font-semibold">
                    v{v.version}{" "}
                    <span className="font-normal text-muted-foreground">· {new Date(v.created_at).toLocaleString()}</span>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    className="h-8 shrink-0 px-3 text-xs"
                    onClick={() => { onRestore(v); setOpen(false); }}
                  >
                    <Undo2 className="h-3.5 w-3.5" />
                    Use this version
                  </Button>
                </div>
                <div className="min-w-0 max-w-full overflow-x-auto rounded bg-secondary/40">
                  <pre className="mono max-h-40 overflow-y-auto p-2 text-[10px] whitespace-pre">
                    {preview || (kind === "reference" ? "(no reference script in this version)" : "(empty)")}
                  </pre>
                </div>
              </div>
            );
          })}
          {!versions?.length && <div className="p-4 text-center text-xs text-muted-foreground">No history yet — save the script to create a version.</div>}
        </div>
      </DialogContent>
    </Dialog>
  );
}


function NewSqlTemplateInline({ reportId, onCreated, open: openProp, onOpenChange }: { reportId?: string; onCreated: (id: string) => void; open?: boolean; onOpenChange?: (o: boolean) => void }) {
  const [openInner, setOpenInner] = useState(false);
  const open = openProp ?? openInner;
  const setOpen = (o: boolean) => { onOpenChange ? onOpenChange(o) : setOpenInner(o); };
  const [name, setName] = useState("");
  const [sql, setSql] = useState("");
  const [scope, setScope] = useState<"project" | "report">("report");
  const save = async () => {
    if (!name || !sql) return toast.error("Name and SQL required");
    const { data, error } = await supabase.from("sql_templates").insert({
      name, sql_text: sql, scope, report_id: scope === "report" ? reportId : null,
    }).select().single();
    if (error) return toast.error(error.message);
    toast.success("Template created");
    setName(""); setSql(""); setOpen(false);
    if (data?.id) onCreated(data.id);
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader><DialogTitle>New SQL template</DialogTitle></DialogHeader>
        <div className="space-y-2">
          <Input placeholder="kpi_total_sales" value={name} onChange={(e) => setName(e.target.value)} />
          <Select value={scope} onValueChange={(v: any) => setScope(v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="report">This report</SelectItem>
              <SelectItem value="project">Project (global)</SelectItem>
            </SelectContent>
          </Select>
          <Textarea className="mono text-xs min-h-[160px]" placeholder="SELECT ..." value={sql} onChange={(e) => setSql(e.target.value)} />
          <Button onClick={save} className="w-full">Create & bind</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

type FilterPair = { label: string; value: string };
type FilterCombo = { id: string; label: string | null; filters: Record<string, string> };
type KeyMap = { id: string; fe_label: string; be_column: string };

function FilterCombinations({ scenarioId, reportId }: { scenarioId: string; reportId?: string }) {
  const qc = useQueryClient();
  const { data: combos } = useQuery({
    queryKey: ["scenario-filter-matrix", scenarioId],
    queryFn: async () =>
      ((await supabase
        .from("scenario_filter_matrix")
        .select("id,label,filters")
        .eq("scenario_id", scenarioId)
        .order("created_at", { ascending: true })).data ?? []) as FilterCombo[],
  });

  const { data: keyMap } = useQuery({
    queryKey: ["report-filter-key-map", reportId],
    enabled: !!reportId,
    queryFn: async () =>
      ((await supabase
        .from("scenario_filter_key_map")
        .select("id,fe_label,be_column")
        .eq("report_id", reportId!)
        .order("created_at", { ascending: true })).data ?? []) as KeyMap[],
  });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [pairs, setPairs] = useState<FilterPair[]>([{ label: "", value: "" }]);
  const [mapOpen, setMapOpen] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  // "Apply this combination to every case in ..." — combo pending confirmation.
  const [applyCombo, setApplyCombo] = useState<FilterCombo | null>(null);
  const [applyScope, setApplyScope] = useState<ApplyScope>("report");
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyAllBusy, setApplyAllBusy] = useState(false);

  const runApplyCombo = async () => {
    if (!applyCombo || !reportId) return;
    setApplyBusy(true);
    try {
      const res = await applyFilterComboToScope({
        reportId,
        scope: applyScope,
        label: applyCombo.label,
        filters: applyCombo.filters || {},
        excludeScenarioId: scenarioId,
      });
      if (!res.targets) {
        toast.info("No other test cases found in this " + applyScope);
      } else if (!res.inserted) {
        toast.info(`All ${res.targets} other case(s) already have this combination`);
      } else {
        toast.success(
          `Added to ${res.inserted} case(s)` + (res.skipped ? ` — ${res.skipped} already had it` : ""),
        );
      }
      qc.invalidateQueries({ queryKey: ["scenario-filter-matrix"] });
      setApplyCombo(null);
    } catch (e: any) {
      toast.error(e?.message || "Could not apply the combination");
    } finally {
      setApplyBusy(false);
    }
  };

  const runApplyAllCombos = async () => {
    if (!reportId || !combos?.length) return;
    setApplyAllBusy(true);
    try {
      const res = await applyAllFilterCombosToScope({
        reportId,
        scope: "report",
        sourceScenarioId: scenarioId,
        combos: combos.map((c) => ({ label: c.label, filters: c.filters || {} })),
      });
      if (!res.targets) toast.info("No other test cases found in this report");
      else if (!res.inserted) toast.info(`All ${res.targets} other case(s) already have these combinations`);
      else toast.success(`Applied ${combos.length} combination(s) across ${res.targets} case(s); ${res.inserted} row(s) added`);
      qc.invalidateQueries({ queryKey: ["scenario-filter-matrix"] });
    } catch (e: any) {
      toast.error(e?.message || "Could not apply all combinations");
    } finally {
      setApplyAllBusy(false);
    }
  };

  const reset = () => {
    setEditingId(null);
    setLabel("");
    setPairs([{ label: "", value: "" }]);
  };

  const openNew = () => {
    reset();
    setDialogOpen(true);
  };

  const openEdit = (c: FilterCombo) => {
    setEditingId(c.id);
    setLabel(c.label ?? "");
    const entries = Object.entries(c.filters || {});
    setPairs(entries.length ? entries.map(([k, v]) => ({ label: k, value: String(v) })) : [{ label: "", value: "" }]);
    setDialogOpen(true);
  };

  const addPair = () => setPairs((p) => [...p, { label: "", value: "" }]);
  const updPair = (i: number, key: keyof FilterPair, v: string) =>
    setPairs((p) => p.map((x, idx) => (idx === i ? { ...x, [key]: v } : x)));
  const rmPair = (i: number) => setPairs((p) => p.filter((_, idx) => idx !== i));

  const saveCombo = async () => {
    const filters: Record<string, string> = {};
    for (const p of pairs) {
      const k = p.label.trim();
      const v = p.value.trim();
      if (!k) continue;
      filters[k] = v;
    }
    if (!Object.keys(filters).length) {
      toast.error("Add at least one filter label and value");
      return;
    }
    const canon = canonFilters(filters);
    const dupe = (combos ?? []).find((c) => c.id !== editingId && canonFilters(c.filters || {}) === canon);
    if (dupe) {
      toast.error("This exact filter combination already exists");
      return;
    }
    if (editingId) {
      const { error } = await supabase
        .from("scenario_filter_matrix")
        .update({ label: label.trim() || null, filters })
        .eq("id", editingId);
      if (error) return toast.error(error.message);
      toast.success("Filter combination updated");
    } else {
      const { error } = await supabase.from("scenario_filter_matrix").insert({
        scenario_id: scenarioId,
        label: label.trim() || null,
        filters,
      });
      if (error) return toast.error(error.message);
      toast.success("Filter combination added");
    }
    reset();
    setDialogOpen(false);
    qc.invalidateQueries({ queryKey: ["scenario-filter-matrix", scenarioId] });
  };

  const deleteCombo = async (cid: string) => {
    const { error } = await supabase.from("scenario_filter_matrix").delete().eq("id", cid);
    if (error) return toast.error(error.message);
    toast.success("Removed");
    qc.invalidateQueries({ queryKey: ["scenario-filter-matrix", scenarioId] });
  };

  const feLabels = (keyMap ?? []).map((k) => k.fe_label);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-sm">Filter combinations</CardTitle>
            <div className="text-xs text-muted-foreground">
              Shared across all scenarios in this screen. The Playwright script runs once per combination. You can also re-run one combination from Latest result.
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={() => setMapOpen(true)}>
            FE ↔ BE key mapping
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!!combos?.length && (
          <div className="space-y-2">
            {combos.map((c) => (
              <div key={c.id} className="flex items-start gap-2 border border-border rounded-md p-2">
                <div className="flex-1 min-w-0 space-y-1">
                  {c.label && <div className="text-xs font-medium">{c.label}</div>}
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs mono">
                    {Object.entries(c.filters || {}).map(([k, v]) => (
                      <span key={k}>
                        <span className="text-muted-foreground">{k}:</span> {String(v)}
                      </span>
                    ))}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setApplyCombo(c)}
                  disabled={!reportId}
                  aria-label="Apply this combination to other cases"
                  title={reportId ? "Apply this filter combination to every case in the report or workstream" : "Report not loaded"}
                >
                  <Copy className="h-3 w-3 mr-1" /> Apply
                </Button>
                <Button size="sm" variant="ghost" onClick={() => openEdit(c)} aria-label="Edit combination">
                  <Pencil className="h-3 w-3" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => deleteCombo(c.id)} aria-label="Delete combination">
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-2 flex-wrap">
          <Button size="sm" variant="outline" onClick={openNew}>
            <Plus className="h-3 w-3 mr-1" /> New filter combination
          </Button>
          <Button size="sm" variant="outline" onClick={() => setPasteOpen(true)}>
            Paste rows
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!reportId || !combos?.length || applyAllBusy}
            onClick={() => void runApplyAllCombos()}
            title="Copy every filter combination above to every other case in this report"
          >
            <Copy className="h-3 w-3 mr-1" />
            {applyAllBusy ? "Applying…" : "Apply all to report cases"}
          </Button>
        </div>

        {/* Apply one combination to every test case in the report / workstream */}
        <Dialog open={!!applyCombo} onOpenChange={(o) => { if (!o && !applyBusy) setApplyCombo(null); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Apply this filter combination to other cases</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              {applyCombo && (
                <div className="rounded-md border border-border p-2 text-xs mono flex flex-wrap gap-x-4 gap-y-1">
                  {Object.entries(applyCombo.filters || {}).map(([k, v]) => (
                    <span key={k}>
                      <span className="text-muted-foreground">{k}:</span> {String(v)}
                    </span>
                  ))}
                </div>
              )}
              <div className="space-y-2">
                <div className="text-xs text-muted-foreground">Apply to every test case in:</div>
                <Select value={applyScope} onValueChange={(v) => setApplyScope(v as ApplyScope)}>
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="report">This report</SelectItem>
                    <SelectItem value="workstream">This workstream (all reports)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="text-xs text-muted-foreground">
                Cases that already have this exact combination are skipped, so it is safe to run twice.
                Existing combinations are never removed.
              </div>
            </div>
            <DialogFooter>
              <Button size="sm" variant="outline" disabled={applyBusy} onClick={() => setApplyCombo(null)}>
                Cancel
              </Button>
              <Button size="sm" disabled={applyBusy} onClick={() => void runApplyCombo()}>
                {applyBusy ? "Applying…" : "Apply"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog
          open={dialogOpen}
          onOpenChange={(o) => {
            setDialogOpen(o);
            if (!o) reset();
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editingId ? "Edit filter combination" : "New filter combination"}</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <Input
                placeholder="Combination label (optional, e.g. AB / St. Louis / YTD)"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                className="h-9 text-sm"
              />
              {feLabels.length === 0 && (
                <div className="text-xs text-muted-foreground">
                  No FE labels defined yet. Add them in{" "}
                  <button type="button" className="underline" onClick={() => setMapOpen(true)}>
                    FE ↔ BE key mapping
                  </button>{" "}
                  to populate the Filter label dropdown.
                </div>
              )}
              <div className="space-y-2">
                {pairs.map((p, i) => (
                  <div key={i} className="flex gap-2">
                    {feLabels.length > 0 ? (
                      <Select value={p.label || undefined} onValueChange={(v) => updPair(i, "label", v)}>
                        <SelectTrigger className="h-9 text-sm flex-1">
                          <SelectValue placeholder="Filter label" />
                        </SelectTrigger>
                        <SelectContent>
                          {feLabels.map((lbl) => (
                            <SelectItem key={lbl} value={lbl}>{lbl}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        placeholder="Filter label (e.g. Area)"
                        value={p.label}
                        onChange={(e) => updPair(i, "label", e.target.value)}
                        className="h-9 text-sm flex-1"
                      />
                    )}
                    <Input
                      placeholder="Filter value (e.g. AB - Central)"
                      value={p.value}
                      onChange={(e) => updPair(i, "value", e.target.value)}
                      className="h-9 text-sm flex-1"
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => rmPair(i)}
                      disabled={pairs.length === 1}
                      aria-label="Remove pair"
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>
              <div className="flex justify-between gap-2">
                <Button size="sm" variant="outline" onClick={addPair}>
                  <Plus className="h-3 w-3 mr-1" /> Add filter
                </Button>
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => { setDialogOpen(false); reset(); }}>
                    Cancel
                  </Button>
                  <Button size="sm" onClick={saveCombo}>
                    <Check className="h-3 w-3 mr-1" /> {editingId ? "Update" : "Save"}
                  </Button>
                </div>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        <KeyMapDialog
          open={mapOpen}
          onOpenChange={setMapOpen}
          reportId={reportId}
          rows={keyMap ?? []}
        />

        <PasteCombosDialog
          open={pasteOpen}
          onOpenChange={setPasteOpen}
          scenarioId={scenarioId}
          reportId={reportId}
          feLabels={feLabels}
          onImported={() => qc.invalidateQueries({ queryKey: ["scenario-filter-matrix", scenarioId] })}
        />
      </CardContent>
    </Card>
  );
}

function PasteCombosDialog({
  open,
  onOpenChange,
  scenarioId,
  reportId,
  feLabels,
  onImported,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  scenarioId: string;
  reportId?: string;
  feLabels: string[];
  onImported: () => void;
}) {
  const [text, setText] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<string[]>([]); // per-column FE label ("" = skip)
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setText(""); setHeaders([]); setRows([]); setMapping([]);
    }
  }, [open]);

  const parse = (raw: string) => {
    const lines = raw.replace(/\r/g, "").split("\n").filter((l) => l.trim().length > 0);
    if (!lines.length) return { headers: [], rows: [] };
    // Auto-detect delimiter from first line: prefer tab, then pipe, then comma
    const first = lines[0];
    const delim = first.includes("\t") ? "\t" : first.includes("|") ? "|" : ",";
    const split = (l: string) => l.split(delim).map((c) => c.trim());
    const headers = split(lines[0]);
    const rows = lines.slice(1).map(split);
    return { headers, rows };
  };

  const autoMap = (hdrs: string[]): string[] => {
    const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");
    const feNorm = new Map(feLabels.map((l) => [norm(l), l]));
    return hdrs.map((h) => feNorm.get(norm(h)) ?? "");
  };

  const handlePreview = () => {
    const { headers: h, rows: r } = parse(text);
    if (!h.length) { toast.error("Nothing to parse"); return; }
    setHeaders(h);
    setRows(r);
    setMapping(autoMap(h));
  };

  const buildPayload = () => {
    return rows.map((r) => {
      const filters: Record<string, string> = {};
      const labelParts: string[] = [];
      mapping.forEach((feLabel, colIdx) => {
        if (!feLabel) return;
        const v = (r[colIdx] ?? "").trim();
        if (!v) return;
        // Keep "Total" in filters — Playwright applies it on the UI; SQL WHERE builder skips it.
        filters[feLabel] = v;
        labelParts.push(v);
      });
      return { label: labelParts.join(" / ") || null, filters };
    }).filter((p) => Object.keys(p.filters).length > 0);
  };

  const doImport = async (scope: "scenario" | "report") => {
    if (!rows.length) { toast.error("Preview the paste first"); return; }
    const base = buildPayload();
    if (!base.length) { toast.error("No mapped values found in rows"); return; }

    // Dedup within the paste itself first
    const seen = new Set<string>();
    const uniqueBase = base.filter((p) => {
      const k = canonFilters(p.filters);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    setBusy(true);
    try {
      let targetScenarioIds: string[] = [scenarioId];
      if (scope === "report") {
        if (!reportId) { toast.error("Report id missing"); setBusy(false); return; }
        const { data: sc, error: scErr } = await supabase
          .from("scenarios")
          .select("id")
          .eq("report_id", reportId);
        if (scErr) { toast.error(scErr.message); setBusy(false); return; }
        targetScenarioIds = (sc ?? []).map((s: any) => s.id);
        if (!targetScenarioIds.length) { toast.error("No scenarios in this report"); setBusy(false); return; }
      }

      // Fetch existing combos across all target scenarios to skip duplicates
      const { data: existing, error: exErr } = await supabase
        .from("scenario_filter_matrix")
        .select("scenario_id,filters")
        .in("scenario_id", targetScenarioIds);
      if (exErr) { toast.error(exErr.message); setBusy(false); return; }
      const existingBySid = new Map<string, Set<string>>();
      for (const e of (existing ?? []) as any[]) {
        const set = existingBySid.get(e.scenario_id) ?? new Set<string>();
        set.add(canonFilters(e.filters || {}));
        existingBySid.set(e.scenario_id, set);
      }

      const payload: any[] = [];
      let skipped = 0;
      for (const sid of targetScenarioIds) {
        const existSet = existingBySid.get(sid) ?? new Set<string>();
        for (const p of uniqueBase) {
          const k = canonFilters(p.filters);
          if (existSet.has(k)) { skipped++; continue; }
          existSet.add(k);
          payload.push({ scenario_id: sid, label: p.label, filters: p.filters });
        }
      }

      if (!payload.length) {
        toast.error(`All ${uniqueBase.length} row${uniqueBase.length === 1 ? "" : "s"} already exist — nothing to import`);
        setBusy(false);
        return;
      }

      const { error } = await supabase.from("scenario_filter_matrix").insert(payload);
      if (error) { toast.error(error.message); setBusy(false); return; }
      const scopeMsg = scope === "report" ? ` across ${targetScenarioIds.length} scenarios` : "";
      toast.success(
        `Imported ${payload.length} combination${payload.length === 1 ? "" : "s"}${scopeMsg}` +
          (skipped ? ` · ${skipped} duplicate${skipped === 1 ? "" : "s"} skipped` : "")
      );
      onImported();
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };


  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Paste filter combinations</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="text-xs text-muted-foreground">
            Paste rows from Excel or a CSV. First row must be headers (Area, Region, Territory, Time Bucket, …).
            Delimiters supported: tab, comma, or pipe (auto-detected). Cells with value <span className="mono">Total</span> are still applied on the UI by Playwright but excluded from the SQL WHERE clause.
          </div>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={"Area\tRegion\tTerritory\tTime Bucket\nAA - East\tTotal\tTotal\tR12M\nTotal\tTotal\t147A - Miami Central, FL\tR12M"}
            className="mono text-xs min-h-[140px]"
          />
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={handlePreview}>Preview</Button>
            {rows.length > 0 && (
              <div className="text-xs text-muted-foreground self-center">
                {rows.length} row{rows.length === 1 ? "" : "s"} detected
              </div>
            )}
          </div>

          {headers.length > 0 && (
            <div className="border border-border rounded-md p-2 space-y-2">
              <div className="text-xs font-medium">Map columns to filter labels</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {headers.map((h, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <div className="text-xs mono flex-1 truncate" title={h}>{h}</div>
                    <Select
                      value={mapping[i] || "__skip__"}
                      onValueChange={(v) => setMapping((m) => m.map((x, idx) => (idx === i ? (v === "__skip__" ? "" : v) : x)))}
                    >
                      <SelectTrigger className="h-8 text-xs flex-1">
                        <SelectValue placeholder="Select filter" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__skip__">— Skip —</SelectItem>
                        {feLabels.map((l) => (
                          <SelectItem key={l} value={l}>{l}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
              {feLabels.length === 0 && (
                <div className="text-xs text-destructive">
                  No FE labels defined. Add them in "FE ↔ BE key mapping" first.
                </div>
              )}
              <div className="max-h-40 overflow-auto border-t border-border pt-2">
                <table className="w-full text-[11px] mono">
                  <thead>
                    <tr className="text-muted-foreground">
                      {headers.map((h, i) => (
                        <th key={i} className="text-left pr-2 pb-1">{mapping[i] || `(skip) ${h}`}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 20).map((r, ri) => (
                      <tr key={ri}>
                        {headers.map((_, ci) => {
                          const v = (r[ci] ?? "").trim();
                          const unmapped = !mapping[ci] || !v;
                          const sqlSkip = !unmapped && v.toLowerCase() === "total";
                          const cls = unmapped ? "text-muted-foreground line-through" : sqlSkip ? "text-muted-foreground italic" : "";
                          return (
                            <td key={ci} className={`pr-2 py-0.5 ${cls}`} title={sqlSkip ? "Applied on UI, skipped in SQL WHERE" : undefined}>
                              {v || "\u00a0"}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {rows.length > 20 && <div className="text-xs text-muted-foreground mt-1">…{rows.length - 20} more rows</div>}
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
          <div className="inline-flex">
            <Button
              size="sm"
              onClick={() => doImport("scenario")}
              disabled={busy || rows.length === 0 || feLabels.length === 0}
              className="rounded-r-none"
            >
              {busy ? "Importing…" : `Import ${rows.length || ""} row${rows.length === 1 ? "" : "s"}`}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  disabled={busy || rows.length === 0 || feLabels.length === 0}
                  className="rounded-l-none border-l border-primary-foreground/20 px-2"
                  aria-label="More import options"
                >
                  <ChevronDown className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => doImport("scenario")}>
                  Import to this scenario
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => doImport("report")} disabled={!reportId}>
                  Import to all scenarios of this report
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function KeyMapDialog({
  open,
  onOpenChange,
  reportId,
  rows,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  reportId?: string;
  rows: KeyMap[];
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Record<string, { fe_label: string; be_column: string }>>({});
  const [pushBusy, setPushBusy] = useState(false);
  const [saveAllBusy, setSaveAllBusy] = useState(false);
  const [newFe, setNewFe] = useState("");
  const [newBe, setNewBe] = useState("");

  const saveAllMappings = async () => {
    if (!reportId) throw new Error("Report not loaded");
    for (const r of rows) {
      const v = editing[r.id];
      if (!v?.fe_label.trim() || !v?.be_column.trim()) {
        throw new Error("Complete both fields for every mapping");
      }
      if (v.fe_label.trim() !== r.fe_label || v.be_column.trim() !== r.be_column) {
        const { error } = await supabase
          .from("scenario_filter_key_map")
          .update({ fe_label: v.fe_label.trim(), be_column: v.be_column.trim() })
          .eq("id", r.id);
        if (error) throw new Error(error.message);
      }
    }
    if (newFe.trim() || newBe.trim()) {
      if (!newFe.trim() || !newBe.trim()) throw new Error("Complete both fields for the new mapping");
      const { error } = await supabase.from("scenario_filter_key_map").insert({
        report_id: reportId,
        fe_label: newFe.trim(),
        be_column: newBe.trim(),
      });
      if (error) throw new Error(error.message);
      setNewFe("");
      setNewBe("");
    }
    await qc.invalidateQueries({ queryKey: ["report-filter-key-map", reportId] });
  };

  const saveAllForReport = async () => {
    setSaveAllBusy(true);
    try {
      await saveAllMappings();
      toast.success("Mappings saved — all cases in this report use them");
    } catch (e: any) {
      toast.error(e?.message || "Could not save the mappings");
    } finally {
      setSaveAllBusy(false);
    }
  };

  // Mapping is report-scoped; this pushes it to every other report in the workstream.
  const pushToWorkstream = async () => {
    if (!reportId) return;
    setPushBusy(true);
    try {
      // Apply must include the values currently visible in the dialog. Previously
      // it copied only the last saved DB rows, so editing a mapping and immediately
      // selecting Apply to all appeared to do nothing.
      await saveAllMappings();
      const res = await applyKeyMapToWorkstream(reportId);
      if (!res.targets) {
        toast.info("No other reports found in this workstream");
      } else if (!res.inserted) {
        toast.info(`All ${res.targets} other report(s) already match this mapping`);
      } else {
        toast.success(`Mapping applied to ${res.targets} other report(s) — ${res.inserted} entr(ies) written`);
      }
      qc.invalidateQueries({ queryKey: ["report-filter-key-map"] });
      qc.invalidateQueries({ queryKey: ["scenario-filter-key-map"] });
    } catch (e: any) {
      toast.error(e?.message || "Could not apply the mapping");
    } finally {
      setPushBusy(false);
    }
  };
  useEffect(() => {
    if (open) {
      const map: Record<string, { fe_label: string; be_column: string }> = {};
      for (const r of rows) map[r.id] = { fe_label: r.fe_label, be_column: r.be_column };
      setEditing(map);
      setNewFe("");
      setNewBe("");
    }
  }, [open, rows]);

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["report-filter-key-map", reportId] });

  const addRow = async () => {
    const fe = newFe.trim();
    const be = newBe.trim();
    if (!fe || !be) {
      toast.error("Enter both FE label and BE column");
      return;
    }
    if (!reportId) {
      toast.error("Report not loaded");
      return;
    }
    const { error } = await supabase.from("scenario_filter_key_map").insert({
      report_id: reportId,
      fe_label: fe,
      be_column: be,
    });
    if (error) return toast.error(error.message);
    toast.success("Mapping added");
    setNewFe("");
    setNewBe("");
    invalidate();
  };

  const saveRow = async (id: string) => {
    const v = editing[id];
    if (!v?.fe_label.trim() || !v?.be_column.trim()) {
      toast.error("Both fields are required");
      return;
    }
    const { error } = await supabase
      .from("scenario_filter_key_map")
      .update({ fe_label: v.fe_label.trim(), be_column: v.be_column.trim() })
      .eq("id", id);
    if (error) return toast.error(error.message);
    toast.success("Mapping updated");
    invalidate();
  };

  const deleteRow = async (id: string) => {
    const { error } = await supabase.from("scenario_filter_key_map").delete().eq("id", id);
    if (error) return toast.error(error.message);
    toast.success("Removed");
    invalidate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>FE ↔ BE key mapping</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="text-xs text-muted-foreground">
            Map frontend filter labels (used in Filter combinations) to backend warehouse table column names (used when generating the final SQL query).
            Mappings are report-scoped, so every case in this report uses them automatically.
          </div>

          <div className="grid grid-cols-[1fr_1fr_auto] gap-2 text-xs font-medium text-muted-foreground px-1">
            <div>FE Filter label</div>
            <div>BE column name</div>
            <div className="w-20 text-right">Actions</div>
          </div>

          <div className="space-y-2 max-h-[40vh] overflow-auto">
            {rows.map((r) => (
              <div key={r.id} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
                <Input
                  value={editing[r.id]?.fe_label ?? ""}
                  onChange={(e) =>
                    setEditing((s) => ({ ...s, [r.id]: { ...s[r.id], fe_label: e.target.value } }))
                  }
                  className="h-9 text-sm"
                />
                <Input
                  value={editing[r.id]?.be_column ?? ""}
                  onChange={(e) =>
                    setEditing((s) => ({ ...s, [r.id]: { ...s[r.id], be_column: e.target.value } }))
                  }
                  className="h-9 text-sm mono"
                />
                <div className="flex gap-1 justify-end w-20">
                  <Button size="sm" variant="ghost" onClick={() => saveRow(r.id)} aria-label="Save">
                    <Check className="h-3 w-3" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => deleteRow(r.id)} aria-label="Delete">
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            ))}
            {rows.length === 0 && (
              <div className="text-xs text-muted-foreground italic px-1">No mappings yet.</div>
            )}
          </div>

          <div className="border-t pt-3 space-y-2">
            <div className="text-xs font-medium">Add new mapping</div>
            <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
              <Input
                placeholder="FE label (e.g. Area)"
                value={newFe}
                onChange={(e) => setNewFe(e.target.value)}
                className="h-9 text-sm"
              />
              <Input
                placeholder="BE column (e.g. area_code)"
                value={newBe}
                onChange={(e) => setNewBe(e.target.value)}
                className="h-9 text-sm mono"
              />
              <Button size="sm" onClick={addRow} className="w-20">
                <Plus className="h-3 w-3 mr-1" /> Add
              </Button>
            </div>
          </div>
        </div>
        <DialogFooter className="sm:justify-between">
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!reportId || saveAllBusy || pushBusy}
              onClick={() => void saveAllForReport()}
              title="Save the mappings; all cases in this report use the report-level map"
            >
              {saveAllBusy ? "Saving…" : "Save all for this report"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!reportId || !rows.length || pushBusy || saveAllBusy}
              onClick={() => void pushToWorkstream()}
              title="Save the mappings and copy them to all other reports in this workstream"
            >
              {pushBusy ? "Saving and applying…" : "Save & apply to all reports in workstream"}
            </Button>
          </div>
          <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

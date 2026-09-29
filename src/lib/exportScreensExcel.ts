import * as XLSX from "xlsx";
import { supabase } from "@/integrations/supabase/client";

export type ScreenExportFilters = {
  workstreamId?: string;
  search?: string;
};

type WorkstreamRow = { id: string; name: string };
type ReportRow = { id: string; name: string; url: string | null; workstream_id: string };
type ScenarioRow = {
  id: string;
  title: string;
  type: string;
  criticality: string | null;
  status: string | null;
  deferred: boolean;
  report_id: string;
};

function norm(s: string) {
  return s.toLowerCase().trim();
}

function matchesSearch(parts: (string | null | undefined)[], q: string) {
  if (!q) return true;
  return parts.some((p) => norm(String(p || "")).includes(q));
}

export async function fetchScreensExportData(filters: ScreenExportFilters = {}) {
  const wsFilter = filters.workstreamId && filters.workstreamId !== "all" ? filters.workstreamId : null;
  const q = norm(filters.search || "");

  const wsQuery = supabase.from("workstreams").select("id, name").order("name");
  const repQuery = supabase.from("reports").select("id, name, url, workstream_id").order("name");
  const scQuery = supabase
    .from("scenarios")
    .select("id, title, type, criticality, status, deferred, report_id")
    .order("title");

  if (wsFilter) repQuery.eq("workstream_id", wsFilter);

  const [wsRes, repRes, scRes, resultsRes] = await Promise.all([
    wsQuery,
    repQuery,
    scQuery,
    supabase
      .from("test_results")
      .select("scenario_id, status, created_at")
      .order("created_at", { ascending: false })
      .limit(10000),
  ]);

  if (wsRes.error) throw wsRes.error;
  if (repRes.error) throw repRes.error;
  if (scRes.error) throw scRes.error;
  if (resultsRes.error) throw resultsRes.error;

  const workstreams = (wsRes.data ?? []) as WorkstreamRow[];
  const reports = (repRes.data ?? []) as ReportRow[];
  const scenarios = (scRes.data ?? []) as ScenarioRow[];

  const latestStatus = new Map<string, string>();
  for (const r of resultsRes.data ?? []) {
    const sid = r.scenario_id as string;
    if (!latestStatus.has(sid)) latestStatus.set(sid, r.status as string);
  }

  const wsById = new Map(workstreams.map((w) => [w.id, w]));
  const repById = new Map(reports.map((r) => [r.id, r]));

  const visibleReports = reports.filter((r) => {
    if (wsFilter && r.workstream_id !== wsFilter) return false;
    return matchesSearch([r.name, r.url], q);
  });
  const visibleReportIds = new Set(visibleReports.map((r) => r.id));

  const visibleWorkstreams = workstreams.filter((w) => {
    if (wsFilter && w.id !== wsFilter) return false;
    if (!q) return true;
    const hasVisibleScreen = visibleReports.some((r) => r.workstream_id === w.id);
    return hasVisibleScreen || matchesSearch([w.name], q);
  });

  const visibleScenarios = scenarios.filter((s) => {
    if (!visibleReportIds.has(s.report_id)) return false;
    const rep = repById.get(s.report_id);
    const ws = rep ? wsById.get(rep.workstream_id) : null;
    return matchesSearch([s.title, rep?.name, ws?.name, rep?.url], q);
  });

  const reportRows = visibleWorkstreams.map((w) => ({
    "Report ID": w.id,
    "Report Name": w.name,
    "Screen Count": visibleReports.filter((r) => r.workstream_id === w.id).length,
    "Test Case Count": visibleScenarios.filter((s) => {
      const rep = repById.get(s.report_id);
      return rep?.workstream_id === w.id;
    }).length,
  }));

  const screenRows = visibleReports.map((r) => {
    const ws = wsById.get(r.workstream_id);
    const screenScenarios = visibleScenarios.filter((s) => s.report_id === r.id);
    return {
      "Report Name": ws?.name ?? "",
      "Report ID": r.workstream_id,
      "Screen ID": r.id,
      "Screen Name": r.name,
      "Screen URL": r.url ?? "",
      "Test Case Count": screenScenarios.length,
    };
  });

  const testCaseRows = visibleScenarios.map((s) => {
    const rep = repById.get(s.report_id);
    const ws = rep ? wsById.get(rep.workstream_id) : null;
    return {
      "Report Name": ws?.name ?? "",
      "Report ID": rep?.workstream_id ?? "",
      "Screen Name": rep?.name ?? "",
      "Screen ID": s.report_id,
      "Screen URL": rep?.url ?? "",
      "Test Case ID": s.id,
      "Test Case Title": s.title,
      Type: s.type,
      Criticality: s.criticality ?? "medium",
      Deferred: s.deferred ? "Yes" : "No",
      "Scenario Status": s.status ?? "",
      "Latest Run Status": latestStatus.get(s.id) ?? "pending",
    };
  });

  return { reportRows, screenRows, testCaseRows };
}

export function downloadScreensExcel(
  data: Awaited<ReturnType<typeof fetchScreensExportData>>,
  filename?: string,
) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data.reportRows), "Reports");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data.screenRows), "Screens");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data.testCaseRows), "Test Cases");

  const stamp = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, filename || `report-test-buddy-screens-${stamp}.xlsx`);
}

export async function exportScreensToExcel(filters: ScreenExportFilters = {}) {
  const data = await fetchScreensExportData(filters);
  downloadScreensExcel(data);
  return {
    reports: data.reportRows.length,
    screens: data.screenRows.length,
    testCases: data.testCaseRows.length,
  };
}

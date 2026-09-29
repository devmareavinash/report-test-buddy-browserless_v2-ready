import { supabase } from "@/integrations/supabase/client";

export function deleteScenarioConfirm(title: string) {
  return `Delete test case "${title}"? This also removes its saved script, filter combinations, KPI settings, and version history.`;
}

export function deleteReportConfirm(name: string) {
  return `Delete screen "${name}"? This also removes its test cases, saved scripts, filter combinations, FE ↔ BE mappings, KPI settings, version history, results, and schedules.`;
}

export function deleteWorkstreamConfirm(name: string) {
  return `Delete report "${name}"? This also removes all screens, test cases, saved scripts, mappings, filter combinations, results, and schedules inside it. This cannot be undone.`;
}

function throwIf(error: { message?: string } | null | undefined, fallback: string) {
  if (error) throw new Error(error.message || fallback);
}

async function deleteScenarioChildren(scenarioIds: string[]) {
  if (!scenarioIds.length) return;
  const { data: scripts, error: scErr } = await supabase
    .from("scripts")
    .select("id")
    .in("scenario_id", scenarioIds);
  throwIf(scErr, "Failed to list scripts");
  const scriptIds = (scripts || []).map((s: any) => s.id);
  if (scriptIds.length) {
    const { error } = await supabase.from("script_versions").delete().in("script_id", scriptIds);
    throwIf(error, "Failed to delete script versions");
  }
  const { error: scriptsErr } = await supabase.from("scripts").delete().in("scenario_id", scenarioIds);
  throwIf(scriptsErr, "Failed to delete scripts");
  const { error: verErr } = await supabase.from("scenario_versions").delete().in("scenario_id", scenarioIds);
  throwIf(verErr, "Failed to delete scenario versions");
  const { error: mxErr } = await supabase.from("scenario_filter_matrix").delete().in("scenario_id", scenarioIds);
  throwIf(mxErr, "Failed to delete filter combinations");
  const { error: trErr } = await supabase.from("test_results").delete().in("scenario_id", scenarioIds);
  throwIf(trErr, "Failed to delete test results");
  const { error: jobErr } = await supabase.from("playwright_jobs").delete().in("scenario_id", scenarioIds);
  throwIf(jobErr, "Failed to delete playwright jobs");
}

/** Drop a test case and its script / filters / versions / results. FE ↔ BE mappings stay on the screen. */
export async function deleteScenario(scenarioId: string) {
  await deleteScenarioChildren([scenarioId]);
  const { error } = await supabase.from("scenarios").delete().eq("id", scenarioId);
  throwIf(error, "Failed to delete test case");
}

async function deleteReportScopedSqlTemplates(reportId: string) {
  const { error: nullDefault } = await supabase
    .from("reports")
    .update({ default_sql_template_id: null })
    .eq("id", reportId);
  throwIf(nullDefault, "Failed to unbind SQL template");
  const { error } = await supabase.from("sql_templates").delete().eq("report_id", reportId);
  throwIf(error, "Failed to delete SQL templates");
}

/** Drop a screen and everything inside it. Shared credential / warehouse profiles are kept. */
export async function deleteReport(reportId: string) {
  const { data: scs, error: scErr } = await supabase.from("scenarios").select("id").eq("report_id", reportId);
  throwIf(scErr, "Failed to list test cases");
  const sids = (scs || []).map((s: any) => s.id);
  await deleteScenarioChildren(sids);
  if (sids.length) {
    const { error } = await supabase.from("scenarios").delete().in("id", sids);
    throwIf(error, "Failed to delete test cases");
  }

  const { error: mapErr } = await supabase.from("scenario_filter_key_map").delete().eq("report_id", reportId);
  throwIf(mapErr, "Failed to delete FE ↔ BE mappings");
  const { error: prerunErr } = await supabase.from("prerun_scripts").delete().eq("report_id", reportId);
  throwIf(prerunErr, "Failed to delete prerun scripts");
  await deleteReportScopedSqlTemplates(reportId);

  const { error: runErr } = await supabase.from("runs").delete().eq("scope_type", "report").eq("scope_id", reportId);
  throwIf(runErr, "Failed to delete runs");
  const { error: schErr } = await supabase.from("schedules").delete().eq("scope_type", "report").eq("scope_id", reportId);
  throwIf(schErr, "Failed to delete schedules");

  const { error } = await supabase.from("reports").delete().eq("id", reportId);
  throwIf(error, "Failed to delete screen");
}

/** Drop a workstream (UI “report”) and every screen / case / script / mapping inside it. */
export async function deleteWorkstream(workstreamId: string) {
  const { data: reports, error: rErr } = await supabase
    .from("reports")
    .select("id")
    .eq("workstream_id", workstreamId);
  throwIf(rErr, "Failed to list screens");
  for (const r of reports || []) {
    await deleteReport(r.id);
  }
  const { error: runErr } = await supabase
    .from("runs")
    .delete()
    .eq("scope_type", "workstream")
    .eq("scope_id", workstreamId);
  throwIf(runErr, "Failed to delete report runs");
  const { error: schErr } = await supabase
    .from("schedules")
    .delete()
    .eq("scope_type", "workstream")
    .eq("scope_id", workstreamId);
  throwIf(schErr, "Failed to delete report schedules");
  const { error } = await supabase.from("workstreams").delete().eq("id", workstreamId);
  throwIf(error, "Failed to delete report");
}

import { supabase } from "@/integrations/supabase/client";
import { cloneCanonicalScript } from "@/lib/canonicalScript";

export function copyTitle(title: string): string {
  const t = String(title || "Untitled").trim() || "Untitled";
  if (/\(copy\)\s*$/i.test(t)) return t.replace(/\(copy\)\s*$/i, "").trim() + " (copy)";
  return `${t} (copy)`;
}

/** Remap a copied child id; drop the pointer if the parent row was not cloned. */
export function remapOrNull(id: string | null | undefined, map: Map<string, string>): string | null {
  if (!id) return null;
  return map.get(id) ?? null;
}

function throwIf(error: { message?: string } | null | undefined, fallback: string) {
  if (error) throw new Error(error.message || fallback);
}

type ScenarioRow = {
  id: string;
  report_id: string;
  title: string;
  description?: string | null;
  type?: string | null;
  criticality?: string | null;
  status?: string | null;
  prerun_id?: string | null;
  reference_url?: string | null;
  deferred?: boolean | null;
};

function scenarioCloneFields(
  src: ScenarioRow,
  reportId: string,
  opts: { title?: string; prerunId?: string | null; deferred?: boolean },
) {
  return {
    report_id: reportId,
    title: opts.title ?? src.title,
    description: src.description ?? null,
    type: src.type,
    criticality: src.criticality,
    status: src.status || "active",
    prerun_id: opts.prerunId !== undefined ? opts.prerunId : src.prerun_id ?? null,
    reference_url: (src as any).reference_url ?? null,
    deferred: opts.deferred ?? false,
  };
}

async function cloneFilterMatrix(sourceScenarioId: string, targetScenarioId: string) {
  const { data: matrix, error } = await supabase
    .from("scenario_filter_matrix")
    .select("label, filters")
    .eq("scenario_id", sourceScenarioId)
    .order("created_at", { ascending: true });
  throwIf(error, "Failed to read filter combinations");
  if (!matrix?.length) return;
  const { error: mErr } = await supabase.from("scenario_filter_matrix").insert(
    matrix.map((m) => ({
      scenario_id: targetScenarioId,
      label: m.label,
      filters: m.filters,
    })),
  );
  throwIf(mErr, "Failed to copy filter combinations");
}

/** FE ↔ BE key mapping lives on the screen (report), not the test case. */
async function cloneFilterKeyMap(sourceReportId: string, targetReportId: string) {
  const { data: rows, error } = await supabase
    .from("scenario_filter_key_map")
    .select("fe_label, be_column")
    .eq("report_id", sourceReportId)
    .order("created_at", { ascending: true });
  throwIf(error, "Failed to read FE ↔ BE key mapping");
  if (!rows?.length) return;
  const { error: iErr } = await supabase.from("scenario_filter_key_map").insert(
    rows.map((r) => ({
      report_id: targetReportId,
      fe_label: r.fe_label,
      be_column: r.be_column,
    })),
  );
  throwIf(iErr, "Failed to copy FE ↔ BE key mapping");
}

async function cloneReportScopedSqlTemplates(sourceReportId: string, targetReportId: string) {
  const { data: tpls, error } = await supabase
    .from("sql_templates")
    .select("id, name, sql_text, parameters, tags, scope")
    .eq("report_id", sourceReportId)
    .order("created_at", { ascending: true });
  throwIf(error, "Failed to read SQL templates");
  const idMap = new Map<string, string>();
  for (const t of tpls || []) {
    const { data: created, error: iErr } = await supabase
      .from("sql_templates")
      .insert({
        name: t.name,
        sql_text: t.sql_text,
        parameters: t.parameters ?? {},
        tags: t.tags ?? [],
        scope: t.scope || "report",
        report_id: targetReportId,
      })
      .select("id")
      .single();
    throwIf(iErr, "Failed to copy SQL template");
    if (!created) throw new Error("Failed to copy SQL template");
    idMap.set(t.id, created.id);
  }
  return idMap;
}

async function clonePrerunScripts(sourceReportId: string, targetReportId: string) {
  const { data: preruns, error } = await supabase
    .from("prerun_scripts")
    .select("id, name, playwright_code, steps")
    .eq("report_id", sourceReportId)
    .order("created_at", { ascending: true });
  throwIf(error, "Failed to read prerun scripts");
  const idMap = new Map<string, string>();
  for (const p of preruns || []) {
    const { data: created, error: iErr } = await supabase
      .from("prerun_scripts")
      .insert({
        report_id: targetReportId,
        name: p.name,
        playwright_code: p.playwright_code,
        steps: p.steps ?? [],
      })
      .select("id")
      .single();
    throwIf(iErr, "Failed to copy prerun script");
    if (!created) throw new Error("Failed to copy prerun script");
    idMap.set(p.id, created.id);
  }
  return idMap;
}

/** Duplicate a scenario under the same report: settings + script + filter matrix. Mappings stay on the shared screen. */
export async function duplicateScenario(scenarioId: string): Promise<{ id: string; title: string }> {
  const { data: src, error: sErr } = await supabase
    .from("scenarios")
    .select("*")
    .eq("id", scenarioId)
    .maybeSingle();
  if (sErr) throw new Error(sErr.message);
  if (!src) throw new Error("Scenario not found");

  const { data: created, error: cErr } = await supabase
    .from("scenarios")
    .insert(scenarioCloneFields(src as ScenarioRow, src.report_id, {
      title: copyTitle(src.title),
      prerunId: src.prerun_id ?? null,
      deferred: false,
    }))
    .select("id, title")
    .single();
  if (cErr || !created) throw new Error(cErr?.message || "Failed to create scenario copy");

  await cloneCanonicalScript(scenarioId, created.id);
  await cloneFilterMatrix(scenarioId, created.id);

  return { id: created.id, title: created.title };
}

export type DuplicateReportOpts = {
  workstreamId?: string;
  brandId?: string | null;
};

/** Duplicate a screen (report) and all of its scenarios (scripts, filters, mappings, SQL bindings). */
export async function duplicateReport(
  reportId: string,
  opts?: DuplicateReportOpts,
): Promise<{ id: string; name: string }> {
  const { data: src, error: rErr } = await supabase
    .from("reports")
    .select("*")
    .eq("id", reportId)
    .maybeSingle();
  if (rErr) throw new Error(rErr.message);
  if (!src) throw new Error("Screen not found");

  const nested = !!opts?.workstreamId;
  const newName = nested ? src.name : copyTitle(src.name);
  const insertReport: any = {
    name: newName,
    url: src.url,
    workstream_id: opts?.workstreamId ?? src.workstream_id,
    brand_id: opts && "brandId" in opts ? opts.brandId ?? null : src.brand_id,
    credential_profile_id: src.credential_profile_id,
    reference_credential_profile_id: (src as any).reference_credential_profile_id ?? null,
    warehouse_connector_id: src.warehouse_connector_id,
    default_sql_template_id: src.default_sql_template_id,
    kpi_config: src.kpi_config,
    reference_url: (src as any).reference_url ?? null,
  };
  // Do not copy schedule_cron onto the duplicate.
  const { data: created, error: cErr } = await supabase
    .from("reports")
    .insert(insertReport)
    .select("id, name")
    .single();
  if (cErr || !created) throw new Error(cErr?.message || "Failed to create screen copy");

  const sqlTemplateIdMap = await cloneReportScopedSqlTemplates(reportId, created.id);
  const remappedDefault = src.default_sql_template_id
    ? sqlTemplateIdMap.get(src.default_sql_template_id)
    : undefined;
  if (remappedDefault) {
    const { error: dErr } = await supabase
      .from("reports")
      .update({ default_sql_template_id: remappedDefault })
      .eq("id", created.id);
    throwIf(dErr, "Failed to rebind SQL template");
  }

  await cloneFilterKeyMap(reportId, created.id);
  const prerunIdMap = await clonePrerunScripts(reportId, created.id);

  const { data: scenarios, error: scListErr } = await supabase
    .from("scenarios")
    .select("id")
    .eq("report_id", reportId)
    .order("created_at", { ascending: true });
  throwIf(scListErr, "Failed to list scenarios");

  for (const s of scenarios || []) {
    const { data: full, error: fullErr } = await supabase.from("scenarios").select("*").eq("id", s.id).maybeSingle();
    throwIf(fullErr, "Failed to read scenario");
    if (!full) continue;
    const { data: newSc, error: scErr } = await supabase
      .from("scenarios")
      .insert(scenarioCloneFields(full as ScenarioRow, created.id, {
        prerunId: remapOrNull(full.prerun_id, prerunIdMap),
        deferred: !!full.deferred,
      }))
      .select("id")
      .single();
    if (scErr || !newSc) throw new Error(scErr?.message || "Failed to copy scenario");

    await cloneCanonicalScript(s.id, newSc.id, { sqlTemplateIdMap });
    await cloneFilterMatrix(s.id, newSc.id);
  }

  return { id: created.id, name: created.name };
}

/** Duplicate a report (workstream) and all of its screens (with scenarios, scripts, filters, mappings). */
export async function duplicateWorkstream(
  workstreamId: string,
): Promise<{ id: string; name: string }> {
  const { data: src, error: wErr } = await supabase
    .from("workstreams")
    .select("*")
    .eq("id", workstreamId)
    .maybeSingle();
  if (wErr) throw new Error(wErr.message);
  if (!src) throw new Error("Report not found");

  const { data: created, error: cErr } = await supabase
    .from("workstreams")
    .insert({ name: copyTitle(src.name) })
    .select("id, name")
    .single();
  if (cErr || !created) throw new Error(cErr?.message || "Failed to create report copy");

  const { data: brands, error: bErr } = await supabase
    .from("brands")
    .select("id, name")
    .eq("workstream_id", workstreamId);
  if (bErr) throw new Error(bErr.message);

  const brandIdMap = new Map<string, string>();
  for (const b of brands || []) {
    const { data: newBrand, error: nbErr } = await supabase
      .from("brands")
      .insert({ name: b.name, workstream_id: created.id })
      .select("id")
      .single();
    if (nbErr || !newBrand) throw new Error(nbErr?.message || "Failed to copy brand");
    brandIdMap.set(b.id, newBrand.id);
  }

  const { data: reports, error: rErr } = await supabase
    .from("reports")
    .select("id, brand_id")
    .eq("workstream_id", workstreamId)
    .order("created_at", { ascending: true });
  if (rErr) throw new Error(rErr.message);

  for (const r of reports || []) {
    const brandId = r.brand_id ? brandIdMap.get(r.brand_id) ?? null : null;
    await duplicateReport(r.id, { workstreamId: created.id, brandId });
  }

  return { id: created.id, name: created.name };
}

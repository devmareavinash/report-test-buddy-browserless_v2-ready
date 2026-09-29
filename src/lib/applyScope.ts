/**
 * Scope helpers for "apply this to every case in the report / workstream".
 *
 * Hierarchy: workstreams -> brands -> reports -> scenarios (test cases).
 * There is no workstream_id on reports, so a workstream scope is resolved by
 * walking reports -> brands -> workstream_id.
 */
import { supabase } from "@/integrations/supabase/client";

export type ApplyScope = "report" | "workstream";

/** Canonical form of a filter map so duplicates are detected regardless of key order. */
export const canonFilterMap = (f: Record<string, string>) => {
  const keys = Object.keys(f || {})
    .map((k) => k.trim())
    .filter(Boolean)
    .sort();
  return JSON.stringify(keys.map((k) => [k, String((f as any)[k] ?? "").trim()]));
};

/** Every report id in the same workstream as `reportId` (includes reportId itself). */
export async function reportIdsInWorkstream(reportId: string): Promise<string[]> {
  const { data: rep, error: repErr } = await supabase
    .from("reports")
    .select("id, workstream_id, brand_id")
    .eq("id", reportId)
    .maybeSingle();
  if (repErr) throw new Error(repErr.message);
  // Current schema stores workstream_id directly on reports. The brand walk
  // remains as a compatibility fallback for older databases.
  if (rep?.workstream_id) {
    const { data: directReports, error: directErr } = await supabase
      .from("reports")
      .select("id")
      .eq("workstream_id", rep.workstream_id);
    if (directErr) throw new Error(directErr.message);
    const ids = (directReports ?? []).map((r: any) => r.id);
    return ids.length ? ids : [reportId];
  }
  if (!rep?.brand_id) return [reportId];

  const { data: brand, error: brandErr } = await supabase
    .from("brands")
    .select("id, workstream_id")
    .eq("id", rep.brand_id)
    .maybeSingle();
  if (brandErr) throw new Error(brandErr.message);
  if (!brand?.workstream_id) return [reportId];

  const { data: brands, error: brandsErr } = await supabase
    .from("brands")
    .select("id")
    .eq("workstream_id", brand.workstream_id);
  if (brandsErr) throw new Error(brandsErr.message);

  const brandIds = (brands ?? []).map((b: any) => b.id);
  if (!brandIds.length) return [reportId];

  const { data: reports, error: repsErr } = await supabase
    .from("reports")
    .select("id")
    .in("brand_id", brandIds);
  if (repsErr) throw new Error(repsErr.message);

  const ids = (reports ?? []).map((r: any) => r.id);
  return ids.length ? ids : [reportId];
}

/** Every scenario (test case) id in the given scope. */
export async function scenarioIdsInScope(reportId: string, scope: ApplyScope): Promise<string[]> {
  const reportIds = scope === "workstream" ? await reportIdsInWorkstream(reportId) : [reportId];
  const { data, error } = await supabase
    .from("scenarios")
    .select("id")
    .in("report_id", reportIds);
  if (error) throw new Error(error.message);
  return (data ?? []).map((s: any) => s.id);
}

export type ApplyResult = { targets: number; inserted: number; skipped: number };

/**
 * Copy one filter combination onto every scenario in scope.
 * Scenarios that already have an identical combination are skipped, so the
 * action is safe to run twice.
 */
export async function applyFilterComboToScope(opts: {
  reportId: string;
  scope: ApplyScope;
  label: string | null;
  filters: Record<string, string>;
  excludeScenarioId?: string;
}): Promise<ApplyResult> {
  const { reportId, scope, label, filters, excludeScenarioId } = opts;
  const targets = (await scenarioIdsInScope(reportId, scope)).filter((id) => id !== excludeScenarioId);
  if (!targets.length) return { targets: 0, inserted: 0, skipped: 0 };

  // Existing combos for those scenarios — used to skip exact duplicates.
  const { data: existing, error } = await supabase
    .from("scenario_filter_matrix")
    .select("scenario_id, filters")
    .in("scenario_id", targets);
  if (error) throw new Error(error.message);

  const seen = new Set<string>();
  for (const row of existing ?? []) {
    seen.add(`${(row as any).scenario_id}::${canonFilterMap((row as any).filters || {})}`);
  }

  const wanted = canonFilterMap(filters);
  const rows = targets
    .filter((sid) => !seen.has(`${sid}::${wanted}`))
    .map((sid) => ({ scenario_id: sid, label: label || null, filters }));

  if (!rows.length) return { targets: targets.length, inserted: 0, skipped: targets.length };

  // Chunked so a large workstream does not exceed the request size limit.
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const { error: insErr } = await supabase.from("scenario_filter_matrix").insert(chunk);
    if (insErr) throw new Error(insErr.message);
    inserted += chunk.length;
  }
  return { targets: targets.length, inserted, skipped: targets.length - inserted };
}

/** Copy every combination from one scenario onto every other scenario in scope. */
export async function applyAllFilterCombosToScope(opts: {
  reportId: string;
  scope: ApplyScope;
  sourceScenarioId: string;
  combos: { label: string | null; filters: Record<string, string> }[];
}): Promise<ApplyResult> {
  const { reportId, scope, sourceScenarioId, combos } = opts;
  const targets = (await scenarioIdsInScope(reportId, scope)).filter((id) => id !== sourceScenarioId);
  if (!targets.length || !combos.length) {
    return { targets: targets.length, inserted: 0, skipped: targets.length * combos.length };
  }

  const { data: existing, error } = await supabase
    .from("scenario_filter_matrix")
    .select("scenario_id, filters")
    .in("scenario_id", targets);
  if (error) throw new Error(error.message);

  const seen = new Set<string>();
  for (const row of existing ?? []) {
    seen.add(`${(row as any).scenario_id}::${canonFilterMap((row as any).filters || {})}`);
  }

  const rows: any[] = [];
  for (const sid of targets) {
    for (const combo of combos) {
      const key = `${sid}::${canonFilterMap(combo.filters || {})}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ scenario_id: sid, label: combo.label || null, filters: combo.filters || {} });
    }
  }

  let inserted = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const { error: insertError } = await supabase
      .from("scenario_filter_matrix")
      .insert(chunk);
    if (insertError) throw new Error(insertError.message);
    inserted += chunk.length;
  }
  const totalSlots = targets.length * combos.length;
  return { targets: targets.length, inserted, skipped: totalSlots - inserted };
}

/**
 * Copy this report's FE->BE column mapping to every other report in the workstream.
 * The mapping table is report-scoped with a UNIQUE (report_id, fe_label) index,
 * so an existing fe_label is updated rather than duplicated.
 */
export async function applyKeyMapToWorkstream(reportId: string): Promise<ApplyResult> {
  const { data: source, error: srcErr } = await supabase
    .from("scenario_filter_key_map")
    .select("fe_label, be_column")
    .eq("report_id", reportId);
  if (srcErr) throw new Error(srcErr.message);
  if (!source?.length) return { targets: 0, inserted: 0, skipped: 0 };

  const targetReports = (await reportIdsInWorkstream(reportId)).filter((id) => id !== reportId);
  if (!targetReports.length) return { targets: 0, inserted: 0, skipped: 0 };

  const { data: existing, error: exErr } = await supabase
    .from("scenario_filter_key_map")
    .select("id, report_id, fe_label, be_column")
    .in("report_id", targetReports);
  if (exErr) throw new Error(exErr.message);

  const byKey = new Map<string, any>();
  for (const row of existing ?? []) {
    byKey.set(`${(row as any).report_id}::${String((row as any).fe_label).trim().toLowerCase()}`, row);
  }

  const toInsert: any[] = [];
  const toUpdate: { id: string; be_column: string }[] = [];
  for (const rid of targetReports) {
    for (const m of source) {
      const key = `${rid}::${String((m as any).fe_label).trim().toLowerCase()}`;
      const hit = byKey.get(key);
      if (!hit) {
        toInsert.push({ report_id: rid, fe_label: (m as any).fe_label, be_column: (m as any).be_column });
      } else if (hit.be_column !== (m as any).be_column) {
        toUpdate.push({ id: hit.id, be_column: (m as any).be_column });
      }
    }
  }

  for (let i = 0; i < toInsert.length; i += 200) {
    const { error } = await supabase.from("scenario_filter_key_map").insert(toInsert.slice(i, i + 200));
    if (error) throw new Error(error.message);
  }
  for (const u of toUpdate) {
    const { error } = await supabase
      .from("scenario_filter_key_map")
      .update({ be_column: u.be_column })
      .eq("id", u.id);
    if (error) throw new Error(error.message);
  }

  return {
    targets: targetReports.length,
    inserted: toInsert.length + toUpdate.length,
    skipped: targetReports.length * source.length - toInsert.length - toUpdate.length,
  };
}

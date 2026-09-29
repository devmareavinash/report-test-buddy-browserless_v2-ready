import { supabase } from "@/integrations/supabase/client";

export function scriptHasSavedCode(row: { playwright_code?: string | null } | null | undefined) {
  return Boolean(String(row?.playwright_code || "").trim());
}

export function referenceCodeFromSpec(spec: unknown): string {
  if (!spec || typeof spec !== "object") return "";
  return String((spec as { __reference_playwright_code?: unknown }).__reference_playwright_code || "").trim();
}

type DuplicableScript = {
  playwright_code?: string | null;
  assertion_spec?: unknown;
  sql_template_id?: string | null;
  created_at?: string | null;
};

function createdAtMs(row: { created_at?: string | null } | null | undefined) {
  const t = Date.parse(String(row?.created_at || ""));
  return Number.isFinite(t) ? t : 0;
}

/** Newest created_at first. Hosted Postgres has no scripts.updated_at — do not infer last save from it. */
function newestCreatedFirst<T extends { created_at?: string | null }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => createdAtMs(b) - createdAtMs(a));
}

/** Saved test code, reference Playwright, or a bound SQL template — not an empty stub. */
export function scriptHasDuplicableContent(row: DuplicableScript | null | undefined) {
  if (!row) return false;
  if (scriptHasSavedCode(row)) return true;
  if (referenceCodeFromSpec(row.assertion_spec)) return true;
  return Boolean(row.sql_template_id);
}

/**
 * Canonical row for a scenario: non-empty playwright_code wins over empty stubs.
 * If several have code, newest created_at wins (no updated_at on hosted Postgres).
 */
export function pickCanonicalScript<T extends { playwright_code?: string | null; created_at?: string | null }>(
  rows: T[] | null | undefined,
): T | null {
  if (!rows?.length) return null;
  const withCode = newestCreatedFirst(rows.filter((r) => scriptHasSavedCode(r)));
  if (withCode[0]) return withCode[0];
  return newestCreatedFirst(rows)[0] ?? null;
}

/**
 * Duplicate picker: newest coded playwright_code, else newest row with reference/SQL content.
 * Empty stubs are never chosen.
 */
export function pickDuplicableScript<T extends DuplicableScript>(rows: T[] | null | undefined): T | null {
  if (!rows?.length) return null;
  const withCode = newestCreatedFirst(rows.filter((r) => scriptHasSavedCode(r)));
  if (withCode[0]) return withCode[0];
  return newestCreatedFirst(rows.filter((r) => scriptHasDuplicableContent(r)))[0] ?? null;
}

export function cloneAssertionSpec(spec: unknown): Record<string, unknown> {
  if (!spec || typeof spec !== "object") return {};
  try {
    return JSON.parse(JSON.stringify(spec)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export type CloneScriptOpts = {
  /** Report-scoped SQL templates get new ids; global templates keep their id. */
  sqlTemplateIdMap?: Map<string, string>;
};

/** Keep a global SQL template id; remap a report-scoped copy. */
export function remapSqlTemplateId(
  id: string | null | undefined,
  map?: Map<string, string>,
): string | null {
  if (!id) return null;
  return map?.get(id) ?? id;
}

/** New scripts row payload: new scenario_id, never the source scripts.id. */
export function buildClonedScriptInsert(
  script: DuplicableScript & {
    id?: string;
    scenario_id?: string;
    sql_filters?: unknown;
    credential_profile_id?: string | null;
    reference_credential_profile_id?: string | null;
    debug_status?: string | null;
  },
  targetScenarioId: string,
  opts?: CloneScriptOpts,
) {
  return {
    scenario_id: targetScenarioId,
    playwright_code: script.playwright_code || "",
    assertion_spec: cloneAssertionSpec(script.assertion_spec),
    sql_template_id: remapSqlTemplateId(script.sql_template_id, opts?.sqlTemplateIdMap),
    sql_filters: script.sql_filters ?? {},
    credential_profile_id: script.credential_profile_id ?? null,
    reference_credential_profile_id: script.reference_credential_profile_id ?? null,
    debug_status: script.debug_status || "draft",
  };
}

function selectColumns(columns: string) {
  if (columns.trim() === "*") return "*";
  const parts = columns
    .split(",")
    .map((s) => s.trim())
    .filter((p) => p && p !== "updated_at");
  if (!parts.includes("id")) parts.push("id");
  if (!parts.includes("playwright_code")) parts.push("playwright_code");
  if (!parts.includes("created_at")) parts.push("created_at");
  return parts.join(", ");
}

function stripUpdatedAt(payload: Record<string, unknown>) {
  const next = { ...payload };
  delete next.updated_at;
  return next;
}

/** Newest created_at first. Never ORDER BY updated_at — that column is missing on hosted Postgres. */
export function applyCanonicalScriptOrder<T>(query: T): T {
  return (query as any).order("created_at", { ascending: false }) as T;
}

/**
 * Scenario-level shared script (not per-user). Any signed-in JWT can SELECT.
 * Among duplicates, a row with saved playwright_code beats an empty stub; then newest created_at.
 */
async function fetchCanonicalScriptRows(scenarioId: string, columns = "*") {
  const cols = selectColumns(columns);
  const result = await applyCanonicalScriptOrder(
    supabase.from("scripts").select(cols).eq("scenario_id", scenarioId),
  ).limit(25);
  return { data: ((result.data as any[]) || []) as any[], error: result.error };
}

export async function fetchCanonicalScript(scenarioId: string, columns = "*") {
  const { data, error } = await fetchCanonicalScriptRows(scenarioId, columns);
  return { data: pickCanonicalScript(data), error };
}

async function writeScript(
  kind: "update" | "insert",
  payload: Record<string, unknown>,
  id?: string,
) {
  const row = stripUpdatedAt(payload);
  return kind === "update"
    ? supabase.from("scripts").update(row as any).eq("id", id!).select().single()
    : supabase.from("scripts").insert(row as any).select().single();
}

/**
 * Update the row that already has playwright_code, else the loaded id / any existing row, else insert once.
 * Never inserts a second row when a coded script already exists for the scenario.
 */
export async function persistCanonicalScript(
  scenarioId: string,
  payload: Record<string, unknown>,
  preferredId?: string | null,
) {
  const row = stripUpdatedAt({ ...payload, scenario_id: scenarioId });
  const { data: rows, error } = await fetchCanonicalScriptRows(scenarioId, "id, playwright_code, created_at");
  if (error) return { data: null, error };

  const coded = pickCanonicalScript(rows);
  const codedId = coded && scriptHasSavedCode(coded) ? (coded as any).id : null;
  const fallbackId = (newestCreatedFirst(rows)[0] as any)?.id || null;
  const targetId = codedId || preferredId || fallbackId || null;

  if (targetId) return writeScript("update", row, targetId);
  return writeScript("insert", row);
}

/**
 * Copy the canonical saved script onto a new scenario. New scripts.id; never reuse the source row.
 * Skips empty stubs. Throws if the source row cannot be read or the insert fails.
 */
export async function cloneCanonicalScript(
  sourceScenarioId: string,
  targetScenarioId: string,
  opts?: CloneScriptOpts,
) {
  const { data: rows, error } = await fetchCanonicalScriptRows(sourceScenarioId);
  if (error) throw new Error(error.message);
  const script = pickDuplicableScript(rows);
  if (!script) return { copied: false as const };

  const payload = buildClonedScriptInsert(script, targetScenarioId, opts);
  const { data, error: insErr } = await persistCanonicalScript(targetScenarioId, payload);
  if (insErr) throw new Error(insErr.message);
  return { copied: true as const, id: (data as any)?.id as string | undefined };
}

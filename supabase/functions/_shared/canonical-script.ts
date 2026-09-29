export function scriptHasSavedCode(row: { playwright_code?: string | null } | null | undefined) {
  return Boolean(String(row?.playwright_code || "").trim());
}

function createdAtMs(row: { created_at?: string | null } | null | undefined) {
  const t = Date.parse(String(row?.created_at || ""));
  return Number.isFinite(t) ? t : 0;
}

/** Newest created_at first. Hosted Postgres has no scripts.updated_at — do not infer last save from it. */
function newestCreatedFirst<T extends { created_at?: string | null }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => createdAtMs(b) - createdAtMs(a));
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
export function applyCanonicalScriptOrder(query: any) {
  return query.order("created_at", { ascending: false });
}

/**
 * Scenario-level shared script (not per-user). Queries filter only by scenario_id.
 * Among duplicates, a row with saved playwright_code beats an empty stub; then newest created_at.
 */
export async function fetchCanonicalScript(sb: any, scenarioId: string, columns = "*") {
  const cols = selectColumns(columns);
  const result = await applyCanonicalScriptOrder(
    sb.from("scripts").select(cols).eq("scenario_id", scenarioId),
  ).limit(25);
  return { data: pickCanonicalScript(result.data || []), error: result.error };
}

export async function updateScriptRow(sb: any, id: string, update: Record<string, unknown>) {
  return sb.from("scripts").update(stripUpdatedAt(update)).eq("id", id).select().single();
}

export async function insertScriptRow(sb: any, row: Record<string, unknown>) {
  return sb.from("scripts").insert(stripUpdatedAt(row)).select().single();
}

import { supabase } from "@/integrations/supabase/client";
import { deriveStoredResultStatus } from "./kpi-values";
import { combinationId, filterSignature, matchCombination, rowFilters } from "../../supabase/functions/_shared/combination-identity";

/**
 * Every result row (newest first) for the given scenarios. Pages through each
 * chunk: the Data API caps a request at 1,000 rows, and a few busy scenarios
 * could otherwise push other scenarios' newest results out of the window.
 */
export async function fetchAllResultsNewestFirst(scenarioIds: string[], columns: string): Promise<any[]> {
  const chunkSize = 40;
  const chunks: string[][] = [];
  const ids = [...new Set(scenarioIds)].sort();
  for (let i = 0; i < ids.length; i += chunkSize) chunks.push(ids.slice(i, i + chunkSize));
  const fetchChunk = async (chunk: string[]) => {
    const rows: any[] = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await supabase
        .from("test_results")
        .select(columns)
        .in("scenario_id", chunk)
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(offset, offset + 999);
      if (error) throw new Error(`Could not load latest results: ${error.message}`);
      rows.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    return rows;
  };
  const out: any[] = [];
  for (let i = 0; i < chunks.length; i += 6) {
    const pages = await Promise.all(chunks.slice(i, i + 6).map(fetchChunk));
    for (const rows of pages) out.push(...rows);
  }
  return out;
}

/** PostgREST caps a single request at 1000 rows. Fetch latest-per-scenario in chunks. */
export async function fetchLatestTestResultsByScenarioIds(
  scenarioIds: string[],
  columns: string,
): Promise<Map<string, any>> {
  const latest = new Map<string, any>();
  for (const r of await fetchAllResultsNewestFirst(scenarioIds, columns)) {
    const sid = (r as any).scenario_id as string;
    if (sid && !latest.has(sid)) latest.set(sid, r);
  }
  return latest;
}

/**
 * A scenario stores ONE test_results row per filter combination, so keeping only
 * the first row showed a single combo on the scenarios page while the Latest
 * result tab showed all four. Return every row belonging to the newest run.
 */
/** Combination label a test_results row belongs to ("" when the scenario has none). */
function comboKey(r: any): string {
  const id = combinationId(r);
  const signature = filterSignature(rowFilters(r));
  if (id) return `id:${id}`;
  if (signature && signature !== "[]") return `filters:${signature}`;
  const v = r?.actual?.filter ?? r?.expected?.filter ?? r?.actual?.combo ?? r?.expected?.combo;
  const s = String(v ?? "").trim();
  return s ? s.toLowerCase() : "__single__";
}

export async function fetchLatestRunResultsByScenarioIds(
  scenarioIds: string[],
  columns: string,
): Promise<Map<string, any[]>> {
  const byScenario = new Map<string, any[]>();
  for (const r of await fetchAllResultsNewestFirst(scenarioIds, columns)) {
    const sid = (r as any).scenario_id as string;
    if (!sid) continue;
    const list = byScenario.get(sid);
    if (list) list.push(r);
    else byScenario.set(sid, [r]);
  }
  // Keep the newest row PER COMBINATION, not per run. Re-running a single
  // combination from Latest result creates a new run holding just that one row,
  // so grouping by newest run_id would hide the other combinations.
  for (const [sid, rows] of byScenario) {
    const newestPerCombo = new Map<string, any>();
    for (const r of rows) {                 // already newest-first
      const key = comboKey(r);
      if (!newestPerCombo.has(key)) newestPerCombo.set(key, r);
    }
    byScenario.set(sid, Array.from(newestPerCombo.values()));
  }
  return byScenario;
}

/** Configured filter combinations per scenario (the list Latest result renders). */
export async function fetchFilterMatrixByScenarioIds(
  scenarioIds: string[],
): Promise<Map<string, any[]>> {
  const byScenario = new Map<string, any[]>();
  const chunkSize = 80;
  for (let i = 0; i < scenarioIds.length; i += chunkSize) {
    const chunk = scenarioIds.slice(i, i + chunkSize);
    if (!chunk.length) continue;
    const data: any[] = [];
    for (let offset = 0; ; offset += 1000) {
      const response = await supabase.from("scenario_filter_matrix")
        .select("id, scenario_id, label, filters, created_at").in("scenario_id", chunk)
        .order("created_at", { ascending: true }).order("id", { ascending: true }).range(offset, offset + 999);
      if (response.error) throw new Error(`Could not load filter combinations: ${response.error.message}`);
      data.push(...(response.data || []));
      if (!response.data || response.data.length < 1000) break;
    }
    for (const r of data || []) {
      const sid = (r as any).scenario_id as string;
      if (!sid) continue;
      const list = byScenario.get(sid);
      if (list) list.push(r); else byScenario.set(sid, [r]);
    }
  }
  return byScenario;
}

export function labelFromFilterMap(filters: any): string {
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) return "";
  const vals = Object.entries(filters)
    .filter(([key]) => key && !String(key).startsWith("__"))
    .map(([, value]) => {
      if (value == null) return "";
      if (typeof value === "object") {
        return String(
          (value as any).option ?? (value as any).verified ?? (value as any).value ?? "",
        ).trim();
      }
      return String(value).trim();
    })
    .filter(Boolean);
  return vals.length ? vals.join(" / ") : "";
}

/**
 * Pair each CONFIGURED combination with its latest stored result.
 * The scenarios page previously showed only combinations that had a row in
 * test_results, so a scenario with four combinations displayed one. Latest
 * result renders scenario_filter_matrix, which is why the two disagreed.
 */
export function pairCombosWithResults(combos: any[], results: any[]): any[] {
  if (!combos?.length) return (results || []).map(result => ({ label: null, result, provenance: { timestamp: result.created_at, runId: result.run_id, resultId: result.id } }));
  return combos.map((combo, idx) => {
    const result = matchCombination(combos, combo, results || []);
    return { label: combo.label || `Filter #${idx + 1}`, comboId: combo.id ?? null, result,
      provenance: result ? { timestamp: result.created_at, runId: result.run_id, resultId: result.id } : null };
  });
}

export function overallStatusFromComboPairs(
  pairs: Array<{ result: any | null }> | null | undefined,
  fallback: string = "pending",
): "pass" | "fail" | "pending" {
  const statuses = (pairs || []).map((pair) =>
    pair?.result ? deriveStoredResultStatus({ actual: pair.result.actual, expected: pair.result.expected, diff: pair.result.diff, fallbackStatus: pair.result.status }) : "pending"
  );
  if (statuses.some((status) => status === "fail")) return "fail";
  if (statuses.some((status) => status === "pending")) return "pending";
  if (statuses.length && statuses.every((status) => status === "pass")) return "pass";
  return fallback === "pass" || fallback === "fail" ? fallback : "pending";
}

/**
 * One case's overall outcome from its latest result per combination, re-checked
 * against the KPI rules. Dashboard and the Tests execution status page both use
 * this so a screen's pass/fail counts match wherever they are shown.
 */
export function latestScenarioStatus(
  rows: any[],
  combos: any[],
  spec: any,
  scenarioType?: string | null,
): "pass" | "fail" | "pending" {
  const derived = (rows || []).map((r) => ({
    ...r,
    status: deriveStoredResultStatus({
      actual: r.actual, expected: r.expected, diff: r.diff, spec,
      scenarioType: scenarioType || undefined, fallbackStatus: r.status,
    }),
  }));
  return overallStatusFromComboPairs(
    pairCombosWithResults(combos || [], derived),
    derived[0]?.status || "pending",
  );
}

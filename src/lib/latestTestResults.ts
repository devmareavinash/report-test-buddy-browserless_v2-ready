import { supabase } from "@/integrations/supabase/client";

/** PostgREST caps a single request at 1000 rows. Fetch latest-per-scenario in chunks. */
export async function fetchLatestTestResultsByScenarioIds(
  scenarioIds: string[],
  columns: string,
): Promise<Map<string, any>> {
  const latest = new Map<string, any>();
  const chunkSize = 80;
  for (let i = 0; i < scenarioIds.length; i += chunkSize) {
    const chunk = scenarioIds.slice(i, i + chunkSize);
    if (!chunk.length) continue;
    const { data } = await supabase
      .from("test_results")
      .select(columns)
      .in("scenario_id", chunk)
      .order("created_at", { ascending: false })
      .limit(1000);
    for (const r of data || []) {
      const sid = (r as any).scenario_id as string;
      if (sid && !latest.has(sid)) latest.set(sid, r);
    }
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
  const v = r?.actual?.filter ?? r?.expected?.filter ?? r?.actual?.combo ?? r?.expected?.combo;
  const s = String(v ?? "").trim();
  return s ? s.toLowerCase() : "__single__";
}

export async function fetchLatestRunResultsByScenarioIds(
  scenarioIds: string[],
  columns: string,
): Promise<Map<string, any[]>> {
  const byScenario = new Map<string, any[]>();
  const chunkSize = 80;
  for (let i = 0; i < scenarioIds.length; i += chunkSize) {
    const chunk = scenarioIds.slice(i, i + chunkSize);
    if (!chunk.length) continue;
    const { data } = await supabase
      .from("test_results")
      .select(columns)
      .in("scenario_id", chunk)
      .order("created_at", { ascending: false })
      .limit(1000);
    for (const r of data || []) {
      const sid = (r as any).scenario_id as string;
      if (!sid) continue;
      const list = byScenario.get(sid);
      if (list) list.push(r);
      else byScenario.set(sid, [r]);
    }
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
    const { data } = await supabase
      .from("scenario_filter_matrix")
      .select("id, scenario_id, label, filters, created_at")
      .in("scenario_id", chunk)
      .order("created_at", { ascending: true })
      .limit(1000);
    for (const r of data || []) {
      const sid = (r as any).scenario_id as string;
      if (!sid) continue;
      const list = byScenario.get(sid);
      if (list) list.push(r); else byScenario.set(sid, [r]);
    }
  }
  return byScenario;
}

/**
 * Pair each CONFIGURED combination with its latest stored result.
 * The scenarios page previously showed only combinations that had a row in
 * test_results, so a scenario with four combinations displayed one. Latest
 * result renders scenario_filter_matrix, which is why the two disagreed.
 */
export function pairCombosWithResults(combos: any[], results: any[]): any[] {
  const norm = (v: any) => String(v ?? "").trim().toLowerCase();
  const pool = (results || []).slice();
  const keyOf = (r: any) =>
    norm(r?.actual?.filter ?? r?.expected?.filter ?? r?.actual?.combo ?? r?.expected?.combo);
  if (!combos || !combos.length) {
    return pool.map((r) => ({ label: keyOf(r) || null, result: r }));
  }
  return combos.map((c: any, idx: number) => {
    const label = c?.label || `Filter #${idx + 1}`;
    const aliases = [label, `combo_${idx + 1}`, `Filter #${idx + 1}`].map(norm);
    let hit = pool.findIndex((r) => aliases.includes(keyOf(r)));
    if (hit === -1 && combos.length === 1 && pool.length === 1) hit = 0;
    const result = hit >= 0 ? pool.splice(hit, 1)[0] : null;
    return { label, comboId: c?.id ?? null, result };
  });
}

export function overallStatusFromComboPairs(
  pairs: Array<{ result: any | null }> | null | undefined,
  fallback: string = "pending",
): "pass" | "fail" | "pending" {
  const statuses = (pairs || []).map((pair) =>
    String(pair?.result?.status || "pending").toLowerCase()
  );
  if (statuses.some((status) => status === "fail")) return "fail";
  if (statuses.some((status) => status === "pending")) return "pending";
  if (statuses.length && statuses.every((status) => status === "pass")) return "pass";
  return fallback === "pass" || fallback === "fail" ? fallback : "pending";
}

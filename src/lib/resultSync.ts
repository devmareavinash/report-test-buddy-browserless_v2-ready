import { deriveStoredResultStatus } from "./kpi-values";
import { deriveExecutionOutcome, outcomeCounts } from "../../supabase/functions/_shared/execution-status";
import { matchCombination } from "../../supabase/functions/_shared/combination-identity";

/** Replace only explicitly executed sides; tolerance-only Sync keeps same-run evidence. */
export function buildSyncRows(runId: string, scenarioId: string, combos: any[], live: any[], snapshot: any, previousRows: any[] = []) {
  return (combos.length ? combos : [{ id: null, filters: {} }]).flatMap((combo) => {
    const incoming = live.find(item => item.combo?.id === combo.id) || (combos.length ? null : live[0]);
    const previous = combos.length ? matchCombination(combos, combo, previousRows) : previousRows[0];
    const actualUpdated = incoming?.actualUpdated ?? !!(incoming?.actualEvidence || Object.keys(incoming?.actualMap || {}).length);
    const expectedUpdated = incoming?.expectedUpdated ?? !!(incoming?.expectedEvidence || Object.keys(incoming?.expectedMap || {}).length);
    if (!previous && !actualUpdated && !expectedUpdated) return [];
    const identity = { combo_id: combo.id, filter: combo.label || null, requested_filters: combo.filters || {} };
    const actual = actualUpdated
      ? { ...(incoming?.actualEvidence || {}), ...identity, values: incoming?.actualMap || {}, tolerances_snapshot: snapshot }
      : { ...(previous?.actual || {}), tolerances_snapshot: snapshot };
    const expected = expectedUpdated
      ? { ...(incoming?.expectedEvidence || {}), ...identity, values: incoming?.expectedMap || {} }
      : previous?.expected || {};
    const diff = actualUpdated || expectedUpdated ? null : previous?.diff ?? null;
    const status = deriveStoredResultStatus({ actual, expected, diff, spec: { kpi_tolerances: snapshot }, fallbackStatus: actualUpdated || expectedUpdated ? incoming?.status || "pending" : previous?.status || "pending" });
    return [{ run_id: runId, scenario_id: scenarioId, actual, expected, status, diff, analysis: "Updated from explicit Sync" }];
  });
}
export function summarizeResultRows(rows: any[], expectedUnits: number = rows.length) {
  const outcomes = rows.map(row => deriveExecutionOutcome(row, deriveStoredResultStatus({ actual: row.actual, expected: row.expected, diff: row.diff, fallbackStatus: row.status })));
  while (outcomes.length < expectedUnits) outcomes.push("pending");
  const summary = outcomeCounts(outcomes);
  const status = summary.pending ? "running" : summary.cancelled ? "cancelled" : summary.fail ? "failed" : "completed";
  return { summary, status };
}
export async function syncScenarioResults(db: any, run: any, scenarioId: string, combos: any[], live: any[], snapshot: any) {
  if (["running", "cancelled"].includes(run.status)) throw new Error("Cannot Sync an active or cancelled run");
  const previousRows: any[] = [];
  for (let offset = 0; ; offset += 1000) {
    const read = await db.from("test_results").select("id,actual,expected,status,diff,created_at").eq("run_id", run.id).eq("scenario_id", scenarioId).order("created_at", { ascending: false }).order("id").range(offset, offset + 999);
    if (read.error) throw read.error;
    previousRows.push(...(read.data || []));
    if (!read.data || read.data.length < 1000) break;
  }
  const next = buildSyncRows(run.id, scenarioId, combos, live, snapshot, previousRows);
  for (let index = 0; index < next.length; index++) {
    const combo = combos.find(item => item.id === next[index].actual.combo_id);
    const previous = combos.length && combo ? matchCombination(combos, combo, previousRows) : combos.length ? null : previousRows[0];
    const result = previous ? await db.from("test_results").update(next[index]).eq("id", previous.id) : await db.from("test_results").insert(next[index]);
    if (result.error) throw result.error;
  }
  const all: any[] = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await db.from("test_results").select("id,scenario_id,actual,expected,status,diff").eq("run_id", run.id).order("id").range(offset, offset + 999);
    if (page.error) throw page.error;
    all.push(...(page.data || []));
    if (!page.data || page.data.length < 1000) break;
  }
  const { summary, status } = summarizeResultRows(all, Math.max(all.length, Number(run.summary?.total || 0)));
  const update = await db.from("runs").update({ status, summary: { ...run.summary, ...summary }, finished_at: status === "running" ? null : new Date().toISOString() })
    .eq("id", run.id).eq("status", run.status).filter("summary", "eq", JSON.stringify(run.summary || {})).select("id");
  if (update.error) throw update.error;
  if (!update.data?.length) throw new Error("Run changed during Sync; refresh before retrying");
  return summary;
}
import { describe, expect, it } from "vitest";
import { matchCombination } from "../../supabase/functions/_shared/combination-identity";
import { deriveExecutionOutcome, executionErrors, outcomeCounts } from "../../supabase/functions/_shared/execution-status";
import { deriveStoredResultRows } from "./kpi-values";
import { buildSyncRows, summarizeResultRows, syncScenarioResults } from "./resultSync";

describe("strict combination evidence", () => {
  it("keeps West missing when only East exists", () => {
    const combo = { id: "west", label: "West", filters: { Region: "West" } };
    expect(matchCombination([combo], combo, [{ actual: { filter: "East", values: { Revenue: 100 } } }])).toBeNull();
  });
  it("does not attach A/B to missing C", () => {
    const combo = { id: "c", label: "C" };
    expect(matchCombination([combo], combo, [{ actual: { filter: "A" } }, { actual: { filter: "B" } }])).toBeNull();
  });
  it("distinguishes Region East and Territory East", () => {
    const combos = [{ id: "r", label: "East", filters: { Region: "East" } }, { id: "t", label: "East", filters: { Territory: "East" } }];
    const row = { actual: { filters_applied: { Region: "East" }, values: { Revenue: 100 } } };
    expect(matchCombination(combos, combos[0], [row])).toBe(row);
    expect(matchCombination(combos, combos[1], [row])).toBeNull();
  });
  it("keeps a newer failed identity row rather than older success", () => {
    const combo = { id: "c", filters: { Region: "West" } };
    const rows = [{ id: "new", created_at: "2026-11-12", actual: { combo_id: "c", values: {} }, status: "fail" }, { id: "old", created_at: "2026-11-01", actual: { combo_id: "c", values: { Revenue: 100 } } }];
    expect(matchCombination([combo], combo, rows)?.id).toBe("new");
  });
  it("rejects ambiguous legacy labels", () => {
    const combos = [{ id: "a", label: "East" }, { id: "b", label: "East" }];
    expect(matchCombination(combos, combos[0], [{ actual: { filter: "East" } }])).toBeNull();
  });
  it("does not hydrate old snapshot values after a newer unidentified failed execution", () => {
    const combo = { id: "c", filters: { Region: "West" } };
    const rows = [{ id: "new", created_at: "2026-11-12", status: "fail", actual: { values: {} } }, { id: "old", created_at: "2026-11-01", actual: { filters_applied: { Region: "West" }, values: { Revenue: 100 } } }];
    expect(matchCombination([combo], combo, rows)).toBeNull();
  });
  it("retains independent timestamps and provenance for untouched combinations", () => {
    const combos = [{ id: "a" }, { id: "b" }];
    const rows = [{ id: "r-a", run_id: "new-run", created_at: "2026-11-12", actual: { combo_id: "a" } }, { id: "r-b", run_id: "old-run", created_at: "2026-11-01", actual: { combo_id: "b" } }];
    expect(combos.map(combo => matchCombination(combos, combo, rows)?.created_at)).toEqual(["2026-11-12", "2026-11-01"]);
    expect(combos.map(combo => matchCombination(combos, combo, rows)?.run_id)).toEqual(["new-run", "old-run"]);
  });
});
describe("execution status precedence and partial values", () => {
  it.each(["auth_failure", "partial_extraction", "browserless_timeout", "cancelled", "pending"])("matching Revenue cannot erase %s", status => {
    const result = deriveStoredResultRows({ actual: { values: { Revenue: 100 } }, expected: { values: { Revenue: 100 } }, fallbackStatus: status });
    expect(result.status).not.toBe("pass");
    expect(result.rows[0].a).toBe(100);
  });
  it("navigation error with empty values cannot pass", () => {
    expect(deriveStoredResultRows({ actual: { error: "View My HCO List did not open", values: {} }, expected: {}, fallbackStatus: "pass" }).status).toBe("fail");
  });
  it("preserves partial Revenue with the original error", () => {
    const actual = { error: "extraction interrupted", values: { Revenue: 100 } };
    const result = deriveStoredResultRows({ actual, expected: { values: { Revenue: 100 } }, fallbackStatus: "partial_extraction" });
    expect(result.rows[0]).toMatchObject({ a: 100, e: 100 });
    expect(result.status).toBe("fail");
    expect(actual.error).toBe("extraction interrupted");
  });
  it("inspects nested errors with cycle protection", () => {
    const node: any = { group: { result: { error: "navigation failed", Revenue: 100 } } }; node.self = node;
    expect(executionErrors(node)).toEqual(["navigation failed"]);
    expect(deriveExecutionOutcome({ actual: node, status: "pass" }, "pass")).toBe("execution_failed");
  });
});
describe("Sync and accounting", () => {
  it("does not silently reuse old Actual on null incoming values", () => {
    const rows = buildSyncRows("run", "scenario", [{ id: "c" }], [{ combo: { id: "c" }, actualMap: { Revenue: null }, expectedMap: { Revenue: 100 }, status: "pending" }], { Revenue: 0 });
    expect(rows[0].actual.values.Revenue).toBeNull();
    expect(rows[0].status).not.toBe("pass");
  });
  it("accounts for missing combinations and keeps the run active", () => {
    const rows = buildSyncRows("run", "scenario", [{ id: "a" }, { id: "b" }], [{ combo: { id: "a" }, actualUpdated: true }, { combo: { id: "b" }, actualUpdated: true }], {});
    expect(rows).toHaveLength(2);
    expect(summarizeResultRows(rows).status).toBe("running");
  });
  it("all component counts reconcile", () => {
    const counts = outcomeCounts(["passed", "comparison_failed", "execution_failed", "partial", "cancelled", "pending"]);
    expect(counts).toMatchObject({ passed: 1, comparison_failed: 1, execution_failed: 1, partial: 1, cancelled: 1, pending: 1, total: 6 });
  });
  it("active Sync inserts unmatched combinations and retains pending totals", async () => {
    const rows: any[] = [];
    let runPatch: any;
    const db = { from: (table: string) => {
      let mode = "read";
      const query: any = { select: () => query, eq: () => query, order: () => query, range: () => query, filter: () => query,
        insert: (row: any) => { rows.push({ ...row, id: String(rows.length) }); mode = "write"; return query; },
        update: (patch: any) => { runPatch = patch; mode = "write"; return query; },
        then: (resolve: any) => resolve({ data: table === "runs" ? [{ id: "run" }] : mode === "read" ? rows : null, error: null }) };
      return query;
    } };
    await syncScenarioResults(db, { id: "run", status: "completed", summary: { total: 2 } }, "scenario", [{ id: "a" }, { id: "b" }], [{ combo: { id: "a" }, actualUpdated: true }, { combo: { id: "b" }, actualUpdated: true }], {});
    expect(rows.map(row => row.actual.combo_id)).toEqual(["a", "b"]);
    expect(runPatch).toMatchObject({ status: "running", summary: { pending: 2, total: 2 } });
  });
});
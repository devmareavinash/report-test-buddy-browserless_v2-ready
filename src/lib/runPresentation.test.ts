import { describe, expect, it } from "vitest";
import { countRunCases, deriveRunResults, matchesRunOutcome, presentedRunStatus } from "./runPresentation";

const scenarioId = "a953d970-10a1-4518-a968-280e6a2b8930";
const values = {
  "New Writer Flag": { columns: ["Option", "Present"], rows: [["All", 1], ["N", 1], ["Y", 1]] },
  "Re-dos Segment": { columns: ["Option", "Present"], rows: [["All", 1], ["High Doser", 1], ["Low Doser", 1], ["NA", 1], ["ReDOSer", 1]] },
  Specialty: { columns: ["Option", "Present"], rows: [["Search Account Name", 1]] },
  Target: { columns: ["Option", "Present"], rows: [["Search Account Name", 1]] },
};
const row = { scenario_id: scenarioId, status: "fail", scenarios: { type: "reference_match" }, actual: { values }, expected: { values }, diff: null };
const specs = { [scenarioId]: { kpis: Object.keys(values), kpi_tolerances: Object.fromEntries(Object.keys(values).map((key) => [key, { op: "eq", unit: "pct", value: 0 }])) } };
const run = { status: "failed", summary: { pass: 0, fail: 1, total: 1, source: "reference_script" } };

describe("consistent run presentation", () => {
  it("shows run 8b906376 as one pass in both views despite its saved failure", () => {
    const results = deriveRunResults([row], specs);
    const counts = countRunCases(results);
    expect(results[0].derivedStatus).toBe("pass");
    expect(counts).toEqual({ pass: 1, fail: 0, pending: 0, total: 1 });
    expect(presentedRunStatus(run, counts)).toBe("completed");
    expect(matchesRunOutcome(run, counts, "pass")).toBe(true);
    expect(matchesRunOutcome(run, counts, "fail")).toBe(false);
  });
  it("keeps a genuine mismatch failed across counts, badge and filters", () => {
    const counts = countRunCases(deriveRunResults([{ ...row, actual: { values: { ...values, Target: { columns: ["Option", "Present"], rows: [["Different", 1]] } } } }], specs));
    expect(counts.fail).toBe(1);
    expect(presentedRunStatus(run, counts)).toBe("failed");
    expect(matchesRunOutcome(run, counts, "fail")).toBe(true);
    expect(matchesRunOutcome(run, counts, "pass")).toBe(false);
  });
  it("never hides a report finalization failure behind passing comparisons", () => {
    const counts = countRunCases(deriveRunResults([row], specs));
    expect(presentedRunStatus({ ...run, summary: { ...run.summary, reports: { report: { status: "error" } } } }, counts)).toBe("failed");
    expect(presentedRunStatus({ ...run, summary: { error: "Failed to save" } }, counts)).toBe("failed");
  });
  it("preserves running and cancelled states even with failed results", () => {
    const counts = { pass: 0, fail: 1, pending: 0, total: 1 };
    expect(presentedRunStatus({ status: "running" }, counts)).toBe("running");
    expect(presentedRunStatus({ status: "cancelled" }, counts)).toBe("cancelled");
  });
  it("counts combinations once and preserves failure precedence", () => {
    expect(countRunCases([{ scenario_id: scenarioId, derivedStatus: "pass" }, { scenario_id: scenarioId, derivedStatus: "fail" }])).toEqual({ pass: 0, fail: 1, pending: 0, total: 1 });
  });
});
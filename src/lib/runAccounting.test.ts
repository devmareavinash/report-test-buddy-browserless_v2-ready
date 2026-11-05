import { describe, expect, it } from "vitest";
import {
  brandLifecycleFromAccounting,
  collapseScenarioStatuses,
  countAccountedCases,
  mergeExpectedCaseStatuses,
  missingScenarioStubStatus,
} from "./runAccounting";

describe("run accounting invariant", () => {
  it("A: 44 all pass → 44 terminal, 0 pending/unexecuted", () => {
    const existing = new Map(
      Array.from({ length: 44 }, (_, i) => [`s${i}`, "pass" as const]),
    );
    const merged = mergeExpectedCaseStatuses(
      existing,
      Array.from({ length: 44 }, (_, i) => `s${i}`),
      "completed",
    );
    const c = countAccountedCases(merged.values());
    expect(c).toEqual({ pass: 44, fail: 0, pending: 0, not_executed: 0, total: 44 });
    expect(c.total).toBe(c.pass + c.fail + c.pending + c.not_executed);
    expect(brandLifecycleFromAccounting("completed", c)).toBe("completed");
  });

  it("B: scenario 5 fails, rest pass → overall FAIL, 0 pending", () => {
    const ids = Array.from({ length: 44 }, (_, i) => `s${i}`);
    const existing = new Map(ids.map((id, i) => [id, i === 4 ? "fail" as const : "pass" as const]));
    const c = countAccountedCases(mergeExpectedCaseStatuses(existing, ids, "failed").values());
    expect(c).toEqual({ pass: 43, fail: 1, pending: 0, not_executed: 0, total: 44 });
    expect(brandLifecycleFromAccounting("failed", c)).toBe("failed");
  });

  it("C: multiple extraction failures still account all 44", () => {
    const ids = Array.from({ length: 44 }, (_, i) => `s${i}`);
    const existing = new Map(
      ids.map((id, i) => [id, i % 7 === 0 ? "fail" as const : "pass" as const]),
    );
    const c = countAccountedCases(mergeExpectedCaseStatuses(existing, ids, "failed").values());
    expect(c.total).toBe(44);
    expect(c.pass + c.fail).toBe(44);
    expect(c.pending + c.not_executed).toBe(0);
  });

  it("D: Browserless stop after 16 → 16 terminal + 28 not_executed, not 0 pending", () => {
    const ids = Array.from({ length: 44 }, (_, i) => `s${i}`);
    const existing = new Map(
      ids.slice(0, 16).map((id, i) => [id, i < 13 ? "pass" as const : "fail" as const]),
    );
    const merged = mergeExpectedCaseStatuses(existing, ids, "failed", {
      failure_category: "browserless_timeout",
    });
    const c = countAccountedCases(merged.values());
    expect(c.pass).toBe(13);
    expect(c.fail).toBe(3);
    expect(c.pending).toBe(0);
    expect(c.not_executed).toBe(28);
    expect(c.total).toBe(44);
    expect(c.pass + c.fail + c.not_executed).toBe(44);
    expect(brandLifecycleFromAccounting("failed", c, { failure_category: "browserless_timeout" })).toBe("failed");
  });

  it("E: user cancel after 16 → cancelled lifecycle, 28 not executed", () => {
    const ids = Array.from({ length: 44 }, (_, i) => `s${i}`);
    const existing = new Map(ids.slice(0, 16).map((id) => [id, "pass" as const]));
    const merged = mergeExpectedCaseStatuses(existing, ids, "cancelled");
    const c = countAccountedCases(merged.values());
    expect(c.not_executed).toBe(28);
    expect(c.total).toBe(44);
    expect(brandLifecycleFromAccounting("cancelled", c)).toBe("cancelled");
    expect(missingScenarioStubStatus("cancelled")).toBe("cancelled");
  });

  it("F: partial child cannot look fully accounted", () => {
    const ids = Array.from({ length: 10 }, (_, i) => `s${i}`);
    const existing = new Map(ids.slice(0, 3).map((id) => [id, "pass" as const]));
    const c = countAccountedCases(mergeExpectedCaseStatuses(existing, ids, "failed").values());
    expect(c.total).toBe(10);
    expect(c.not_executed).toBe(7);
    expect(brandLifecycleFromAccounting("completed", c)).toBe("failed");
  });

  it("G: six-screen Brand reconciles every expected screen scenario", () => {
    // 6 reports × uneven scenario counts = 44
    const perReport = [3, 5, 1, 8, 2, 25];
    expect(perReport.reduce((a, b) => a + b, 0)).toBe(44);
    const ids: string[] = [];
    perReport.forEach((n, ri) => {
      for (let i = 0; i < n; i++) ids.push(`r${ri}-s${i}`);
    });
    // Only first 3 reports fully done
    const done = perReport.slice(0, 3).reduce((a, b) => a + b, 0);
    const existing = new Map(ids.slice(0, done).map((id) => [id, "pass" as const]));
    const c = countAccountedCases(mergeExpectedCaseStatuses(existing, ids, "failed").values());
    expect(c.total).toBe(44);
    expect(c.pass + c.not_executed).toBe(44);
  });

  it("H: multi-combo scenario collapses to one case", () => {
    expect(collapseScenarioStatuses(["pass", "pass", "fail"])).toBe("fail");
    expect(collapseScenarioStatuses(["pass", "pass"])).toBe("pass");
    expect(collapseScenarioStatuses(["pass", "pending"])).toBe("pending");
  });

  it("finished runs still surface missing scenarios (UI regression)", () => {
    const ids = Array.from({ length: 44 }, (_, i) => `s${i}`);
    const existing = new Map(ids.slice(0, 16).map((id) => [id, "pass" as const]));
    // Bug was: only inject when running → total 16, pending 0
    const c = countAccountedCases(mergeExpectedCaseStatuses(existing, ids, "failed").values());
    expect(c.total).not.toBe(16);
    expect(c.total).toBe(44);
    expect(c.not_executed).toBe(28);
    expect(c.pending).toBe(0);
  });
});

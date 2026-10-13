import { describe, expect, it } from "vitest";
import { overallStatusFromComboPairs, pairCombosWithResults } from "./latestTestResults";

describe("pairCombosWithResults", () => {
  it("keeps configured combinations visible when only one combination has a result", () => {
    const combos = [
      { id: "combo-a", label: "East" },
      { id: "combo-b", label: "West" },
    ];
    const results = [
      { id: "result-a", actual: { filter: "East" }, status: "pass" },
    ];

    const paired = pairCombosWithResults(combos, results);

    expect(paired).toHaveLength(2);
    expect(paired[0].result?.id).toBe("result-a");
    expect(paired[1].result).toBeNull();
  });

  describe("overallStatusFromComboPairs", () => {
    it("fails when any configured combination fails", () => {
      expect(overallStatusFromComboPairs([
        { result: { status: "pass" } },
        { result: { status: "fail" } },
      ])).toBe("fail");
    });

    it("stays pending while a configured combination has no result", () => {
      expect(overallStatusFromComboPairs([
        { result: { status: "pass" } },
        { result: null },
      ])).toBe("pending");
    });
  });

  it("matches one configured combination to one stored result even when labels are absent", () => {
    const paired = pairCombosWithResults(
      [{ id: "combo-a", label: "Only combo" }],
      [{ id: "result-a", actual: {}, expected: {}, status: "pass" }],
    );

    expect(paired[0].result?.id).toBe("result-a");
  });

  it("pairs an unlabeled combination with combo_1 instead of an older unlabeled result", () => {
    const paired = pairCombosWithResults(
      [{ id: "c1", label: null }],
      [
        {
          id: "today",
          created_at: "2026-10-13T08:31:23.000Z",
          status: "fail",
          actual: { filter: "combo_1", values: { BHID: null, "Physician Name": null } },
        },
        {
          id: "old",
          created_at: "2026-09-25T13:11:52.000Z",
          status: "fail",
          actual: { values: { BHID: "BH10854690", "Physician Name": "Waqar H Ahmed" } },
        },
      ],
    );

    expect(paired[0].result?.id).toBe("today");
  });
});

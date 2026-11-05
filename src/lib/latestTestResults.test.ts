import { describe, expect, it } from "vitest";
import { displayComboLabel, overallStatusFromComboPairs, pairCombosWithResults } from "./latestTestResults";

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

  it("shows filter values instead of Filter #1 when the combo label is empty", () => {
    const paired = pairCombosWithResults(
      [{
        id: "c1",
        label: null,
        filters: {
          Area: "Total",
          Region: "AA52 - Northeast",
          Territory: "Total",
          "Time Bucket": "R4W",
        },
      }],
      [{
        id: "result-a",
        status: "pass",
        actual: { filter: "combo_1", values: { "NBRx Total": 1 } },
      }],
    );

    expect(paired[0].label).toBe("Total / AA52 - Northeast / Total / R4W");
    expect(paired[0].result?.id).toBe("result-a");
  });

  it("prefers stored result filter text when filters map is empty", () => {
    expect(displayComboLabel(
      { id: "c1", label: null, filters: {} },
      0,
      { actual: { filter: "AB - Central / Total / Total / QTD" } },
    )).toBe("AB - Central / Total / Total / QTD");
  });

  it("uses current filter values even when the stored label is stale", () => {
    expect(displayComboLabel(
      {
        id: "c1",
        label: "Total / Total / Total / Latest Week",
        filters: {
          Area: "Total",
          Region: "Total",
          Territory: "Total",
          "Time Bucket": "R4W",
        },
      },
      0,
    )).toBe("Total / Total / Total / R4W");
  });

  describe("overallStatusFromComboPairs", () => {
    it("fails when any configured combination fails", () => {
      expect(overallStatusFromComboPairs([
        { result: { status: "pass" } },
        { result: { status: "fail" } },
      ])).toBe("fail");
    });

    it("treats auth_failure and partial_extraction as terminal fail", () => {
      expect(overallStatusFromComboPairs([
        { result: { status: "pass" } },
        { result: { status: "auth_failure" } },
      ])).toBe("fail");
      expect(overallStatusFromComboPairs([
        { result: { status: "partial_extraction" } },
      ])).toBe("fail");
      expect(overallStatusFromComboPairs([
        { result: { status: "browserless_timeout" } },
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

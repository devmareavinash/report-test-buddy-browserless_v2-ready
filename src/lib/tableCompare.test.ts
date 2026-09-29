import { describe, expect, it } from "vitest";
import { compareTables } from "./tableCompare";

describe("compareTables", () => {
  it("passes a reference comparison when every actual value is less than or equal to reference", () => {
    const actual = {
      columns: ["Segment", "Current Time Period", "Previous Time Period"],
      rows: [
        ["A_HP_W", "491.3", "614.0"],
        ["B_HP_NW", "86.8", "78.9"],
      ],
    };
    const expected = {
      columns: ["Segment", "Current Time Period", "Previous Time Period"],
      rows: [
        ["A_HP_W", "533.9", "614.0"],
        ["B_HP_NW", "98.4", "78.9"],
      ],
    };

    const result = compareTables(
      actual,
      expected,
      { value: 0, unit: "pct", op: "lte" },
    );

    expect(result.pass).toBe(true);
    expect(result.failedCells).toEqual([]);
    expect(result.comparedCells).toBe(4);
  });

  it("fails when an expected metric column is absent from actual", () => {
    const actual = {
      columns: ["Segment", "Sales"],
      rows: [["A", "10"]],
    };
    const expected = {
      columns: ["Segment", "Sales", "Profit"],
      rows: [["A", "10", "5"]],
    };

    const result = compareTables(
      actual,
      expected,
      { value: 0, unit: "pct", op: "eq" },
    );

    expect(result.pass).toBe(false);
    expect(result.missingExpectedColumns).toEqual(["Profit"]);
  });
});

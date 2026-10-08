import { describe, expect, it } from "vitest";
import { alignComparedTableColumns } from "./KpiGrid";

describe("alignComparedTableColumns", () => {
  it("renders actual and reference grids in the reference column order", () => {
    const actual = {
      columns: ["Area", "Nrx Total", "Employee Name", "Nbrx Breadth (%)"],
      rows: [["AB - Central", 0, "N/A", "-"]],
    };
    const expected = {
      columns: ["Area", "Employee Name", "Nrx Total", "Total Calls"],
      rows: [["AB - Central", "N/A", 0, "2,986"]],
    };

    const aligned = alignComparedTableColumns(actual, expected);

    expect(aligned.actual.columns).toEqual([
      "Area",
      "Employee Name",
      "Nrx Total",
      "Total Calls",
      "Nbrx Breadth (%)",
    ]);
    expect(aligned.expected.columns).toEqual(aligned.actual.columns);
    expect(aligned.actual.rows[0]).toEqual(["AB - Central", "N/A", 0, "", "-"]);
    expect(aligned.expected.rows[0]).toEqual(["AB - Central", "N/A", 0, "2,986", ""]);
  });
});

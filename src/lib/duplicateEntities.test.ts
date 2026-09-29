import { describe, expect, it } from "vitest";
import { copyTitle, remapOrNull } from "./duplicateEntities";
import {
  deleteReportConfirm,
  deleteScenarioConfirm,
  deleteWorkstreamConfirm,
} from "./deleteEntities";

describe("copyTitle", () => {
  it("appends (copy) and does not stack the suffix", () => {
    expect(copyTitle("Quarterly")).toBe("Quarterly (copy)");
    expect(copyTitle("Quarterly (copy)")).toBe("Quarterly (copy)");
  });
});

describe("remapOrNull", () => {
  it("maps copied child ids and drops dangling pointers", () => {
    const map = new Map([["old-prerun", "new-prerun"]]);
    expect(remapOrNull("old-prerun", map)).toBe("new-prerun");
    expect(remapOrNull("missing", map)).toBeNull();
    expect(remapOrNull(null, map)).toBeNull();
  });
});

describe("delete confirm copy", () => {
  it("warns that inner cases, scripts, and mappings are removed", () => {
    expect(deleteScenarioConfirm("Quarterly")).toMatch(/saved script/i);
    expect(deleteScenarioConfirm("Quarterly")).toMatch(/filter combinations/i);
    expect(deleteReportConfirm("Overview")).toMatch(/FE ↔ BE mappings/);
    expect(deleteReportConfirm("Overview")).toMatch(/test cases/);
    expect(deleteWorkstreamConfirm("Kerendia")).toMatch(/all screens/);
    expect(deleteWorkstreamConfirm("Kerendia")).toMatch(/cannot be undone/i);
  });
});

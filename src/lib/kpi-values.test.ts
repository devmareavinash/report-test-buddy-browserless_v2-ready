import { describe, expect, it } from "vitest";
import { isKpiValueNoise, lookupStoredKpiValue, unwrapStoredValues } from "./kpi-values";

describe("lookupStoredKpiValue", () => {
  it("uses a legacy Row Count KPI when the configured KPI is Count", () => {
    const values = {
      "Row Count - View My HCO List": 3174,
    };

    expect(lookupStoredKpiValue(values, "Count")).toBe(3174);
  });

  it("does not guess when multiple legacy row-count KPIs are present", () => {
    const values = {
      "Row Count - A": 10,
      "Row Count - B": 20,
    };

    expect(lookupStoredKpiValue(values, "Count")).toBeUndefined();
  });

  it("filters KPI-suffixed grid readiness metadata", () => {
    const key = "Row Count - Which accounts are purchasing Kerendia for first time?_grid_ready";

    expect(isKpiValueNoise(key)).toBe(true);
    expect(unwrapStoredValues({
      values: {
        "Row Count - Which accounts are purchasing Kerendia for first time?": 7,
        [key]: true,
      },
    })).toEqual({
      "Row Count - Which accounts are purchasing Kerendia for first time?": 7,
    });
  });
});

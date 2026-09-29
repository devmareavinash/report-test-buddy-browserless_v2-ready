import { describe, expect, it } from "vitest";
import { configuredKpiNames, deriveStoredResultStatus, isKpiValueNoise, lookupStoredKpiValue, resolveKpiTol, storedKpiSpec, storedKpiTolerances, unwrapStoredValues } from "./kpi-values";

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

  it("matches KPI names while ignoring case and punctuation", () => {
    expect(lookupStoredKpiValue({ nbrx_total: 42 }, "NBRx Total")).toBe(42);
  });
});

describe("stored KPI tolerances", () => {
  it("prefers the saved run snapshot over current scenario tolerances", () => {
    const actual = {
      tolerances_snapshot: {
        "Old KPI": { value: 5, unit: "pct", op: "lte" },
      },
    };
    const spec = {
      kpi_tolerances: {
        "New KPI": { value: 1, unit: "abs", op: "gte" },
      },
    };

    expect(storedKpiTolerances(actual, spec)).toEqual(actual.tolerances_snapshot);
    expect(configuredKpiNames(storedKpiSpec(actual, spec))).toEqual(["Old KPI"]);
  });

  it("falls back to current scenario tolerances when no snapshot exists", () => {
    const spec = {
      kpi_tolerances: {
        "Current KPI": { value: 2, unit: "pct", op: "eq" },
      },
    };

    expect(storedKpiTolerances({}, spec)).toEqual(spec.kpi_tolerances);
    expect(configuredKpiNames(storedKpiSpec({}, spec))).toEqual(["Current KPI"]);
  });

  it("uses each KPI's own comparison operator", () => {
    const tols = {
      A: { value: 0, unit: "pct", op: "lte" },
      B: { value: 0, unit: "pct", op: "gte" },
    };

    expect(resolveKpiTol(tols, "A").op).toBe("lte");
    expect(resolveKpiTol(tols, "B").op).toBe("gte");
  });
});

describe("deriveStoredResultStatus", () => {
  it("derives pass from stored values even when the persisted row status is stale fail", () => {
    expect(deriveStoredResultStatus({
      actual: {
        values: { Count: 3178, area: "East", time_bucket: "QTD" },
        tolerances_snapshot: { Count: { value: 0, unit: "pct", op: "eq" } },
      },
      expected: { values: { Count: 3178 } },
      fallbackStatus: "fail",
    })).toBe("pass");
  });

  it("uses normalized and legacy row-count lookup for derived status", () => {
    expect(deriveStoredResultStatus({
      actual: {
        values: { "Row Count - View My HCO List": 3026 },
        tolerances_snapshot: { Count: { value: 0, unit: "pct", op: "eq" } },
      },
      expected: { values: { count: 3026 } },
      fallbackStatus: "fail",
    })).toBe("pass");
  });

  it("canonicalizes legacy row-count fallback names even without a snapshot", () => {
    expect(deriveStoredResultStatus({
      actual: { values: { "Row Count - View My HCO List": 3026 } },
      expected: { values: { count: 3026 } },
      fallbackStatus: "fail",
    })).toBe("pass");
  });

  it("keeps true execution errors failed", () => {
    expect(deriveStoredResultStatus({
      actual: { error: "missing FE-to-BE filter mapping" },
      expected: { error: "missing_filter_mapping" },
      fallbackStatus: "pending",
    })).toBe("fail");
  });

  it("does not treat informational messages as errors when KPI values are present", () => {
    expect(deriveStoredResultStatus({
      actual: {
        message: "scrape completed",
        values: { Count: 12 },
        tolerances_snapshot: { Count: { value: 0, unit: "pct", op: "eq" } },
      },
      expected: { values: { Count: 12 } },
      fallbackStatus: "fail",
    })).toBe("pass");
  });

  it("respects each KPI's own operator while deriving status", () => {
    expect(deriveStoredResultStatus({
      actual: {
        values: { A: 9, B: 11 },
        tolerances_snapshot: {
          A: { value: 0, unit: "pct", op: "lte" },
          B: { value: 0, unit: "pct", op: "gte" },
        },
      },
      expected: { values: { A: 10, B: 10 } },
      fallbackStatus: "fail",
    })).toBe("pass");
  });

  it("uses comparison operators for stored date KPI values", () => {
    expect(deriveStoredResultStatus({
      actual: {
        values: {
          "Claims ME": "Jun 30 - 2026",
          "Sales (NBRx)": "Aug 21 - 2026",
          "Call Activity WE": "Sep 18 - 2026",
          "Sales (NRx & TRx)": "Sep 04 - 2026",
        },
        tolerances_snapshot: {
          "Claims ME": { value: 0, unit: "pct", op: "lte" },
          "Sales (NBRx)": { value: 0, unit: "pct", op: "lte" },
          "Call Activity WE": { value: 0, unit: "pct", op: "lte" },
          "Sales (NRx & TRx)": { value: 0, unit: "pct", op: "lte" },
        },
      },
      expected: {
        values: {
          "Claims ME": "Jun 30 - 2026",
          "Sales (NBRx)": "Aug 28 - 2026",
          "Call Activity WE": "Sep 25 - 2026",
          "Sales (NRx & TRx)": "Sep 11 - 2026",
        },
      },
      fallbackStatus: "fail",
    })).toBe("pass");
  });

  it("fails stored date KPI values that violate comparison operators", () => {
    expect(deriveStoredResultStatus({
      actual: {
        values: { "Sales (NBRx)": "Aug 28 - 2026" },
        tolerances_snapshot: {
          "Sales (NBRx)": { value: 0, unit: "pct", op: "lt" },
        },
      },
      expected: { values: { "Sales (NBRx)": "Aug 28 - 2026" } },
      fallbackStatus: "pass",
    })).toBe("fail");
  });
});

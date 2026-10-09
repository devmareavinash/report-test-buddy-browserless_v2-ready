import { describe, expect, it } from "vitest";
import { configuredKpiNames, deriveStoredResultRows, deriveStoredResultStatus, isKpiValueNoise, lookupStoredKpiValue, resolveKpiTol, storedKpiSpec, storedKpiTolerances, toStoredTableModel, unwrapStoredValues } from "./kpi-values";

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
  it("shows a structured result under its configured KPI alias", () => {
    const table = { columns: ["Metric", "Value"], rows: [["TRx", 42]] };
    const result = deriveStoredResultRows({
      actual: {
        values: { "Segment Summary": table },
        structured_source_keys: { "Segment Summary": "tableData" },
        tolerances_snapshot: {
          "Segment Summary": { value: 0, unit: "pct", op: "eq" },
        },
      },
      expected: { values: { "Segment Summary": table } },
      fallbackStatus: "fail",
    });

    expect(result.rows.map((row) => row.k)).toEqual(["Segment Summary"]);
    expect(result.status).toBe("pass");
  });

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

  it("does not resurrect a removed KPI from a stale tolerance snapshot", () => {
    const actual = {
      tolerances_snapshot: {
        "Refresh Date": { value: 0, unit: "pct", op: "eq" },
        "Sales (NBRx)": { value: 0, unit: "pct", op: "eq" },
      },
    };
    const spec = {
      kpis: ["Sales (NBRx)"],
      kpi_tolerances: {
        "Sales (NBRx)": { value: 0, unit: "pct", op: "eq" },
      },
    };

    expect(configuredKpiNames(storedKpiSpec(actual, spec))).toEqual(["Sales (NBRx)"]);
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

  it("keeps a KPI failed when its stored diff records no extracted value", () => {
    const result = deriveStoredResultRows({
      actual: {
        values: { Count: null },
        tolerances_snapshot: {
          Count: { value: 0, unit: "pct", op: "eq" },
        },
      },
      expected: { values: { Count: null } },
      diff: { Count: { error: "no_value" } },
      fallbackStatus: "fail",
    });

    expect(result.status).toBe("fail");
    expect(result.rows).toEqual([
      expect.objectContaining({ k: "Count", pass: false, error: "no_value" }),
    ]);
  });

  it("does not treat grid-readiness diagnostics as a structured KPI value", () => {
    const diagnostics = {
      rows: 25,
      cells: 230,
      frame_url: "https://example.test/report",
      textLength: 1535,
      fingerprint: "25|230|1535|1397|375",
      stable_polls: 3,
    };
    const result = deriveStoredResultRows({
      actual: {
        values: { Count: null },
        tolerances_snapshot: {
          Count: { value: 0, unit: "pct", op: "eq" },
        },
      },
      expected: { values: { Count: diagnostics } },
      diff: { Count: { error: "no_value" } },
      fallbackStatus: "fail",
    });

    expect(toStoredTableModel(diagnostics)).toBeNull();
    expect(result.rows[0]).toEqual(expect.objectContaining({
      k: "Count",
      a: null,
      e: diagnostics,
      pass: false,
      error: "no_value",
    }));
  });

  it("preserves a legacy persisted failure when KPI values and diff details are missing", () => {
    const result = deriveStoredResultRows({
      actual: {
        values: { Count: null },
        tolerances_snapshot: {
          Count: { value: 0, unit: "pct", op: "eq" },
        },
      },
      expected: { values: { Count: null } },
      fallbackStatus: "fail",
    });

    expect(result.status).toBe("fail");
    expect(result.derived).toBe(false);
    expect(result.rows).toEqual([
      expect.objectContaining({ k: "Count", pass: false }),
    ]);
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

  it("derives a passing trend status when every stored grain is consecutive", () => {
    expect(deriveStoredResultStatus({
      actual: {
        values: {
          grains: {
            Weekly: { periods: ["06-26", "07-03"], missing: [], consecutive: true },
            Monthly: { periods: ["Aug-26", "Sep-26"], missing: [], consecutive: true },
            Quarterly: { periods: ["Q1-26", "Q2-26"], missing: [], consecutive: true },
          },
        },
      },
      scenarioType: "trend",
      fallbackStatus: "pending",
    })).toBe("pass");
  });

  it("explains a persisted failure when one reference KPI was not extracted", () => {
    const result = deriveStoredResultRows({
      actual: { values: { BHID: "BH12603848", "Last Call Date": "Jul 08 - 2026" } },
      expected: { values: { BHID: "BH12603848", "Last Call Date": null } },
      spec: {
        kpi_tolerances: {
          BHID: { value: 0, unit: "pct", op: "eq" },
          "Last Call Date": { value: 0, unit: "pct", op: "eq" },
        },
      },
      fallbackStatus: "fail",
    });

    expect(result.status).toBe("fail");
    expect(result.rows.find((row) => row.k === "Last Call Date")).toMatchObject({
      pass: false,
      error: "no_expected_value",
    });
  });

  it("rejects a legacy persisted pass when reference values are missing", () => {
    const result = deriveStoredResultRows({
      actual: { values: { City: "Travis Afb", BHOID: "BHO3057915" } },
      expected: { values: { City: null, BHOID: null } },
      spec: {
        kpis: ["City", "BHOID"],
        kpi_tolerances: {
          City: { value: 0, unit: "pct", op: "eq" },
          BHOID: { value: 0, unit: "pct", op: "eq" },
        },
      },
      fallbackStatus: "pass",
    });

    expect(result.status).toBe("fail");
    expect(result.rows.every((row) =>
      row.pass === false && row.error === "no_expected_value"
    )).toBe(true);
  });

  it("rejects a legacy persisted pass when both KPI values are missing", () => {
    const result = deriveStoredResultRows({
      actual: { values: { "Account Name": null } },
      expected: { values: { "Account Name": null } },
      spec: {
        kpis: ["Account Name"],
        kpi_tolerances: {
          "Account Name": { value: 0, unit: "pct", op: "eq" },
        },
      },
      fallbackStatus: "pass",
    });

    expect(result.status).toBe("fail");
    expect(result.rows[0]).toMatchObject({ pass: false, error: "no_value" });
  });

  it("treats a deliberately skipped blank MSTR KPI as passing", () => {
    const result = deriveStoredResultRows({
      actual: { values: { "Blink TRx": null } },
      expected: { values: { "Blink TRx": null } },
      diff: { "Blink TRx": { skipped: true, pass: true, reason: "not_present_in_mstr" } },
      spec: {
        kpi_tolerances: {
          "Blink TRx": { value: 0, unit: "pct", op: "eq" },
        },
      },
      fallbackStatus: "pass",
    });

    expect(result.status).toBe("pass");
    expect(result.rows[0]).toMatchObject({ k: "Blink TRx", pass: true, skipped: true });
  });
});

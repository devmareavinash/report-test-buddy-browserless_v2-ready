import { describe, expect, it } from "vitest";
import {
  hasComparableStructured,
  missingRequiredStructuredExtraction,
} from "../../supabase/functions/_shared/structured-extraction-retry";

const usableGrid = {
  grid: {
    columns: ["Metric", "Seg A"],
    rows: [["Invites Sent", "10"]],
  },
};

describe("missingRequiredStructuredExtraction", () => {
  it("retries isolated combo when grid KPI is missing despite other usable keys", () => {
    expect(
      missingRequiredStructuredExtraction({
        requireStructured: true,
        configuredLabels: ["grid"],
        comboLabel: "Total / Portfolio / Nubeqa / Total / YTD",
        comboValues: { filters_note: "ok", debug: { waited: true } },
      }),
    ).toBe(true);
  });

  it("does not retry isolated combo when grid was extracted", () => {
    expect(
      missingRequiredStructuredExtraction({
        requireStructured: true,
        configuredLabels: ["grid"],
        comboLabel: "Total / Portfolio / Nubeqa / Total / YTD",
        comboValues: usableGrid,
      }),
    ).toBe(false);
  });

  it("retries full matrix when any combo child lacks a grid", () => {
    expect(
      missingRequiredStructuredExtraction({
        requireStructured: true,
        configuredLabels: ["grid"],
        comboLabel: null,
        comboValues: usableGrid,
        matrixComboValues: [usableGrid, { note: "empty" }],
      }),
    ).toBe(true);
  });

  it("does not retry full matrix when every combo has a grid", () => {
    expect(
      missingRequiredStructuredExtraction({
        requireStructured: true,
        configuredLabels: ["grid"],
        comboLabel: null,
        comboValues: usableGrid,
        matrixComboValues: [usableGrid, { ...usableGrid }],
      }),
    ).toBe(false);
  });

  it("treats empty or columns-only tables as missing structured data", () => {
    expect(hasComparableStructured({
      grid: { columns: ["A"], rows: [] },
    })).toBe(false);
    expect(hasComparableStructured({
      grid: { columns: [], rows: [] },
    })).toBe(false);
  });

  it("ignores requireStructured=false", () => {
    expect(
      missingRequiredStructuredExtraction({
        requireStructured: false,
        configuredLabels: ["Sales WE"],
        comboLabel: "x",
        comboValues: {},
      }),
    ).toBe(false);
  });
});

import {
  hasComparableStructured,
  missingRequiredStructuredExtraction,
} from "./structured-extraction-retry.ts";

function assert(cond: unknown, msg = "assertion failed"): asserts cond {
  if (!cond) throw new Error(msg);
}

const usableGrid = {
  grid: {
    columns: ["Metric", "Seg A"],
    rows: [["Invites Sent", "10"]],
  },
};

Deno.test("retries isolated combo when grid is missing despite other keys", () => {
  assert(
    missingRequiredStructuredExtraction({
      requireStructured: true,
      configuredLabels: ["grid"],
      comboLabel: "Total / Portfolio / Nubeqa / Total / YTD",
      comboValues: { filters_note: "ok", debug: { waited: true } },
    }),
  );
});

Deno.test("does not retry isolated combo when grid was extracted", () => {
  assert(
    !missingRequiredStructuredExtraction({
      requireStructured: true,
      configuredLabels: ["grid"],
      comboLabel: "Total / Portfolio / Nubeqa / Total / YTD",
      comboValues: usableGrid,
    }),
  );
});

Deno.test("retries full matrix when any combo child lacks a grid", () => {
  assert(
    missingRequiredStructuredExtraction({
      requireStructured: true,
      configuredLabels: ["grid"],
      comboLabel: null,
      comboValues: usableGrid,
      matrixComboValues: [usableGrid, { note: "empty" }],
    }),
  );
});

Deno.test("does not retry full matrix when every combo has a grid", () => {
  assert(
    !missingRequiredStructuredExtraction({
      requireStructured: true,
      configuredLabels: ["grid"],
      comboLabel: null,
      comboValues: usableGrid,
      matrixComboValues: [usableGrid, { ...usableGrid }],
    }),
  );
});

Deno.test("empty or columns-only tables are not comparable structured", () => {
  assert(!hasComparableStructured({
    grid: { columns: ["A"], rows: [] },
  }));
  assert(!hasComparableStructured({
    grid: { columns: [], rows: [] },
  }));
});

Deno.test("ignores requireStructured=false", () => {
  assert(
    !missingRequiredStructuredExtraction({
      requireStructured: false,
      configuredLabels: ["Sales WE"],
      comboLabel: "x",
      comboValues: {},
    }),
  );
});

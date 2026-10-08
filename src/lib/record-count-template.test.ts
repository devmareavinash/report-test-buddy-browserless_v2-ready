import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSubTabs } from "../../supabase/functions/_shared/mstr-grid-template";

const root = process.cwd();
const referencePath = resolve(
  root,
  "supabase/functions/_shared/references/browserless-record-count.js",
);
const orchestratorPath = resolve(
  root,
  "supabase/functions/agent-orchestrate/index.ts",
);

describe("record-count extraction contract", () => {
  it("finds a quoted sub-tab in the scenario title when description is empty", () => {
    expect(parseSubTabs({
      title: "HCP Customer - 'Which is writing fewer NBRx than they used to?' tab Record Count: Pre Prod vs Prod",
      description: "",
    })).toEqual(["Which is writing fewer NBRx than they used to?"]);
  });

  it("versions the extractor without automatically replacing saved scripts", () => {
    const reference = readFileSync(referencePath, "utf8");
    const orchestrator = readFileSync(orchestratorPath, "utf8");

    expect(reference).toContain("RECORD_COUNT_TEMPLATE_VERSION: 2026-10-05.4");
    expect(orchestrator).toContain("if (!scriptHasSavedCode(script))");
    expect(orchestrator).not.toContain("isStaleRecordCountScript");
    expect(orchestrator).not.toContain("needsRecordCountTemplate");
  });

  it("does not persist readiness and debug objects as KPI values", () => {
    const orchestrator = readFileSync(orchestratorPath, "utf8");

    expect(orchestrator).toContain('"gridready", "debug", "showdata", "navigation", "filters"');
    expect(orchestrator).toContain('a == null');
    expect(orchestrator).toContain('{ error: "no_value" }');
    expect(orchestrator).toContain('{ error: "no_expected_value" }');
  });

  it("recognizes common Show Data total formats", () => {
    const reference = readFileSync(referencePath, "utf8");

    expect(reference).toContain("Total\\s+Rows?");
    expect(reference).toContain("Total\\s+Records?");
    expect(reference).toContain("aria-rowcount");
    expect(reference).toContain("Show Data popup did not become ready before timeout");
  });

  it("isolates and retries every filter combination without changing playwright-runtime", () => {
    const orchestrator = readFileSync(orchestratorPath, "utf8");

    expect(orchestrator).toContain("if (hasCombos)");
    expect(orchestrator).toContain("isolatedRunResponses");
    expect(orchestrator).toContain("isolatedRefResponses");
    expect(orchestrator).toContain("filter_combinations: [{ label: combo.label, filters: combo.filters || {} }]");
    expect(orchestrator).toContain("mapPool(combos, 1");
    expect(orchestrator).toContain("combo_extraction_retry");
    expect(orchestrator).toContain("comboExtractionNeedsRetry");
  });

  it("preserves popup/profile text fields instead of forcing them through numeric parsing", () => {
    const orchestrator = readFileSync(orchestratorPath, "utf8");

    expect(orchestrator).toContain("function isNumericScalar");
    expect(orchestrator).toContain("function preserveScalar");
    expect(orchestrator).toContain('kind: "text"');
    expect(orchestrator).toContain("normalizeTextScalar(aText) === normalizeTextScalar(eText)");
  });

  it("compares multiple structured KPI lists under their configured aliases", () => {
    const orchestrator = readFileSync(orchestratorPath, "utf8");

    expect(orchestrator).toContain("hasMultipleStructuredKpis");
    expect(orchestrator).toContain("const rawE = lookupKpiValue(expectedMap, lbl)");
    expect(orchestrator).toContain("diffMap[lbl] = {");
    expect(orchestrator).toContain("structuredSourceKeys[lbl] = lbl");
  });

  it("resolves configured KPI aliases before declaring extracted values missing", () => {
    const orchestrator = readFileSync(orchestratorPath, "utf8");

    expect(orchestrator).toContain("function lookupConfiguredKpiValue");
    expect(orchestrator).toContain("assertionSpec.kpi_aliases");
    expect(orchestrator).toContain("lookupConfiguredKpiValue(refScraped, lbl, kpiAliases)");
    expect(orchestrator).toContain("lookupConfiguredKpiValue(scraped, lbl, kpiAliases)");
  });
});

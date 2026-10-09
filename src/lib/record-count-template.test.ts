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
const scenarioDetailPath = resolve(root, "src/pages/ScenarioDetail.tsx");

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

  it("retries PCC payloads at most once while preserving isolated sessions", () => {
    const orchestrator = readFileSync(orchestratorPath, "utf8");

    expect(orchestrator).not.toContain("function pccExtractionRetryReason");
    expect(orchestrator).toContain("const reason = comboExtractionNeedsRetry(response, comboLabel)");
    expect(orchestrator).toContain("invokeRuntimeWithRetry");
  });

  it("does not pass blank PCC metrics as skipped values", () => {
    const orchestrator = readFileSync(orchestratorPath, "utf8");

    expect(orchestrator).not.toContain('reason: "not_present_in_mstr"');
    expect(orchestrator).not.toContain("skipped: true");
    expect(orchestrator).toContain('error: "no_value"');
  });

  it("keeps PCC identity verification metadata out of business-grid comparison", () => {
    const orchestrator = readFileSync(orchestratorPath, "utf8");

    expect(orchestrator).toContain("function pickComparableStructured");
    expect(orchestrator).toContain("!/pcc.*verification/i");
    expect(orchestrator).toContain("/^(physician|hcp|account)\\s+name$/i");
  });

  it("preserves multi-row warehouse output as the expected structured KPI grid", () => {
    const orchestrator = readFileSync(orchestratorPath, "utf8");

    expect(orchestrator).toContain("structuredWarehouseLabel");
    expect(orchestrator).toContain("rows.map((row: Record<string, any>)");
    expect(orchestrator).toContain("cols.map((column) => row?.[column] ?? null)");
  });

  it("serializes Browserless work across a full brand run", () => {
    const orchestrator = readFileSync(orchestratorPath, "utf8");

    expect(orchestrator).toContain("const reportConcurrency = 1;");
    expect(orchestrator).toContain("const childConcurrency = 1;");
  });

  it("prevents separate brand runs from competing for Browserless", () => {
    const orchestrator = readFileSync(orchestratorPath, "utf8");

    expect(orchestrator).toContain("const activeWorkstream = candidates.find");
    expect(orchestrator).toContain("if (activeWorkstream) return activeWorkstream;");
    expect(orchestrator).toContain('if (scopeType === "workstream") return candidates[0];');
  });

  it("persists a warehouse grid under its configured KPI instead of extractor metadata", () => {
    const scenarioDetail = readFileSync(scenarioDetailPath, "utf8");

    expect(scenarioDetail).toContain("const comparisonKeys = configuredKeys.length ? configuredKeys : actualKeys;");
    expect(scenarioDetail).toContain("!key.startsWith(\"__\") && !isKpiNoiseKey(key)");
  });

  it("fails completed comparisons with missing KPI values instead of leaving them pending", () => {
    const scenarioDetail = readFileSync(scenarioDetailPath, "utf8");

    expect(scenarioDetail).toContain("const missingRequiredValue = comparisonExecuted && (v == null || exp == null);");
    expect(scenarioDetail).toContain("const pass = missingRequiredValue ? false : evalPass");
  });

});

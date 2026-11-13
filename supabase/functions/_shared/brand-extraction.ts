import { toTableModel } from "./table-compare.ts";
import { executionErrors } from "./execution-status.ts";

type ValueMap = Record<string, any>;

function isMap(value: unknown): value is ValueMap {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const normalize = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, "");
const wrappers = ["extracted", "result", "results"];
const metadata = new Set([
  "ok", "error", "message", "filtersapplied", "navigation", "debug",
  "screenshot", "screenshoturl", "url", "title", "note", "jobid", "comboid", "requestedfilters", "filterverification", "execution", "executionstatus",
]);
function isNoise(key: string): boolean {
  return key.startsWith("__") || metadata.has(normalize(key)) ||
    /(?:_|\s)(debug|navigation|grid_ready|show_data|show_data_error|filters_applied)$/i.test(key);
}

// Only traverse known transport envelopes, never another combination's values.
export function selectComboNode(payload: unknown, label: string | null, comboId?: string | null, ambiguousLabel = false): ValueMap | null {
  const visit = (node: unknown, depth: number): ValueMap | null => {
    if (!isMap(node) || depth > 8) return null;
    if (comboId && isMap(node.results_by_id?.[comboId])) return node.results_by_id[comboId];
    if (comboId && isMap(node[comboId])) return node[comboId];
    if (comboId && node.combo_id === comboId) return node;
    if (ambiguousLabel && label !== null) {
      for (const key of wrappers) {
        const found = visit(node[key], depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (label !== null && isMap(node[label])) return node[label];
    if (label !== null) {
      const normalizedLabel = label.toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
      const matches = Object.entries(node).filter(([key, value]) =>
        !isNoise(key) && isMap(value) &&
        key.toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ").trim() === normalizedLabel
      );
      if (matches.length === 1) return matches[0][1];
    }
    for (const key of label === null ? wrappers : [...wrappers, "kpis", "values"]) {
      const found = visit(node[key], depth + 1);
      if (found) return found;
    }
    if (label === null && Object.keys(node).some((key) => !isNoise(key) && !wrappers.includes(key))) {
      return node;
    }
    return null;
  };
  return visit(payload, 0);
}

export function pickComboKpis(payload: unknown, label: string | null, configuredLabels: string[] = [], aliases: Record<string, string> = {}, comboId?: string | null, ambiguousLabel = false): ValueMap | null {
  const node = selectComboNode(payload, label, comboId, ambiguousLabel);
  if (!node) return null;
  // Keep groups and named tables intact. Configured lookup reads inside groups;
  // flattening eagerly would overwrite equal names or lose table structure.
  const values = Object.fromEntries(Object.entries(node).filter(([key]) => !isNoise(key)));
  for (const label of configuredLabels) {
    const value = lookupConfiguredKpiValue(values, label, aliases);
    if (value !== undefined) values[label] = value;
  }
  // A generic Show Data table is only an alias when exactly one configured KPI
  // is missing. Never assign the same table to multiple business KPIs.
  if (configuredLabels.length === 1 && lookupConfiguredKpiValue(values, configuredLabels[0], aliases) === undefined) {
    const table = values.tableData || values.tabledata || values.grid;
    if (toTableModel(table)) values[configuredLabels[0]] = table;
    else {
      const tables = Object.values(values).filter((value) => toTableModel(value));
      if (tables.length === 1) values[configuredLabels[0]] = tables[0];
    }
  }
  return values;
}

function unwrap(value: any): any {
  if (isMap(value) && Object.prototype.hasOwnProperty.call(value, "value")) {
    return unwrap(value.value);
  }
  return value;
}

function findNamed(node: unknown, name: string, depth = 0): any {
  if (!isMap(node) || depth > 8) return undefined;
  const key = Object.keys(node).find((key) => normalize(key) === normalize(name));
  if (key !== undefined) return unwrap(node[key]);
  if (normalize(name) === "count") {
    const rowCounts = Object.keys(node).filter((key) => /^rowcount/.test(normalize(key)));
    if (rowCounts.length === 1) return unwrap(node[rowCounts[0]]);
  }
  const matches: any[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (isNoise(key) || ["rows", "data", "series", "headers"].includes(normalize(key))) continue;
    const found = findNamed(value, name, depth + 1);
    if (found !== undefined) matches.push(found);
  }
  // Do not silently choose a KPI from one of two conflicting groups.
  if (matches.length === 1) return matches[0];
  if (matches.length > 1 && matches.every((value) => JSON.stringify(value) === JSON.stringify(matches[0]))) {
    return matches[0];
  }
  return undefined;
}

export function lookupConfiguredKpiValue(
  map: ValueMap | null | undefined,
  name: string,
  aliases: Record<string, string> | null | undefined,
): any {
  const alias = aliases?.[name];
  if (alias) {
    const found = findNamed(map, alias);
    if (found !== undefined) return found;
  }
  return findNamed(map, name);
}

export function comboExecutionError(payload: unknown, label: string | null, comboId?: string | null, ambiguousLabel = false): string | null {
  const ownError = (node: ValueMap): string | null => {
    if (node.error || node.ok === false) return String(node.error || node.message || "scrape failed");
    return null;
  };
  const envelopeError = (node: unknown, depth: number): string | null => {
    if (!isMap(node) || depth > 8) return null;
    const error = ownError(node);
    if (error) return error;
    for (const key of wrappers) {
      const error = envelopeError(node[key], depth + 1);
      if (error) return error;
    }
    return null;
  };
  const error = envelopeError(payload, 0);
  if (error) return error;
  const node = selectComboNode(payload, label, comboId, ambiguousLabel);
  if (!node) return label === null ? "No extraction result returned" : `No extraction result for combination: ${label}`;
  return executionErrors(node)[0] || ownError(node);
}
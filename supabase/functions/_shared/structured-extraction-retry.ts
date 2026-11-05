/**
 * Pure helpers for "missing grid/chart → retry" decisions.
 * Used by agent-orchestrate so vitest/deno can cover the gate without the
 * full orchestrator. Empty tables (columns only / zero rows) count as missing.
 */

const STRUCTURED_KPI_KEYS = new Set([
  "grid", "graph", "data", "table", "tabledata", "series", "chart", "rows",
  "heatmap", "viz", "dataset",
]);

function normKpiKey(k: string): string {
  return String(k || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isStructuredVal(v: unknown): boolean {
  if (v == null || typeof v === "boolean") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v !== "object") return false;
  return Object.entries(v as Record<string, unknown>).some(([k, nested]) => {
    if (!STRUCTURED_KPI_KEYS.has(normKpiKey(k))) return false;
    if (Array.isArray(nested)) return nested.length > 0;
    if (!nested || typeof nested !== "object") return false;
    return Object.values(nested as Record<string, unknown>).some((value) =>
      Array.isArray(value) ? value.length > 0 : Boolean(value && typeof value === "object")
    );
  });
}

/** True when value is a table with at least one data row. */
function isUsableTableShape(v: unknown): boolean {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (o.error || o.show_data_error || o.extract_error) return false;
  const hasTableKeys = Array.isArray(o.rows) || Array.isArray(o.data) || Array.isArray(o.columns);
  if (!hasTableKeys) return false;
  return Boolean(
    (Array.isArray(o.rows) && o.rows.length > 0) ||
      (Array.isArray(o.data) && o.data.length > 0),
  );
}

function isUsableStructuredNode(v: unknown): boolean {
  if (isUsableTableShape(v)) return true;
  // Non-table structured (chart series / nested grid key) — reject empty tables.
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.rows) || Array.isArray(o.columns) || Array.isArray(o.data)) {
      return isUsableTableShape(v);
    }
  }
  return isStructuredVal(v);
}

/** True when map holds a comparable grid/chart/table extract. */
export function hasComparableStructured(
  map: Record<string, unknown> | null | undefined,
): boolean {
  if (!map || typeof map !== "object") return false;
  const filtered = Object.fromEntries(
    Object.entries(map).filter(([key]) => !/pcc.*verification/i.test(key)),
  );
  for (const [k, v] of Object.entries(filtered)) {
    if (String(k).startsWith("__")) continue;
    if (STRUCTURED_KPI_KEYS.has(normKpiKey(k)) && v && typeof v === "object") {
      if (isUsableStructuredNode(v)) return true;
      continue;
    }
    if (isUsableStructuredNode(v)) return true;
  }
  return false;
}

export function looksLikeStructuredKpiLabel(label: string): boolean {
  return /segment|summary|grid|graph|table|chart|series|heatmap|viz|dataset|geography|performance|overall/i
    .test(String(label || ""));
}

/**
 * Whether a scrape should be retried because a required grid/chart is missing.
 * comboLabel set → inspect that combo's KPI map only.
 * comboLabel null + multi combo maps → any child missing structured → retry.
 */
export function missingRequiredStructuredExtraction(opts: {
  requireStructured?: boolean;
  configuredLabels?: string[];
  comboLabel: string | null;
  comboValues: Record<string, unknown> | null | undefined;
  /** When comboLabel is null, optional per-combo value maps from a full matrix. */
  matrixComboValues?: Array<Record<string, unknown> | null | undefined>;
}): boolean {
  const requireStructured = opts.requireStructured ||
    (opts.configuredLabels || []).some((label) => looksLikeStructuredKpiLabel(label));
  if (!requireStructured) return false;

  if (opts.comboLabel) {
    return !hasComparableStructured(opts.comboValues);
  }

  const matrix = opts.matrixComboValues;
  if (matrix && matrix.length >= 2) {
    return matrix.some((one) => !hasComparableStructured(one));
  }
  return !hasComparableStructured(opts.comboValues);
}

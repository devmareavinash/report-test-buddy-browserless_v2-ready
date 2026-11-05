/**
 * Frontend-only display helpers for extraction vs validation status labels.
 * Does not change stored failure_category / status values.
 */

const EXTRACTION_LABELS: Record<string, string> = {
  pass: "PASS",
  fail: "FAILED",
  failed: "FAILED",
  partial_extraction: "PARTIAL EXTRACTION",
  auth_failure: "AUTH FAILURE",
  browserless_timeout: "BROWSERLESS TIMEOUT",
  cancelled: "CANCELLED",
  empty_extraction: "FAILED",
};

/** Higher = worse (for multi-combo footers on Brand run cards). */
const EXTRACTION_CATEGORY_RANK: Record<string, number> = {
  pass: 0,
  fail: 10,
  failed: 10,
  partial_extraction: 20,
  empty_extraction: 30,
  auth_failure: 40,
  browserless_timeout: 50,
  cancelled: 60,
};

/** Pick the worst extraction category across combo rows. */
export function worseExtractionCategory(
  a: string | null | undefined,
  b: string | null | undefined,
): string {
  const ak = String(a || "").trim().toLowerCase();
  const bk = String(b || "").trim().toLowerCase();
  if (!ak) return bk;
  if (!bk) return ak;
  const ar = EXTRACTION_CATEGORY_RANK[ak] ?? 15;
  const br = EXTRACTION_CATEGORY_RANK[bk] ?? 15;
  return br >= ar ? bk : ak;
}

export type ComboExecutionAudit = {
  failure_category?: string | null;
  status?: string | null;
  attempt_count?: number | null;
  missing_fields?: unknown;
};

/**
 * Aggregate per-combo execution audits so a scenario footer cannot show PASS
 * when another combo on the same card failed.
 */
export function aggregateComboExecutionAudits(
  audits: Array<ComboExecutionAudit | null | undefined>,
): {
  category: string;
  attempt_count: number | null;
  missing_fields: string[];
} | null {
  const usable = (audits || []).filter((a): a is ComboExecutionAudit => !!a && typeof a === "object");
  if (!usable.length) return null;

  let category = "";
  let attempt_count: number | null = null;
  const missing = new Set<string>();

  for (const exec of usable) {
    const cat = String(exec.failure_category || exec.status || "").trim();
    if (cat) category = worseExtractionCategory(category, cat);
    const attempts = exec.attempt_count != null ? Number(exec.attempt_count) : NaN;
    if (Number.isFinite(attempts)) {
      attempt_count = attempt_count == null ? attempts : Math.max(attempt_count, attempts);
    }
    if (Array.isArray(exec.missing_fields)) {
      for (const field of exec.missing_fields) {
        const text = String(field || "").trim();
        if (text) missing.add(text);
      }
    }
  }

  if (!category && !missing.size) return null;
  return {
    category,
    attempt_count,
    missing_fields: Array.from(missing),
  };
}

/** Map stored extraction category → UI label (no DB mutation). */
export function formatExtractionStatusLabel(category: string | null | undefined): string {
  const key = String(category || "").trim().toLowerCase();
  if (!key) return "";
  return EXTRACTION_LABELS[key] || key.replace(/_/g, " ").toUpperCase();
}

/** Map comparison/derived status → Validation Status label. */
export function formatValidationStatusLabel(
  status: string | null | undefined,
): "PASS" | "FAIL" | "PENDING" {
  const key = String(status || "").trim().toLowerCase();
  if (key === "pass") return "PASS";
  if (key === "pending") return "PENDING";
  return "FAIL";
}

/**
 * Validation must not show PASS when extraction did not succeed
 * (cancelled / auth / timeout / partial / empty / failed).
 */
export function resolveValidationDisplayStatus(
  extractionCategory: string | null | undefined,
  comparisonStatus: string | null | undefined,
): "PASS" | "FAIL" | "PENDING" {
  const cat = String(extractionCategory || "").trim().toLowerCase();
  if (cat && cat !== "pass") return "FAIL";
  return formatValidationStatusLabel(comparisonStatus);
}

export function formatExtractionStatusLine(
  category: string | null | undefined,
  attempts?: number | null,
): string {
  const label = formatExtractionStatusLabel(category);
  if (!label) return "";
  const attemptsNum = attempts != null ? Number(attempts) : NaN;
  if (Number.isFinite(attemptsNum)) {
    return `Extraction Status: ${label} · Attempts: ${attemptsNum}`;
  }
  return `Extraction Status: ${label}`;
}

export function formatValidationStatusLine(
  extractionCategory: string | null | undefined,
  comparisonStatus: string | null | undefined,
): string {
  const label = resolveValidationDisplayStatus(extractionCategory, comparisonStatus);
  return `Validation Status: ${label}`;
}

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

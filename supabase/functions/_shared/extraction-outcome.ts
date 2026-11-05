/**
 * Classify scrape payloads and completeness for Brand/Report reliability.
 * Used by agent-orchestrate (and mirrored tests). Does not change Browserless.
 */

export type ExtractionFailureCategory =
  | "pass"
  | "fail"
  | "partial_extraction"
  | "auth_failure"
  | "browserless_timeout"
  | "cancelled"
  | "empty_extraction";

export const TERMINAL_FAIL_STATUSES = new Set<string>([
  "fail",
  "partial_extraction",
  "auth_failure",
  "browserless_timeout",
  "cancelled",
  "empty_extraction",
]);

export function isTerminalFailStatus(status: string | null | undefined): boolean {
  return TERMINAL_FAIL_STATUSES.has(String(status || "").toLowerCase());
}

export function isPassStatus(status: string | null | undefined): boolean {
  return String(status || "").toLowerCase() === "pass";
}

function pathnameOnly(url: unknown): string | null {
  if (url == null) return null;
  const raw = String(url).trim();
  if (!raw) return null;
  try {
    return new URL(raw).pathname || raw;
  } catch {
    return raw.replace(/^https?:\/\/[^/]+/i, "") || raw;
  }
}

export function looksLikeLoginPageUrl(url: unknown): boolean {
  const path = pathnameOnly(url);
  if (!path) return false;
  return /(?:^|\/)(?:login|signin|sign-in|logon|auth|authentication)(?:\/|$)/i.test(path);
}

export function isBrowserlessTimeoutError(error: unknown): boolean {
  const text = String(error || "");
  return /BROWSERLESS_TIMEOUT|browserless.*(timeout|timed?\s*out)|chromium\/function.*timeout/i.test(text);
}

export function isAuthFailureError(error: unknown): boolean {
  const text = String(error || "");
  return /LOGIN_FAILED|AUTH_REQUIRED|session\s*expir|login\s*page|auth_failure|stayed_on_login/i.test(text);
}

/**
 * Sanitize auth failure into a bounded reason code (no secrets).
 * Distinguishes credential vs page-structure vs redirect classes.
 */
export function classifyAuthFailureReason(
  error: unknown,
  url?: unknown,
): string {
  const text = String(error || "");
  const path = pathnameOnly(url) || "";
  if (/account.*(lock|expir|disabl|suspend)|locked|disabled/i.test(text)) {
    return "account_locked_or_expired";
  }
  if (/invalid.*(credential|password|user)|bad.?credential|wrong.?password|LOGIN_FAILED/i.test(text)) {
    return "invalid_credentials";
  }
  if (/sso|saml|oauth|interstitial|redirect/i.test(text)) {
    return "redirect_sso_or_interstitial";
  }
  if (/wrong.*(login|url)|host.?mismatch|unexpected.?host/i.test(text)) {
    return "wrong_login_url";
  }
  if (/login.?page.?struct|selector|fill.?failed|submit.?failed/i.test(text)) {
    return "login_page_structure_changed";
  }
  if (looksLikeLoginPageUrl(path) || /stayed_on_login|still on login/i.test(text)) {
    return "stayed_on_login_page";
  }
  if (/AUTH_REQUIRED|session\s*expir/i.test(text)) {
    return "session_expired";
  }
  if (/dashboard.?not.?reached|dossier.?not.?ready|nav.?failed/i.test(text)) {
    return "login_ok_dashboard_not_reached";
  }
  return "authentication_failed";
}

/** Best-effort URL from a playwright-runtime / gateway payload. */
export function extractPayloadUrl(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const extracted = (p.extracted && typeof p.extracted === "object")
    ? p.extracted as Record<string, unknown>
    : p;
  return String(
    extracted.url ||
      extracted.final_url ||
      (extracted.result && typeof extracted.result === "object"
        ? (extracted.result as any).url || (extracted.result as any).final_url
        : null) ||
      p.url ||
      "",
  ).trim() || null;
}

export function extractPayloadError(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const extracted = (p.extracted && typeof p.extracted === "object")
    ? p.extracted as Record<string, unknown>
    : null;
  const result = extracted && typeof extracted.result === "object"
    ? extracted.result as Record<string, unknown>
    : null;
  const raw =
    p.error ||
    extracted?.error ||
    result?.error ||
    (p.ok === false ? p.message : null) ||
    (extracted && extracted.ok === false ? extracted.message : null) ||
    null;
  const text = raw != null ? String(raw).trim() : "";
  return text || null;
}

export function classifyRuntimePayload(
  payload: unknown,
  opts?: { target?: "main" | "reference" },
): {
  category: ExtractionFailureCategory;
  error: string | null;
  url: string | null;
  auth_failure: boolean;
  browserless_timeout: boolean;
} {
  const url = extractPayloadUrl(payload);
  const error = extractPayloadError(payload);
  const target = opts?.target || "main";

  if (isBrowserlessTimeoutError(error) || isBrowserlessTimeoutError((payload as any)?.error)) {
    return {
      category: "browserless_timeout",
      error: error || "BROWSERLESS_TIMEOUT",
      url,
      auth_failure: false,
      browserless_timeout: true,
    };
  }

  const loginUrl = looksLikeLoginPageUrl(url);
  const authErr = isAuthFailureError(error);
  if (loginUrl || authErr) {
    const reason = classifyAuthFailureReason(
      error || (loginUrl ? `${target}_stayed_on_login_page` : "authentication_failed"),
      url,
    );
    return {
      category: "auth_failure",
      error: reason,
      url,
      auth_failure: true,
      browserless_timeout: false,
    };
  }

  if (error) {
    return {
      category: "fail",
      error,
      url,
      auth_failure: false,
      browserless_timeout: false,
    };
  }

  return {
    category: "pass",
    error: null,
    url,
    auth_failure: false,
    browserless_timeout: false,
  };
}

function normKey(k: string): string {
  return String(k || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isNoiseKey(k: string): boolean {
  const n = normKey(k);
  if (!n || String(k || "").startsWith("__")) return true;
  return [
    "filtersapplied", "screenshot", "ok", "error", "url", "title", "note",
    "result", "extracted", "navigation", "message", "value", "filter",
    "tolerancessnapshot", "structuredsourcekeys",
  ].includes(n);
}

/** True when a KPI value counts as successfully extracted (including 0 / "N/A"). */
export function isExtractedKpiValue(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "number" || typeof v === "boolean") return true;
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return false;
    // Explicit sentinel empties are still "extracted" answers from the page.
    return true;
  }
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (o.error || o.show_data_error || o.extract_error) return false;
    if (Array.isArray(o.columns) || Array.isArray(o.rows) || Array.isArray(o.data)) {
      return Boolean(
        (o.columns as unknown[])?.length ||
          (o.rows as unknown[])?.length ||
          (o.data as unknown[])?.length,
      );
    }
    return Object.entries(o).some(([k, nested]) => !isNoiseKey(k) && isExtractedKpiValue(nested));
  }
  return false;
}

export function lookupConfiguredValue(
  map: Record<string, unknown> | null | undefined,
  name: string,
  aliases?: Record<string, string> | null,
): unknown {
  if (!map || typeof map !== "object") return undefined;
  const alias = aliases && typeof aliases === "object" ? aliases[name] : null;
  if (alias && map[alias] !== undefined) return map[alias];
  if (map[name] !== undefined) return map[name];
  const want = normKey(name);
  const exact = Object.keys(map).find((k) => normKey(k) === want);
  return exact ? map[exact] : undefined;
}

export type CompletenessReport = {
  expected: string[];
  extracted: string[];
  missing: string[];
  present: string[];
  /** Values that are explicitly null/absent vs never returned — missing list. */
  balanced: boolean;
  category: ExtractionFailureCategory;
};

/**
 * Completeness gate: EXPECTED = extracted + explicitly missing.
 * Legitimate 0 / "N/A" / non-empty strings count as extracted.
 */
export function assessConfiguredCompleteness(
  expectedLabels: string[],
  values: Record<string, unknown> | null | undefined,
  aliases?: Record<string, string> | null,
): CompletenessReport {
  const expected = (expectedLabels || [])
    .map((l) => String(l || "").trim())
    .filter((l) => l && !isNoiseKey(l));
  const present: string[] = [];
  const missing: string[] = [];
  for (const label of expected) {
    const raw = lookupConfiguredValue(values || {}, label, aliases);
    if (isExtractedKpiValue(raw)) present.push(label);
    else missing.push(label);
  }
  const extracted = present.slice();
  let category: ExtractionFailureCategory = "pass";
  if (!expected.length) {
    category = present.length ? "pass" : "empty_extraction";
  } else if (missing.length === expected.length) {
    category = "empty_extraction";
  } else if (missing.length > 0) {
    category = "partial_extraction";
  }
  return {
    expected,
    extracted,
    missing,
    present,
    balanced: missing.length + present.length === expected.length,
    category,
  };
}

/** Merge runtime classification with KPI completeness for one target. */
export function finalizeTargetOutcome(
  runtime: ReturnType<typeof classifyRuntimePayload>,
  completeness: CompletenessReport,
): {
  category: ExtractionFailureCategory;
  missing_fields: string[];
  extracted_fields: string[];
  error: string | null;
} {
  if (runtime.browserless_timeout) {
    return {
      category: "browserless_timeout",
      missing_fields: completeness.missing.length ? completeness.missing : completeness.expected,
      extracted_fields: completeness.present,
      error: runtime.error,
    };
  }
  if (runtime.auth_failure) {
    return {
      category: "auth_failure",
      missing_fields: completeness.missing.length ? completeness.missing : completeness.expected,
      extracted_fields: completeness.present,
      error: runtime.error,
    };
  }
  if (completeness.category === "partial_extraction") {
    return {
      category: "partial_extraction",
      missing_fields: completeness.missing,
      extracted_fields: completeness.present,
      error: runtime.error ||
        (completeness.missing.length
          ? `missing_fields:${completeness.missing.join(",")}`
          : null),
    };
  }
  if (completeness.category === "empty_extraction") {
    return {
      category: runtime.error ? "fail" : "empty_extraction",
      missing_fields: completeness.missing.length ? completeness.missing : completeness.expected,
      extracted_fields: completeness.present,
      error: runtime.error || "no_kpi_values_returned",
    };
  }
  if (runtime.error) {
    return {
      category: "fail",
      missing_fields: completeness.missing,
      extracted_fields: completeness.present,
      error: runtime.error,
    };
  }
  return {
    category: "pass",
    missing_fields: [],
    extracted_fields: completeness.present,
    error: null,
  };
}

/** Persistable status for test_results.status */
export function statusFromCategory(category: ExtractionFailureCategory, comparePass: boolean): string {
  if (category === "pass") return comparePass ? "pass" : "fail";
  if (category === "partial_extraction") return "partial_extraction";
  if (category === "auth_failure") return "auth_failure";
  if (category === "browserless_timeout") return "browserless_timeout";
  if (category === "cancelled") return "cancelled";
  if (category === "empty_extraction") return "fail";
  return "fail";
}

export function buildExecutionAudit(meta: {
  run_id?: string | null;
  scenario_id?: string | null;
  combo?: string | null;
  target?: "main" | "reference" | "compare";
  status: string;
  attempt_count?: number;
  missing_fields?: string[];
  failure_category?: string;
  error?: string | null;
  url?: string | null;
}): Record<string, unknown> {
  return {
    run_id: meta.run_id || null,
    scenario_id: meta.scenario_id || null,
    combo: meta.combo || null,
    target: meta.target || null,
    status: meta.status,
    attempt_count: meta.attempt_count ?? 1,
    missing_fields: meta.missing_fields || [],
    failure_category: meta.failure_category || meta.status,
    error: meta.error ? String(meta.error).slice(0, 500) : null,
    url: meta.url ? pathnameOnly(meta.url) : null,
    created_at: new Date().toISOString(),
  };
}

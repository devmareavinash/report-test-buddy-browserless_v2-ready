/**
 * Brand/report run accounting: expected scenarios must never disappear.
 * EXPECTED = TERMINAL (pass|fail|…) + UNEXECUTED (pending|not_started|blocked|cancelled)
 */

export type CaseOutcome =
  | "pass"
  | "fail"
  | "pending"
  | "not_started"
  | "cancelled"
  | "blocked";

const FAIL_STATUSES = new Set([
  "fail",
  "partial_extraction",
  "auth_failure",
  "browserless_timeout",
  "empty_extraction",
  "error",
  "failed",
]);

const UNEXECUTED_STATUSES = new Set([
  "not_started",
  "cancelled",
  "blocked",
  "infrastructure_blocked",
]);

export type AccountedCounts = {
  pass: number;
  fail: number;
  pending: number;
  not_executed: number;
  total: number;
};

/** Map a stored/stub status into a case-level bucket. */
export function caseOutcomeFromStatus(status: string | null | undefined): CaseOutcome {
  const s = String(status || "pending").toLowerCase();
  if (s === "pass") return "pass";
  if (s === "pending") return "pending";
  if (s === "cancelled") return "cancelled";
  if (s === "not_started") return "not_started";
  if (s === "blocked" || s === "infrastructure_blocked") return "blocked";
  if (FAIL_STATUSES.has(s) || UNEXECUTED_STATUSES.has(s)) {
    if (UNEXECUTED_STATUSES.has(s)) return s as CaseOutcome;
    return "fail";
  }
  return "pending";
}

/**
 * Status to assign to expected scenarios that have zero test_results rows.
 * Running → pending; cancelled → cancelled; infra/auth stop → blocked; else not_started.
 */
export function missingScenarioStubStatus(
  runStatus: string | null | undefined,
  summary?: Record<string, unknown> | null,
): "pending" | "cancelled" | "not_started" | "blocked" {
  const st = String(runStatus || "").toLowerCase();
  if (st === "running") return "pending";
  if (st === "cancelled") return "cancelled";
  const cat = String(summary?.failure_category || summary?.error || "").toLowerCase();
  if (
    cat.includes("browserless") ||
    cat.includes("auth_failure") ||
    cat.includes("auth_expired") ||
    cat.includes("infrastructure")
  ) {
    return "blocked";
  }
  // Finished without every expected case → incomplete, not a silent pass.
  return "not_started";
}

/** Always merge expected scenario ids into the case map (never drop missing rows). */
export function mergeExpectedCaseStatuses(
  existing: Map<string, CaseOutcome>,
  expectedScenarioIds: string[],
  runStatus: string | null | undefined,
  summary?: Record<string, unknown> | null,
): Map<string, CaseOutcome> {
  const out = new Map(existing);
  const stub = missingScenarioStubStatus(runStatus, summary);
  for (const id of expectedScenarioIds) {
    if (!out.has(id)) out.set(id, stub);
  }
  return out;
}

export function countAccountedCases(outcomes: Iterable<CaseOutcome>): AccountedCounts {
  let pass = 0, fail = 0, pending = 0, not_executed = 0;
  for (const o of outcomes) {
    if (o === "pass") pass++;
    else if (o === "fail") fail++;
    else if (o === "pending") pending++;
    else not_executed++; // not_started | cancelled | blocked
  }
  return { pass, fail, pending, not_executed, total: pass + fail + pending + not_executed };
}

/**
 * Collapse per-row statuses for one scenario into a single case outcome.
 * Fail beats everything; unexecuted/pending beat pass.
 */
export function collapseScenarioStatuses(statuses: string[]): CaseOutcome {
  const outcomes = statuses.map(caseOutcomeFromStatus);
  if (outcomes.some((o) => o === "fail")) return "fail";
  if (outcomes.some((o) => o === "pending")) return "pending";
  if (outcomes.some((o) => o === "blocked")) return "blocked";
  if (outcomes.some((o) => o === "cancelled")) return "cancelled";
  if (outcomes.some((o) => o === "not_started")) return "not_started";
  if (outcomes.every((o) => o === "pass")) return "pass";
  return "pending";
}

/** Parent Brand may only be COMPLETED when every expected case is terminal and passes. */
export function brandLifecycleFromAccounting(
  runStatus: string | null | undefined,
  counts: AccountedCounts,
  summary?: Record<string, unknown> | null,
): string {
  const st = String(runStatus || "");
  if (st === "running" || st === "cancelled") return st;
  const executionFailed =
    Boolean(summary?.error) ||
    Number(summary?.failed_reports) > 0 ||
    Object.values((summary?.reports as Record<string, any>) || {}).some(
      (r) => r?.status === "error",
    );
  if (counts.not_executed > 0 || counts.pending > 0) {
    if (st === "cancelled") return "cancelled";
    return "failed"; // incomplete — do not present as completed
  }
  if (executionFailed || counts.fail > 0) return "failed";
  if (!counts.total) return st || "failed";
  return "completed";
}

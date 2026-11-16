import { deriveStoredResultStatus, type StoredResultStatus } from "./kpi-values";
import { deriveExecutionOutcome } from "../../supabase/functions/_shared/execution-status";

export function deriveRunResults<T extends {
  actual?: any; expected?: any; diff?: any; status?: string | null;
  scenario_id?: string | null; scenarios?: { type?: string | null } | null;
}>(results: T[], specs: Record<string, any> = {}) {
  return results.map((row) => ({
    ...row,
    executionOutcome: deriveExecutionOutcome(row, deriveStoredResultStatus({ actual: row.actual, expected: row.expected, diff: row.diff, spec: specs[row.scenario_id || ""], scenarioType: row.scenarios?.type || undefined, fallbackStatus: row.status })),
    derivedStatus: deriveStoredResultStatus({
      actual: row.actual, expected: row.expected, diff: row.diff,
      spec: specs[row.scenario_id || ""], scenarioType: row.scenarios?.type || undefined,
      fallbackStatus: row.status,
    }),
  }));
}

export function countRunCases(results: Array<{ scenario_id?: string | null; derivedStatus: StoredResultStatus }>) {
  const cases = new Map<string, StoredResultStatus>();
  for (const row of results) {
    if (!row.scenario_id) continue;
    const previous = cases.get(row.scenario_id);
    cases.set(row.scenario_id, previous === "fail" || row.derivedStatus === "fail" ? "fail"
      : previous === "pending" || row.derivedStatus === "pending" ? "pending" : "pass");
  }
  const values = [...cases.values()];
  return {
    pass: values.filter((s) => s === "pass").length,
    fail: values.filter((s) => s === "fail").length,
    pending: values.filter((s) => s === "pending").length,
    total: cases.size,
  };
}

/**
 * Lifecycle badge for a finished run.
 * Comparison fails stay in check counts; "failed" is reserved for infra /
 * incomplete execution (summary errors, unfinished cases).
 */
export function presentedRunStatus(run: { status?: string | null; summary?: any }, counts: ReturnType<typeof countRunCases>) {
  if (run.status !== "completed" && run.status !== "failed") return run.status;
  const summary = run.summary || {};
  const executionFailed = summary.error || Number(summary.failed_reports) > 0 ||
    Object.values(summary.reports || {}).some((report: any) => report?.status === "error");
  if (executionFailed) return "failed";
  if (!counts.total) return run.status;
  if (counts.pending) return "pending";
  // Execution finished — pass/fail of checks does not change the lifecycle badge.
  return "completed";
}

export function matchesRunOutcome(run: Parameters<typeof presentedRunStatus>[0], counts: ReturnType<typeof countRunCases>, filter: string | null) {
  const status = presentedRunStatus(run, counts);
  if (filter === "pass") return status === "completed" && counts.total > 0 && !counts.fail && !counts.pending;
  // "Failing" = comparison failures and/or execution failures.
  if (filter === "fail") return counts.fail > 0 || status === "failed";
  if (filter === "running" || filter === "cancelled") return status === filter;
  return true;
}
import { deriveStoredResultStatus, type StoredResultStatus } from "./kpi-values";

const UNEXECUTED_STORED = new Set([
  "not_started",
  "blocked",
  "infrastructure_blocked",
  "cancelled",
]);

export function deriveRunResults<T extends {
  actual?: any; expected?: any; diff?: any; status?: string | null;
  scenario_id?: string | null; scenarios?: { type?: string | null } | null;
}>(results: T[], specs: Record<string, any> = {}) {
  return results.map((row) => {
    const raw = String(row.status || "").toLowerCase();
    const unexecuted =
      UNEXECUTED_STORED.has(raw) ||
      row?.diff?.unexecuted === true ||
      row?.actual?.unexecuted === true ||
      row?.expected?.unexecuted === true;
    // Preserve explicit not-executed accounting — do not reclassify as pass/fail/pending.
    if (unexecuted) {
      return {
        ...row,
        derivedStatus: (raw === "cancelled" ? "cancelled"
          : raw === "blocked" || raw === "infrastructure_blocked" || raw === "browserless_timeout"
            ? "blocked"
            : "not_started") as any,
      };
    }
    return {
      ...row,
      derivedStatus: deriveStoredResultStatus({
        actual: row.actual, expected: row.expected, diff: row.diff,
        spec: specs[row.scenario_id || ""], scenarioType: row.scenarios?.type || undefined,
        fallbackStatus: row.status,
      }),
    };
  });
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

/** Re-evaluate test outcomes, but never hide execution/report failures or active lifecycle states. */
export function presentedRunStatus(run: { status?: string | null; summary?: any }, counts: ReturnType<typeof countRunCases>) {
  if (run.status !== "completed" && run.status !== "failed") return run.status;
  const summary = run.summary || {};
  const executionFailed = summary.error || Number(summary.failed_reports) > 0 ||
    Object.values(summary.reports || {}).some((report: any) => report?.status === "error");
  if (executionFailed || counts.fail > 0) return "failed";
  // Finished run with unexecuted/pending cases is incomplete — never "completed".
  if (counts.pending > 0) return "failed";
  // A failed lifecycle without a recorded test failure cannot safely be reclassified.
  if (run.status === "failed" && !(Number(summary.fail) > 0)) return "failed";
  if (!counts.total) return run.status;
  return "completed";
}

export function matchesRunOutcome(run: Parameters<typeof presentedRunStatus>[0], counts: ReturnType<typeof countRunCases>, filter: string | null) {
  const status = presentedRunStatus(run, counts);
  if (filter === "pass") return status === "completed" && counts.total > 0 && !counts.fail && !counts.pending;
  if (filter === "fail") return status === "failed";
  if (filter === "running" || filter === "cancelled") return status === filter;
  return true;
}
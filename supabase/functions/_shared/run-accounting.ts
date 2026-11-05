/**
 * Orchestrator accounting: every expected executable scenario must leave a
 * terminal or explicit unexecuted row before a report/Brand is finalized.
 *
 * Do NOT invent pass/fail for work that never ran.
 */

export type UnexecutedReason =
  | "cancelled"
  | "auth_failure"
  | "browserless_timeout"
  | "not_started"
  | "blocked";

export type UnexecutedSpec = {
  runId: string;
  scenarios: Array<{ id: string; criticality?: string | null }>;
  /** scenario_ids that already have at least one test_results row */
  accountedIds: Set<string>;
  reason: UnexecutedReason;
  detail?: string | null;
};

export function pickUnexecutedStatus(reason: UnexecutedReason): string {
  if (reason === "cancelled") return "cancelled";
  if (reason === "auth_failure") return "auth_failure";
  if (reason === "browserless_timeout") return "browserless_timeout";
  if (reason === "blocked") return "browserless_timeout"; // infra-class blocked
  return "cancelled"; // not_started → persisted as cancelled+not_executed category
}

export function buildUnexecutedRows(spec: UnexecutedSpec): Array<Record<string, unknown>> {
  const status = pickUnexecutedStatus(spec.reason);
  const failureCategory =
    spec.reason === "not_started" ? "not_started"
      : spec.reason === "blocked" ? "infrastructure_blocked"
      : spec.reason;
  const detail = spec.detail || failureCategory;
  const rows: Array<Record<string, unknown>> = [];
  for (const s of spec.scenarios) {
    if (spec.accountedIds.has(s.id)) continue;
    rows.push({
      run_id: spec.runId,
      scenario_id: s.id,
      status,
      expected: { error: detail, reason: failureCategory, unexecuted: true },
      actual: {
        error: detail,
        execution: {
          status,
          failure_category: failureCategory,
          error: detail,
          unexecuted: true,
        },
      },
      diff: { failure_category: failureCategory, error: detail, unexecuted: true },
      criticality: s.criticality || "medium",
      severity: s.criticality || "medium",
      analysis: `Not executed: ${failureCategory}`,
    });
  }
  return rows;
}

export function reconcileInvariant(expected: number, terminal: number, unexecuted: number): boolean {
  return expected === terminal + unexecuted;
}

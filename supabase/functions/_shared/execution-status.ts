export type ExecutionOutcome = "passed" | "comparison_failed" | "execution_failed" | "partial" | "cancelled" | "pending";
const cancelled = /^(cancelled|canceled)$/i;
const failure = /auth|browserless|timeout|navigation|filter.*(fail|unverified)|execution.*fail|scrape.*fail|error/i;
export function executionErrors(value: unknown, depth = 0, seen = new Set<object>()): string[] {
  if (!value || typeof value !== "object" || depth > 12 || seen.has(value)) return [];
  seen.add(value);
  const node = value as Record<string, any>;
  const errors: string[] = [];
  if (node.ok === false) errors.push(String(node.error || node.message || "Execution failed"));
  else if (typeof node.error === "string" && node.error.trim()) errors.push(node.error);
  if (node.filter_verification?.ok === false) errors.push("Filter verification failed");
  for (const [key, child] of Object.entries(node)) {
    // Business data/table cells are not execution metadata.
    if (["rows", "data", "headers", "columns", "diff"].includes(key)) continue;
    if (child && typeof child === "object") errors.push(...executionErrors(child, depth + 1, seen));
  }
  return errors;
}
export function deriveExecutionOutcome(row: any, comparison: "pass" | "fail" | "pending"): ExecutionOutcome {
  const statuses = [row?.status, row?.actual?.execution_status, row?.expected?.execution_status,
    row?.actual?.execution?.failure_category, row?.actual?.execution?.status,
    row?.expected?.execution?.failure_category, row?.diff?.__execution?.failure_category].map(s => String(s ?? ""));
  if (statuses.some(s => cancelled.test(s))) return "cancelled";
  if (statuses.some(s => failure.test(s)) || executionErrors(row?.actual).length || executionErrors(row?.expected).length) return "execution_failed";
  if (statuses.some(s => /partial/i.test(s))) return "partial";
  if (statuses.some(s => /^(pending|running|queued|unresolved|unexecuted)$/i.test(s))) return "pending";
  return comparison === "pass" ? "passed" : comparison === "fail" ? "comparison_failed" : "pending";
}
export function outcomeStatus(outcome: ExecutionOutcome): "pass" | "fail" | "pending" {
  return outcome === "passed" ? "pass" : outcome === "pending" ? "pending" : "fail";
}
export function outcomeCounts(outcomes: ExecutionOutcome[]) {
  const count = (outcome: ExecutionOutcome) => outcomes.filter(o => o === outcome).length;
  const passed = count("passed"), comparison_failed = count("comparison_failed"), execution_failed = count("execution_failed"), partial = count("partial"), cancelledCount = count("cancelled"), pending = count("pending");
  return { passed, comparison_failed, execution_failed, partial, cancelled: cancelledCount, pending, unresolved: pending, pass: passed, fail: comparison_failed + execution_failed + partial, total: outcomes.length };
}
type FinalizationLog = (event: string, details: Record<string, unknown>) => void;

/** Preserve useful diagnostics without serializing responses or credentials. */
export function describeDatabaseError(error: any): string {
  if (typeof error === "string" && error) return error.slice(0, 500);
  const detail = [error?.message, error?.error_description, error?.error, error?.details, error?.hint]
    .find((value) => typeof value === "string" && value.trim());
  const code = typeof error?.code === "string" ? ` (${error.code})` : "";
  return `${detail || "Database request failed without an error message"}${code}`.slice(0, 500);
}

function isTemporaryFailure(error: any, status?: number): boolean {
  // Authentication, permissions, and invalid queries must not be retried.
  if (status === 401 || status === 403 || /^(28|42|PGRST)/.test(String(error?.code || ""))) return false;
  if (status === 408 || status === 429 || (status != null && status >= 500)) return true;
  if (/^(08|40001|40P01|53|57)/.test(String(error?.code || ""))) return true;
  return /timeout|timed out|failed to fetch|fetch failed|network|connection|temporarily|econn|socket/i.test(describeDatabaseError(error));
}

export async function retryDatabaseOperation(
  operation: () => PromiseLike<any>,
  name: string,
  log: FinalizationLog = () => {},
): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    let result: any;
    try {
      result = await operation();
    } catch (error) {
      result = { data: null, error };
    }
    if (!result.error || attempt >= 2 || !isTemporaryFailure(result.error, result.status)) return result;
    log("child_finalization_retry", { operation: name, attempt: attempt + 1, http_status: result.status ?? null, error: describeDatabaseError(result.error) });
    await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
  }
}

// Atomically merge a child report's contribution into the workstream parent run.
// The database function locks the parent row before incrementing `done`. Doing
// this as a client-side read/modify/write loses increments when hosted child
// invocations finish concurrently, leaving the parent permanently "running".
export async function finalizeChild(sb: any, runId: string, reportId: string, addPass: number, addFail: number, hadError: boolean, errMsg?: string, jsonLog: FinalizationLog = () => {}) {
  jsonLog("child_finalization_started", {
    run_id: runId, report_id: reportId, add_pass: addPass, add_fail: addFail,
    had_error: hadError, error: errMsg?.slice(0, 500) || null,
  });
  const { error } = await retryDatabaseOperation(() => sb.rpc("finalize_workstream_report", {
    p_run_id: runId,
    p_report_id: reportId,
    p_add_pass: addPass,
    p_add_fail: addFail,
    p_had_error: hadError,
    p_error_message: errMsg || null,
  }), "finalization RPC", jsonLog);
  if (!error) {
    jsonLog("child_finalization_completed", { run_id: runId, report_id: reportId, method: "rpc" });
    return;
  }
  jsonLog("child_finalization_rpc_failed", { run_id: runId, report_id: reportId, error: describeDatabaseError(error) });

  // Portable fallback (same rules as the SQL function): one entry per report,
  // compare-and-swap on summary so concurrent children don't clobber each other.
  for (let attempt = 0; attempt < 12; attempt++) {
    const { data: current, error: readError } = await retryDatabaseOperation(() => sb
      .from("runs").select("summary, status").eq("id", runId).maybeSingle(), "read workstream run", jsonLog);
    if (readError) throw new Error(`Failed to read workstream run: ${describeDatabaseError(readError)}`);
    if (!current || current.status !== "running") return;
    const summary: any = current.summary || {};
    const reports: Record<string, any> = { ...(summary.reports || {}) };
    if (reports[reportId]) return; // already recorded
    reports[reportId] = { status: hadError ? "error" : "done", pass: addPass, fail: addFail, error: errMsg || null };
    const entries = Object.values(reports);
    const done = entries.length;
    const failedReports = entries.filter((r: any) => r.status === "error").length;
    const childCount = Number(summary.child_count || 0);
    const errors = hadError
      ? [...(Array.isArray(summary.errors) ? summary.errors : []), errMsg || "report error"]
      : summary.errors;
    const nextSummary: any = {
      ...summary,
      pass: Number(summary.pass || 0) + addPass,
      fail: Number(summary.fail || 0) + addFail,
      total: Number(summary.total || 0) + addPass + addFail,
      done,
      failed_reports: failedReports,
      reports,
    };
    if (errors?.length) nextSummary.errors = errors;
    const patch: any = { summary: nextSummary };
    if (childCount > 0 && done >= childCount) {
      patch.status = failedReports > 0 ? "failed" : "completed";
      patch.finished_at = new Date().toISOString();
    }
    const { data: updated, error: updateError } = await retryDatabaseOperation(() => sb
      .from("runs").update(patch).eq("id", runId).eq("status", "running")
      .filter("summary", "eq", JSON.stringify(summary)).select("id").maybeSingle(), "save report totals", jsonLog);
    if (updateError) throw new Error(`Failed to finalize workstream report: ${describeDatabaseError(updateError)}`);
    if (updated) {
      jsonLog("child_finalization_completed", {
        run_id: runId, report_id: reportId, method: "compare_and_swap", attempt: attempt + 1,
      });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25 + attempt * 25));
  }
  throw new Error(`Failed to finalize workstream report after retries: ${describeDatabaseError(error)}`);
}


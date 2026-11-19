import { verifyFilterEvidence } from "../_shared/filter-verification.ts";
import { createTimingCollector } from "../_shared/run-timing.ts";
import { parse } from "npm:acorn@^8.15.0";
import { instrumentReportTiming } from "../_shared/script-timing.ts";
import { prepareReportExecution } from "../_shared/report-login-safety.ts";
import { retryTransient } from "../_shared/transient-retry.ts";
import { combinationId, matchCombination } from "../_shared/combination-identity.ts";
import { deriveExecutionOutcome, outcomeCounts } from "../_shared/execution-status.ts";
import { comboExecutionError, lookupConfiguredKpiValue, pickComboKpis, selectComboNode } from "../_shared/brand-extraction.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { getServiceClient, getSupabaseForAccessToken, getSupabaseForRequest, requireAuth } from "../_shared/auth.ts";
import { internalAuthSource, resolveFunctionAuth, resolveFunctionUrl } from "../_shared/internal-functions.ts";
import { RunSession, getRunSession, registerRunSession, releaseRunSession } from "../_shared/run-session.ts";
import { extractFirstTableAlias, qualifyColumn } from "../_shared/sql-filter.ts";
import { fetchCanonicalScript, scriptHasSavedCode, updateScriptRow } from "../_shared/canonical-script.ts";
import { compareTables, summarizeTableCompare, toTableModel } from "../_shared/table-compare.ts";
import {
  createRunCancellationGate,
  isRunAuthExpiredError,
  isRunCancelledError,
  mapPool,
  type CancellationContext,
  type RunCancellationGate,
} from "../_shared/run-cancellation.ts";
import { checkBrowserlessHealth } from "../_shared/browserless-health.ts";
import {
  buildUnexecutedRows,
  type UnexecutedReason,
} from "../_shared/run-accounting.ts";
import {
  assessConfiguredCompleteness,
  buildExecutionAudit,
  classifyRuntimePayload,
  finalizeTargetOutcome,
  statusFromCategory,
  type ExtractionFailureCategory,
} from "../_shared/extraction-outcome.ts";
import { missingRequiredStructuredExtraction } from "../_shared/structured-extraction-retry.ts";

async function checkedWrite(query: PromiseLike<any>, context: string) {
  const result = await query;
  if (result.error) throw new Error(`${context}: ${errorDetail(result.error)}`);
  return result;
}

async function loadCompleteRows(query: (start: number, end: number) => PromiseLike<any>): Promise<any[]> {
  const rows: any[] = [];
  for (let start = 0; ; start += 1000) {
    const response = await query(start, start + 999);
    if (response.error) throw new Error(`Result accounting query failed: ${errorDetail(response.error)}`);
    rows.push(...(response.data || []));
    if (!response.data || response.data.length < 1000) return rows;
  }
}

/** Persist explicit not-executed rows so expected work cannot vanish from accounting. */
async function persistUnexecutedScenarios(
  sb: any,
  runId: string,
  scenarios: Array<{ id: string; criticality?: string | null }>,
  reason: UnexecutedReason,
  detail?: string | null,
): Promise<number> {
  if (!scenarios?.length) return 0;
  const ids = scenarios.map((s) => s.id);
  const existing = await loadCompleteRows((start, end) => sb.from("test_results").select("scenario_id,actual,expected,created_at,id").eq("run_id", runId).in("scenario_id", ids).order("id").range(start, end));
  const matrixData = await loadCompleteRows((start, end) => sb.from("scenario_filter_matrix").select("id,scenario_id,label,filters").in("scenario_id", ids).order("id").range(start, end));
  const units = scenarios.flatMap(scenario => {
    const matrix = matrixData.filter((combo: any) => combo.scenario_id === scenario.id);
    return matrix.length ? matrix.map((combo: any) => ({ ...scenario, combo_id: combo.id, label: combo.label, filters: combo.filters })) : [scenario];
  });
  const accountedIds = new Set<string>();
  for (const unit of units) {
    const rows = (existing || []).filter((row: any) => row.scenario_id === unit.id);
    if (unit.combo_id ? matchCombination(units.filter((other: any) => other.id === unit.id).map((other: any) => ({ ...other, id: other.combo_id })), { ...unit, id: unit.combo_id }, rows) : rows.length) {
      accountedIds.add(`${unit.id}:${unit.combo_id || "__single__"}`);
    }
  }
  const rows = buildUnexecutedRows({ runId, scenarios: units, accountedIds, reason, detail });
  if (!rows.length) return 0;
  const { error: insertError } = await sb.from("test_results").insert(rows);
  if (insertError) {
    jsonLog("unexecuted_account_insert_failed", {
      run_id: runId, count: rows.length, error: errorDetail(insertError).slice(0, 300),
    });
    throw new Error(`Missing-work insert failed: ${errorDetail(insertError)}`);
  }
  jsonLog("unexecuted_scenarios_accounted", {
    run_id: runId, count: rows.length, reason, detail: detail || null,
  });
  return rows.length;
}

function unexecutedReasonFromStop(opts: {
  cancelled?: boolean;
  authExpired?: boolean;
  browserlessInfraDown?: string | null;
}): UnexecutedReason {
  if (opts.cancelled) return "cancelled";
  if (opts.authExpired) return "auth_failure";
  if (opts.browserlessInfraDown) return "browserless_timeout";
  return "not_started";
}

function worseExtractionCategory(
  a: ExtractionFailureCategory,
  b: ExtractionFailureCategory,
): ExtractionFailureCategory {
  const rank: Record<ExtractionFailureCategory, number> = {
    cancelled: 60,
    browserless_timeout: 50,
    auth_failure: 40,
    empty_extraction: 30,
    partial_extraction: 20,
    fail: 10,
    pass: 0,
  };
  return (rank[a] || 0) >= (rank[b] || 0) ? a : b;
}

// Orchestrator: scope_type ∈ {workstream, report, scenario}.
// For each non-deferred scenario:
//   1. Ensure a Playwright script exists (auto-generate via agent-scripts if missing/empty).
//   2. Run it once via playwright-runtime (the script iterates all filter combos internally
//      and returns { "<combo label>": { "<KPI label>": number, filters_applied: {...} } }).
//   3. For each combo, run the warehouse SQL template (script.sql_template_id || report.default)
//      with a WHERE clause derived from the combo's filters + scenario_filter_key_map (FE→BE).
//   4. Compare per-KPI scraped value vs SQL scalar (or reference) and write one test_result row
//      per combo, with expected/actual maps keyed by KPI label.

const PROJECT = Deno.env.get("SUPABASE_URL");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const ORCHESTRATION_LOG_PATH = Deno.env.get("ORCHESTRATION_LOG_PATH") || "./logs/agent-orchestrate.jsonl";
let logWrite = Promise.resolve();

function jsonLog(event: string, details: Record<string, unknown> = {}) {
  const line = JSON.stringify({
    component: "agent-orchestrate",
    event,
    timestamp: new Date().toISOString(),
    ...details,
  });
  console.log(line);
  logWrite = logWrite.then(async () => {
    const split = Math.max(ORCHESTRATION_LOG_PATH.lastIndexOf("/"), ORCHESTRATION_LOG_PATH.lastIndexOf("\\"));
    if (split > 0) await Deno.mkdir(ORCHESTRATION_LOG_PATH.slice(0, split), { recursive: true });
    await Deno.writeTextFile(ORCHESTRATION_LOG_PATH, `${line}\n`, { append: true, create: true });
  }).catch((error) => console.error(JSON.stringify({
    component: "agent-orchestrate",
    event: "log_write_failed",
    timestamp: new Date().toISOString(),
    error: String(error),
  })));
}

// #region agent log
function agentDebugLog(
  hypothesisId: string,
  location: string,
  message: string,
  data: Record<string, unknown> = {},
  runId?: string | null,
) {
  fetch("http://127.0.0.1:7601/ingest/7fea574a-90a5-4c13-82f0-235afdf7c6c7", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "b772b1" },
    body: JSON.stringify({
      sessionId: "b772b1",
      runId: runId || "suite-ref",
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now(),
    }),
  }).catch(() => {});
}
// #endregion

function makeCallFn(getCallerAuthorization: () => Promise<string>) {
  return async (name: string, body: any) => {
    const callerAuthorization = await getCallerAuthorization();
    const startedAt = Date.now();
    const r = await fetch(resolveFunctionUrl(name), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: resolveFunctionAuth(name, callerAuthorization),
      },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let payload: any;
    try { payload = JSON.parse(text); } catch { payload = { raw: text, status: r.status }; }
    jsonLog(r.ok ? "internal_call_completed" : "internal_call_failed", {
      function_name: name,
      run_id: body?.existing_run_id || payload?.run_id || null,
      report_id: body?.single_report_id || null,
      auth_source: internalAuthSource(),
      http_status: r.status,
      duration_ms: Date.now() - startedAt,
      error: r.ok ? null : String(payload?.error || payload?.message || payload?.raw || `HTTP ${r.status}`).slice(0, 500),
    });
    if (!r.ok) {
      const detail = payload?.error || payload?.message || payload?.raw || `HTTP ${r.status}`;
      return {
        ...(payload && typeof payload === "object" ? payload : {}),
        error: String(detail),
        http_status: r.status,
      };
    }
    return payload;
  };
}

// Atomically merge a child report's contribution into the workstream parent run.
// The database function locks the parent row before incrementing `done`. Doing
// this as a client-side read/modify/write loses increments when hosted child
// invocations finish concurrently, leaving the parent permanently "running".
function errorDetail(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object") {
    const value = error as Record<string, unknown>;
    const parts = ["message", "details", "hint", "code"]
      .map((key) => value[key])
      .filter((part) => typeof part === "string" && part.trim());
    if (parts.length) return parts.join(" | ");
    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== "{}") return serialized;
    } catch {
      // Fall through to the generic description.
    }
  }
  return "unknown database error";
}

async function retryFinalizationOperation<T>(
  operation: () => Promise<T>,
  getError: (result: T) => unknown,
  attempts = 3,
): Promise<T> {
  return retryTransient(operation, getError, attempts);
}

async function finalizeChild(sb: any, runId: string, reportId: string, addPass: number, addFail: number, hadError: boolean, errMsg?: string) {
  jsonLog("child_finalization_started", {
    run_id: runId, report_id: reportId, add_pass: addPass, add_fail: addFail,
    had_error: hadError, error: errMsg?.slice(0, 500) || null,
  });
  let rpcResult: any;
  try { rpcResult = await retryFinalizationOperation(
    () => sb.rpc("finalize_workstream_report", {
      p_run_id: runId,
      p_report_id: reportId,
      p_add_pass: addPass,
      p_add_fail: addFail,
      p_had_error: hadError,
      p_error_message: errMsg || null,
    }),
    (result: any) => result?.error,
  ); } catch (error) { rpcResult = { error }; }
  const error = rpcResult?.error;
  if (!error) {
    jsonLog("child_finalization_completed", { run_id: runId, report_id: reportId, method: "rpc" });
    return;
  }
  const rpcError = errorDetail(error);
  jsonLog("child_finalization_rpc_failed", { run_id: runId, report_id: reportId, error: rpcError });

  // Portable fallback (same rules as the SQL function): one entry per report,
  // compare-and-swap on summary so concurrent children don't clobber each other.
  for (let attempt = 0; attempt < 12; attempt++) {
    const { data: current, error: readError } = await retryFinalizationOperation(
      () => sb.from("runs").select("summary, status").eq("id", runId).maybeSingle(),
      (result: any) => result?.error,
    );
    if (readError) {
      throw new Error(`Could not finalize report because the parent run could not be read: ${errorDetail(readError)} (RPC: ${rpcError})`);
    }
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
    const { data: updated, error: updateError } = await retryFinalizationOperation(
      () => sb.from("runs").update(patch).eq("id", runId).eq("status", "running")
        .filter("summary", "eq", JSON.stringify(summary)).select("id").maybeSingle(),
      (result: any) => result?.error,
    );
    if (updateError) throw new Error(`Failed to finalize workstream report: ${errorDetail(updateError)} (RPC: ${rpcError})`);
    if (updated) {
      jsonLog("child_finalization_completed", {
        run_id: runId, report_id: reportId, method: "compare_and_swap", attempt: attempt + 1,
      });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25 + attempt * 25));
  }
  throw new Error(`Failed to finalize workstream report after retries: ${rpcError}`);
}

function orchestrateConcurrency(override?: unknown): number {
  const fromBody = Number(override);
  if (Number.isFinite(fromBody) && fromBody >= 1) return Math.min(10, Math.floor(fromBody));
  const raw = Deno.env.get("ORCHESTRATE_CONCURRENCY") || Deno.env.get("BROWSERLESS_CONCURRENT") || "3";
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.min(10, Math.floor(n)) : 3;
}

async function findActiveRunConflict(
  sb: any,
  scopeType: string,
  scopeId: string,
  excludeRunId?: string,
) {
  const { data: active, error: activeError } = await sb
    .from("runs")
    .select("id, scope_type, scope_id, started_at")
    .eq("status", "running")
    .in("scope_type", ["scenario", "report", "workstream"])
    .order("started_at", { ascending: true })
    .limit(1000);
  if (activeError) throw activeError;
  const candidates = (active || []).filter((run: any) => run.id !== excludeRunId);
  if (!candidates.length) return null;

  let reportId: string | null = null;
  let workstreamId: string | null = null;
  if (scopeType === "scenario") {
    const { data: scenario, error } = await sb
      .from("scenarios")
      .select("report_id, reports(workstream_id)")
      .eq("id", scopeId)
      .maybeSingle();
    if (error) throw error;
    reportId = scenario?.report_id || null;
    const report = Array.isArray(scenario?.reports) ? scenario.reports[0] : scenario?.reports;
    workstreamId = report?.workstream_id || null;
  } else if (scopeType === "report") {
    reportId = scopeId;
    const { data: report, error } = await sb
      .from("reports")
      .select("workstream_id")
      .eq("id", scopeId)
      .maybeSingle();
    if (error) throw error;
    workstreamId = report?.workstream_id || null;
  } else if (scopeType === "workstream") {
    workstreamId = scopeId;
  }

  const scenarioIds = Array.from(new Set(candidates
    .filter((run: any) => run.scope_type === "scenario" && run.scope_id)
    .map((run: any) => run.scope_id)));
  const directReportIds = candidates
    .filter((run: any) => run.scope_type === "report" && run.scope_id)
    .map((run: any) => run.scope_id);

  const scenarioReport = new Map<string, string>();
  if (scenarioIds.length) {
    const { data, error } = await sb
      .from("scenarios")
      .select("id, report_id")
      .in("id", scenarioIds);
    if (error) throw error;
    for (const row of data || []) {
      if (row.id && row.report_id) scenarioReport.set(row.id, row.report_id);
    }
  }

  const allReportIds = Array.from(new Set([
    ...directReportIds,
    ...Array.from(scenarioReport.values()),
  ]));
  const reportWorkstream = new Map<string, string>();
  if (allReportIds.length) {
    const { data, error } = await sb
      .from("reports")
      .select("id, workstream_id")
      .in("id", allReportIds);
    if (error) throw error;
    for (const row of data || []) {
      if (row.id && row.workstream_id) reportWorkstream.set(row.id, row.workstream_id);
    }
  }

  return candidates.find((run: any) => {
    if (run.scope_type === "workstream") {
      return run.scope_id === workstreamId;
    }
    if (run.scope_type === "report") {
      const activeReportId = run.scope_id;
      if (scopeType === "scenario" || scopeType === "report") return activeReportId === reportId;
      return reportWorkstream.get(activeReportId) === workstreamId;
    }
    if (run.scope_type === "scenario") {
      if (scopeType === "scenario") return run.scope_id === scopeId;
      const activeReportId = scenarioReport.get(run.scope_id);
      if (scopeType === "report") return activeReportId === reportId;
      return !!activeReportId && reportWorkstream.get(activeReportId) === workstreamId;
    }
    return false;
  }) || null;
}



function toNum(v: any): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function isNumericScalar(v: any): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v !== "string") return false;
  return /^\s*[-+]?[$€£]?\s*\d[\d,\s]*(?:\.\d+)?\s*%?\s*$/.test(v);
}

function preserveScalar(v: any): any {
  if (v == null || typeof v === "object") return v;
  if (typeof v === "string" && !isNumericScalar(v)) return v.trim();
  return toNum(v);
}

function isIdentifierKpi(label: string): boolean {
  return /\b(phone|telephone|mobile|zip|zipcode|zip code|postal|postal code)\b/i.test(label);
}

function preserveConfiguredScalar(v: any, label: string): any {
  if (v == null || typeof v === "object") return v;
  if (isIdentifierKpi(label)) return String(v).trim();
  return preserveScalar(v);
}

function normalizeTextScalar(v: any): string {
  return String(v ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function normKpiKey(k: string): string {
  return String(k || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function configuredStructuredKpiAlias(rawKey: string, configuredLabels: string[]): string {
  const exact = configuredLabels.find((label) => normKpiKey(label) === normKpiKey(rawKey));
  if (exact) return exact;
  // A single configured KPI is an unambiguous alias for a lone extracted
  // grid/graph key such as "tableData". With multiple configured KPIs we keep
  // the raw key rather than attaching the table to the wrong KPI.
  return configuredLabels.length === 1 ? configuredLabels[0] : rawKey;
}

/** True when a looked-up KPI is already a usable scalar (incl. 0) — not a grid. */
function isUsableScalarKpi(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (typeof value === "string") return value.trim() !== "";
  return false;
}

/**
 * Record-count / KPI scrapes often also emit incidental tables (question lists,
 * filter option inventories). Never promote those onto a configured KPI that
 * already resolved to a scalar — that stomped "Row Count - Question 5"=0 with a
 * question-list grid and showed Actual "No grid data" vs wrong Reference table.
 */
function configuredKpiOwnsScalar(
  label: string | null | undefined,
  map: Record<string, any> | null | undefined,
  aliases: Record<string, string> | null | undefined,
): boolean {
  if (!label) return false;
  const raw = lookupConfiguredKpiValue(map, label, aliases);
  return isUsableScalarKpi(raw) && !isStructuredVal(raw);
}

function lookupKpiValue(map: Record<string, any> | null | undefined, name: string): any {
  if (!map || typeof map !== "object") return undefined;
  if ((map as any)[name] !== undefined) return (map as any)[name];
  const want = normKpiKey(name);
  const exact = Object.keys(map).find((key) => normKpiKey(key) === want);
  if (exact) return (map as any)[exact];
  // Legacy scripts often emit "Row Count - <title>" while the configured KPI is "Count".
  if (want === "count") {
    const rowCounts = Object.keys(map).filter((key) => /^rowcount/.test(normKpiKey(key)));
    if (rowCounts.length === 1) return (map as any)[rowCounts[0]];
  }
  return undefined;
}

function lookupKpiTol(tols: Record<string, any> | null | undefined, name: string): any {
  if (!tols || typeof tols !== "object") return undefined;
  if ((tols as any)[name] !== undefined) return (tols as any)[name];
  const want = normKpiKey(name);
  const exact = Object.keys(tols).find((key) => normKpiKey(key) === want);
  return exact ? (tols as any)[exact] : undefined;
}

/**
 * Refresh-date KPIs ("Sep 11 - 2026", "6/30/2026", "30 Jun 2026") must NOT go
 * through toNum: stripping non-digits leaves "11-2026" and parseFloat returns
 * 11, so the Latest-result tab showed a bare day-of-month instead of the date.
 * Dates are stored as text for display, then compared by calendar day with
 * the configured KPI operator (eq/lte/gte/gt/lt).
 */
const DATE_VALUE_RE = new RegExp(
  [
    String.raw`\d{1,2}\s*[\/.\-]\s*\d{1,2}\s*[\/.\-]\s*\d{2,4}`,        // 6/30/2026
    String.raw`[A-Za-z]{3,9}\.?\s+\d{1,2}\s*[-,]?\s*\d{2,4}`,            // Sep 11 - 2026
    String.raw`\d{1,2}\s+[A-Za-z]{3,9}\.?\s*[-,]?\s*\d{2,4}`,            // 30 Jun 2026
    String.raw`\d{4}-\d{2}-\d{2}`,                                       // 2026-09-11
  ].join("|"),
  "i",
);

function looksLikeDateValue(v: any): boolean {
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (!s) return false;
  return DATE_VALUE_RE.test(s);
}

function normalizeDateText(v: any): string {
  return String(v ?? "").replace(/\s+/g, " ").replace(/\s*[-,]\s*/g, " ").trim().toLowerCase();
}

const MONTH_INDEX: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

function utcDateValue(year: number, month: number, day: number): number | null {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  const ts = Date.UTC(year, month, day);
  const d = new Date(ts);
  return d.getUTCFullYear() === year && d.getUTCMonth() === month && d.getUTCDate() === day ? ts : null;
}

function parseDateValue(v: any): number | null {
  if (!looksLikeDateValue(v)) return null;
  const raw = String(v ?? "").trim();
  const yearFirst = raw.match(/^(\d{4})\s*-\s*(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (yearFirst) return utcDateValue(Number(yearFirst[1]), Number(yearFirst[2]) - 1, Number(yearFirst[3]));

  const numeric = raw.match(/^(\d{1,2})\s*[\/.\-]\s*(\d{1,2})\s*[\/.\-]\s*(\d{2,4})$/);
  if (numeric) return utcDateValue(Number(numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3]), Number(numeric[1]) - 1, Number(numeric[2]));

  const monthFirst = raw.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})\s*[-,]?\s*(\d{2,4})$/);
  if (monthFirst) return utcDateValue(Number(monthFirst[3].length === 2 ? `20${monthFirst[3]}` : monthFirst[3]), MONTH_INDEX[monthFirst[1].toLowerCase()], Number(monthFirst[2]));

  const dayFirst = raw.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s*[-,]?\s*(\d{2,4})$/);
  if (dayFirst) return utcDateValue(Number(dayFirst[3].length === 2 ? `20${dayFirst[3]}` : dayFirst[3]), MONTH_INDEX[dayFirst[2].toLowerCase()], Number(dayFirst[1]));
  return null;
}

function evalDatePass(actual: any, expected: any, op: string, toleranceDays = 0): boolean | null {
  const a = parseDateValue(actual);
  const e = parseDateValue(expected);
  if (a == null || e == null) return normalizeDateText(actual) === normalizeDateText(expected);
  const allowance = Math.abs(Number(toleranceDays) || 0) * 24 * 60 * 60 * 1000;
  if (op === "lte") return a <= e + allowance;
  if (op === "gte") return a >= e - allowance;
  if (op === "gt") return a > e + allowance;
  if (op === "lt") return a < e - allowance;
  return Math.abs(a - e) <= allowance;
}

const STRUCTURED_KPI_KEYS = new Set(["grid", "graph", "data", "table", "tabledata", "series", "chart", "rows", "heatmap", "viz", "dataset"]);

function isExtractionNoiseKey(k: string): boolean {
  const normalized = normKpiKey(k);
  if (!normalized || String(k || "").startsWith("__")) return true;
  if ([
    "filtersapplied", "screenshot", "ok", "error", "url", "title", "note",
    "result", "extracted", "navigation",
  ].includes(normalized)) return true;
  return [
    "gridready", "debug", "showdata", "navigation", "filters",
  ].some((suffix) => normalized.endsWith(suffix));
}

function isStructuredVal(v: any): boolean {
  if (v == null || typeof v === "boolean") return false;
  if (toTableModel(v)) return true;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v !== "object") return false;
  return Object.entries(v).some(([k, nested]) => {
    if (!STRUCTURED_KPI_KEYS.has(normKpiKey(k))) return false;
    if (Array.isArray(nested)) return nested.length > 0;
    if (!nested || typeof nested !== "object") return false;
    return Object.values(nested).some((value) =>
      Array.isArray(value) ? value.length > 0 : Boolean(value && typeof value === "object")
    );
  });
}

function pickStructured(map: Record<string, any> | null | undefined): { k: string; v: any } | null {
  if (!map || typeof map !== "object") return null;
  for (const k of Object.keys(map)) {
    if (isExtractionNoiseKey(k)) continue;
    if (STRUCTURED_KPI_KEYS.has(k.toLowerCase().replace(/[^a-z0-9]/g, "")) && map[k] && typeof map[k] === "object") {
      if (isStructuredVal({ [k]: map[k] })) return { k, v: map[k] };
    }
  }
  for (const [k, v] of Object.entries(map)) {
    if (isExtractionNoiseKey(k)) continue;
    if (isStructuredVal(v)) return { k, v };
  }
  return null;
}

function pickComparableStructured(map: Record<string, any> | null | undefined): { k: string; v: any } | null {
  if (!map || typeof map !== "object") return null;
  return pickStructured(Object.fromEntries(
    Object.entries(map).filter(([key]) => !/pcc.*verification/i.test(key)),
  ));
}

function structuredEqual(a: any, b: any): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function evalAssertion(actual: number | null, expected: number | null, tol: number) {
  if (actual == null || expected == null) return { pass: false, diff: null as number | null };
  const diff = Math.abs(actual - expected) / Math.max(Math.abs(expected), 1e-9);
  return { pass: diff <= tol, diff };
}

function computeCriticality(scenarioCrit: string, diffPct: number | null): string {
  const base = ["low", "medium", "high", "critical"].indexOf(scenarioCrit || "medium");
  let bump = 0;
  if (diffPct != null) {
    if (diffPct > 0.25) bump = 2;
    else if (diffPct > 0.1) bump = 1;
  }
  const idx = Math.min(3, Math.max(0, base + bump));
  return ["low", "medium", "high", "critical"][idx];
}

function normComboLabel(s: string): string {
  return String(s || "").toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
}

function flattenExtractionRoot(c: any): any {
  if (!c || typeof c !== "object" || Array.isArray(c)) return null;
  if (c.results && typeof c.results === "object" && !Array.isArray(c.results)) {
    return flattenExtractionRoot(c.results);
  }
  if (c.kpis && typeof c.kpis === "object" && !Array.isArray(c.kpis)) {
    return flattenExtractionRoot(c.kpis);
  }
  if (c.values && typeof c.values === "object" && !Array.isArray(c.values)
    && !Array.isArray(c.values.columns) && !Array.isArray(c.values.rows)) {
    const nestedKeys = Object.keys(c.values).filter((k) => !isExtractionNoiseKey(k));
    if (nestedKeys.length && nestedKeys.every((k) => {
      const v = (c.values as any)[k];
      return v && typeof v === "object" && !Array.isArray(v) && !isStructuredVal(v);
    })) {
      return flattenExtractionRoot(c.values);
    }
  }
  // Browserless wrapper: { ok, error, result, url }
  if (c.result && typeof c.result === "object" && !Array.isArray(c.result)
    && ("ok" in c || "error" in c || "url" in c || "extracted" in c || "screenshot" in c)) {
    return flattenExtractionRoot(c.result);
  }
  if (c.extracted && typeof c.extracted === "object" && !Array.isArray(c.extracted)) {
    return flattenExtractionRoot(c.extracted);
  }
  return c;
}

function flattenNodeToKpis(node: any): Record<string, any> {
  return pickComboKpis({ result: node }, null) || {};
}

/** "Total / AA52 - Northeast / Total / R4W" from the case's filter map (not a stale label). */
function labelFromFilterValues(filters: any): string {
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) return "";
  const vals = Object.entries(filters)
    .filter(([key]) => key && !String(key).startsWith("__"))
    .map(([, value]) => {
      if (value == null) return "";
      if (typeof value === "object") {
        return String(
          (value as any).option ?? (value as any).verified ?? (value as any).value ?? "",
        ).trim();
      }
      return String(value).trim();
    })
    .filter(Boolean);
  return vals.length ? vals.join(" / ") : "";
}

// Filter evidence must come from the exact combination used for KPI lookup.
function pickComboFiltersApplied(payload: any, comboLabel: string | null): Record<string, any> | null {
  const node = selectComboNode(payload, comboLabel);
  return node?.filters_applied && typeof node.filters_applied === "object"
    ? node.filters_applied : null;
}

// Include script-level errors hidden inside a successful transport envelope.
function classifyComboRuntime(payload: any, comboLabel: string | null, target: "main" | "reference") {
  const error = comboExecutionError(payload, comboLabel);
  return classifyRuntimePayload(error ? { ...payload, error } : payload, { target });
}

const EXTRACTION_MAX_ATTEMPTS = Math.max(
  1,
  Math.min(5, Number(Deno.env.get("EXTRACTION_MAX_ATTEMPTS") || 3) || 3),
);

function looksLikeStructuredKpiLabel(label: string): boolean {
  return /segment|summary|grid|graph|table|chart|series|heatmap|viz|dataset|geography|performance|overall/i
    .test(String(label || ""));
}

function hasUsableExtractionValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string" && value.trim() === "") return false;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (obj.error || obj.show_data_error || obj.extract_error) return false;
    if (obj.tableData && typeof obj.tableData === "object" && (obj.tableData as any).error) {
      return false;
    }
  }
  return true;
}

function countUsableKpis(map: Record<string, any> | null | undefined): number {
  if (!map || typeof map !== "object") return 0;
  return Object.entries(map)
    .filter(([key]) => !isExtractionNoiseKey(key))
    .filter(([, value]) => hasUsableExtractionValue(value))
    .length;
}

/** Full-matrix calls pass comboLabel=null; KPIs live under each combo child. */
function countUsableKpisInPayload(payload: any, comboLabel: string | null): number {
  const direct = countUsableKpis(pickComboKpis(payload, comboLabel));
  if (direct > 0 || comboLabel) return direct;
  const candidates = [
    payload?.extracted?.result?.results,
    payload?.extracted?.result?.kpis,
    payload?.extracted?.result?.result,
    payload?.extracted?.result,
    payload?.extracted?.extracted,
    payload?.result?.extracted,
    payload?.result?.results,
    payload?.result,
    payload?.extracted,
  ];
  let best = 0;
  for (const raw of candidates) {
    const root = flattenExtractionRoot(raw);
    if (!root || typeof root !== "object") continue;
    for (const [key, node] of Object.entries(root)) {
      if (isExtractionNoiseKey(key) || !node || typeof node !== "object" || Array.isArray(node)) {
        continue;
      }
      best = Math.max(best, countUsableKpis(flattenNodeToKpis(node)));
    }
  }
  return best;
}

/**
 * Full-matrix payloads nest one block per combo. Returns those KPI maps when
 * 2+ combo children exist so missing-grid retry can check each child (the old
 * `_multi` short-circuit skipped retries whenever any usable key existed).
 */
function collectMatrixComboValues(payload: any): Array<Record<string, any>> | null {
  const candidates = [
    payload?.extracted?.result?.results,
    payload?.extracted?.result?.kpis,
    payload?.extracted?.result?.result,
    payload?.extracted?.result,
    payload?.extracted?.extracted,
    payload?.result?.extracted,
    payload?.result?.results,
    payload?.result,
    payload?.extracted,
  ];
  for (const raw of candidates) {
    const root = flattenExtractionRoot(raw);
    if (!root || typeof root !== "object") continue;

    const children = Object.entries(root).filter(([k, v]) => {
      if (isExtractionNoiseKey(k) || String(k).startsWith("__")) return false;
      if (!v || typeof v !== "object" || Array.isArray(v)) return false;
      // Flat `{ grid: table }` — not a combo child.
      if (STRUCTURED_KPI_KEYS.has(normKpiKey(k))) return false;
      const flat = flattenNodeToKpis(v);
      return Object.keys(flat).length > 0 || isStructuredVal(v) || !!pickComparableStructured(flat);
    });

    if (children.length >= 2) {
      return children.map(([, node]) => flattenNodeToKpis(node));
    }
  }
  return null;
}

function comboExtractionNeedsRetry(
  payload: any,
  comboLabel: string | null,
  opts?: { requireStructured?: boolean; configuredLabels?: string[] },
): boolean {
  if (comboExecutionError(payload, comboLabel)) return true;
  const exec = payload?.extracted;
  const values = pickComboKpis(payload, comboLabel);
  const usableCount = countUsableKpisInPayload(payload, comboLabel);
  const requireStructured = opts?.requireStructured ||
    (opts?.configuredLabels || []).some((label) => looksLikeStructuredKpiLabel(label));

  // Grid / chart / Show Data: always retry when the structured extract is missing,
  // even if other keys (filters_applied, debug) made usableCount > 0.
  if (
    missingRequiredStructuredExtraction({
      requireStructured,
      configuredLabels: opts?.configuredLabels,
      comboLabel,
      comboValues: values,
      matrixComboValues: comboLabel ? undefined : (collectMatrixComboValues(payload) || undefined),
    })
  ) {
    return true;
  }

  // Partial success (e.g. 154 KPIs + 2 empty) must NOT retry — full-matrix
  // calls with comboLabel=null used to look "empty" and burn 3× Browserless time.
  if (usableCount > 0) {
    const grains = values?.grains && typeof values.grains === "object"
      ? Object.values(values.grains)
      : [];
    return grains.some((grain: any) =>
      /still looks weekly|no time periods extracted|could not parse/i.test(String(grain?.trend_error || ""))
    );
  }
  if (payload?.error || payload?.ok === false || exec?.ok === false || exec?.error) return true;
  if (!values || !Object.keys(values).length) return true;
  return true;
}

function swapGotoUrl(src: string, newUrl: string, oldUrl?: string): string {
  if (!src || !newUrl) return src;
  let out = src;
  // Replace every literal occurrence of the primary report URL (the auto-injected
  // auth preamble references it in multiple places, not just the first page.goto).
  if (oldUrl && oldUrl !== newUrl) {
    const esc = oldUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(esc, "g"), newUrl);
  }
  const re = /(page\s*\.\s*goto\s*\(\s*)(['"`])([^'"`]*)\2/;
  if (re.test(out) && !out.includes(newUrl)) {
    out = out.replace(re, (_m, p1, q) => `${p1}${q}${newUrl}${q}`);
  }
  return out;
}

function buildWhere(
  filters: Record<string, any>,
  keyMap: any[],
  sqlText?: string | null,
): { where: string; pairs: { be: string; value: string }[]; missing: string[] } {
  const map = new Map<string, string>((keyMap || []).map((k: any) => [k.fe_label, k.be_column]));
  const parts: string[] = [];
  const pairs: { be: string; value: string }[] = [];
  const missing: string[] = [];
  const esc = (s: string) => String(s).replace(/'/g, "''");
  const firstAlias = extractFirstTableAlias(sqlText || "");
  for (const [fe, v] of Object.entries(filters || {})) {
    const val = String(v ?? "");
    // "Total" is a UI-only sentinel — applied on the page by Playwright, but skipped in SQL WHERE.
    if (val.trim().toLowerCase() === "total") continue;
    const be = map.get(fe);
    if (!be) { missing.push(fe); continue; }
    parts.push(`${qualifyColumn(be, firstAlias)} = '${esc(val)}'`);
    pairs.push({ be, value: val });
  }
  return { where: parts.join(" AND "), pairs, missing };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const unauthorized = await requireAuth(req);
  if (unauthorized) return unauthorized;
  const rawCaller = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const body = await req.json().catch(() => ({}));
  // Without a service key (self-hosted), keep the run signed in by refreshing
  // the caller's session. Children reuse the parent's session (same process).
  let session: RunSession | undefined = getRunSession(body?.existing_run_id);
  let ownsSession = false;
  const serviceClient = getServiceClient();
  if (!serviceClient && !session) {
    const refreshToken = (req.headers.get("X-Refresh-Token") || "").trim() || null;
    session = new RunSession(rawCaller, refreshToken);
    ownsSession = true;
  }
  const getCallerAuth = async () =>
    session ? `Bearer ${await session.token()}` : (rawCaller ? `Bearer ${rawCaller}` : (SERVICE_KEY ? `Bearer ${SERVICE_KEY}` : ""));
  const callFn = makeCallFn(getCallerAuth);
  const activeSession = session;
  const sb = serviceClient ?? (activeSession
    ? getSupabaseForAccessToken(() => activeSession.token())
    : getSupabaseForRequest(req));
  jsonLog("orchestrate_auth", {
    auth_source: serviceClient ? "service" : session?.canRefresh ? "caller_refreshing" : "caller",
    run_id: body?.existing_run_id || null,
  });
  try {
    const {
      scope_type,
      scope_id,
      trigger_source = "manual",
      existing_run_id,
      single_report_id,
      single_combo_id,
      schedule_id,
      concurrency: requestedConcurrency,
    } = body;
    const concurrency = orchestrateConcurrency(requestedConcurrency);
    let comparator_override: string | null = body.comparator_override || null;
    if (!comparator_override && schedule_id) {
      const { data: sch } = await sb.from("schedules").select("comparator").eq("id", schedule_id).maybeSingle();
      if (sch?.comparator) comparator_override = sch.comparator;
    }
    if (comparator_override && !["gte","lte","eq","gt","lt"].includes(comparator_override)) comparator_override = null;

    // Resolve report ids in scope
    let reportIds: string[] = [];
    if (existing_run_id && single_report_id) {
      reportIds = [single_report_id];
    } else if (scope_type === "scenario") {
      const { data: scenario } = await sb
        .from("scenarios")
        .select("id, report_id")
        .eq("id", scope_id)
        .maybeSingle();
      if (!scenario?.report_id) throw new Error(`scenario ${scope_id} not found`);
      reportIds = [scenario.report_id];
    } else if (scope_type === "report") {
      reportIds = [scope_id];
    } else if (scope_type === "workstream") {
      const { data } = await sb.from("reports").select("id").eq("workstream_id", scope_id);
      reportIds = (data || []).map((r) => r.id);
    } else {
      throw new Error(`unsupported scope_type ${scope_type}`);
    }

    // Reuse existing run when invoked by a workstream coordinator; otherwise create one.
    let run: any;
    if (existing_run_id) {
      const { data } = await sb.from("runs").select("*").eq("id", existing_run_id).maybeSingle();
      run = data;
      if (!run) throw new Error(`run ${existing_run_id} not found`);
    } else {
      const initialSummary = scope_type === "workstream"
        ? { pass: 0, fail: 0, total: 0, done: 0, child_count: reportIds.length, concurrency }
        : { concurrency };
      const existingConflict = await findActiveRunConflict(sb, scope_type, scope_id);
      if (existingConflict) {
        return new Response(JSON.stringify({
          error: "RUN_ALREADY_ACTIVE",
          message: "An overlapping execution is already running.",
          active_run_id: existingConflict.id,
        }), {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { data } = await sb.from("runs").insert({
        scope_type,
        scope_id,
        trigger_source,
        status: "running",
        summary: initialSummary,
      }).select().single();
      run = data;
      if (!run) throw new Error("run creation failed");
      jsonLog("run_created", {
        run_id: run.id, scope_type, scope_id, report_count: reportIds.length, concurrency,
        auth_source: serviceClient ? "service" : session?.canRefresh ? "caller_refreshing" : "caller",
      });

      // Best-effort race arbitration without requiring a database migration.
      // Both concurrent callers pause before work; the later run cancels itself
      // if another overlapping run became visible.
      await new Promise((resolve) => setTimeout(resolve, 150));
      const racedConflict = await findActiveRunConflict(sb, scope_type, scope_id, run.id);
      if (racedConflict) {
        const winner = [run, racedConflict].sort((a: any, b: any) => {
          const time = new Date(a.started_at).getTime() - new Date(b.started_at).getTime();
          return time || String(a.id).localeCompare(String(b.id));
        })[0];
        if (winner.id !== run.id) {
          await checkedWrite(sb.from("runs").update({
            status: "cancelled",
            finished_at: new Date().toISOString(),
            summary: {
              ...initialSummary,
              error: "overlapping execution already running",
              active_run_id: winner.id,
            },
          }).eq("id", run.id), "Run update failed");
          return new Response(JSON.stringify({
            error: "RUN_ALREADY_ACTIVE",
            message: "An overlapping execution is already running.",
            active_run_id: winner.id,
          }), {
            status: 409,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
    }

    // Workstream coordinator: dispatch one child invocation per report (background),
    // each child processes its report and atomically finalises the parent run when last.
    if (ownsSession && session) registerRunSession(run.id, session);
    const releaseSession = () => { if (ownsSession) releaseRunSession(run.id); };

    // Cancellation must use the same RunSession-backed client as inserts/finalize.
    // getClient is invoked per status read so we never rely on a one-shot JWT.
    const cancellation: RunCancellationGate = createRunCancellationGate(run.id, {
      getClient: () => sb,
      ensureAuth: session ? () => session.token() : undefined,
      canRefresh: () => Boolean(session?.canRefresh),
      log: (event, details) => jsonLog(event, details),
    });
    // Bail out immediately when a child is started against an already-cancelled parent.
    if (existing_run_id) {
      try {
        await cancellation.refresh();
      } catch (e) {
        if (isRunAuthExpiredError(e)) {
          jsonLog("run_auth_expired_stop", {
            run_id: run.id,
            checkpoint: "child_entry",
            error: e.causeMessage.slice(0, 300),
          });
          return new Response(JSON.stringify({
            run_id: run.id,
            status: "error",
            error: "auth_expired",
          }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        throw e;
      }
      if (cancellation.isCancelled()) {
        jsonLog("run_cancellation_detected", {
          run_id: run.id,
          checkpoint: "child_entry",
          report_id: single_report_id || reportIds[0] || null,
        });
        return new Response(JSON.stringify({ run_id: run.id, status: "cancelled" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    if (!existing_run_id && scope_type === "workstream") {
      const dispatch = async () => {
        try {
          // For workstream runs, the requested concurrency controls how many
          // reports/screens run at once. Keep each child report serial so the
          // total Browserless pressure remains bounded by that setting.
          const reportConcurrency = concurrency;
          const childConcurrency = 1;
          await mapPool(reportIds, reportConcurrency, async (rid) => {
            await cancellation.throwIfCancelled({
              checkpoint: "before_report",
              report_id: rid,
            });
            try {
              jsonLog("child_dispatch_started", { run_id: run.id, report_id: rid });
              const child = await callFn("agent-orchestrate", {
                scope_type: "report",
                scope_id: rid,
                trigger_source,
                existing_run_id: run.id,
                single_report_id: rid,
                comparator_override,
                concurrency: childConcurrency,
              });
              if (child?.error || child?.ok === false) {
                throw new Error(child?.error || child?.message || "child orchestration failed");
              }
              jsonLog("child_dispatch_completed", { run_id: run.id, report_id: rid });
            } catch (e) {
              if (isRunCancelledError(e)) {
                jsonLog("run_cancellation_detected", {
                  run_id: run.id,
                  checkpoint: "child_dispatch",
                  report_id: rid,
                  ...e.context,
                });
                return;
              }
              if (isRunAuthExpiredError(e)) {
                jsonLog("run_auth_expired_stop", {
                  run_id: run.id, report_id: rid, error: e.causeMessage.slice(0, 300),
                });
                return;
              }
              jsonLog("child_dispatch_failed", {
                run_id: run.id, report_id: rid, error: errorDetail(e).slice(0, 500),
              });
              let skipFinalize = cancellation.isCancelled();
              if (!skipFinalize) {
                try {
                  skipFinalize = await cancellation.refresh();
                } catch (cancelErr) {
                  if (isRunAuthExpiredError(cancelErr) || isRunCancelledError(cancelErr)) {
                    skipFinalize = true;
                  } else {
                    throw cancelErr;
                  }
                }
              }
              if (skipFinalize) {
                jsonLog("run_cancellation_skip_finalize", {
                  run_id: run.id, report_id: rid, checkpoint: "child_dispatch_failed",
                });
                return;
              }
              try {
                await finalizeChild(sb, run.id, rid, 0, 0, true, errorDetail(e));
              } catch (finalizeError) {
                jsonLog("child_dispatch_finalization_failed", {
                  run_id: run.id, report_id: rid, error: errorDetail(finalizeError).slice(0, 1000),
                });
              }
            }
          }, () => cancellation.isCancelled());
          // After the report pool, any report that never finalized still has
          // expected scenarios with zero rows — account them, then finalize.
          try {
            const { data: parentRow } = await sb.from("runs").select("summary, status").eq("id", run.id).maybeSingle();
            const doneReports = new Set(Object.keys((parentRow?.summary as any)?.reports || {}));
            let stopReason: UnexecutedReason = "not_started";
            let stopDetail: string | null = "report_not_dispatched";
            let cancelledAfter = cancellation.isCancelled();
            try {
              if (!cancelledAfter) cancelledAfter = await cancellation.refresh();
            } catch (e) {
              if (isRunAuthExpiredError(e)) {
                stopReason = "auth_failure";
                stopDetail = e.causeMessage;
              } else if (isRunCancelledError(e)) {
                cancelledAfter = true;
              } else {
                throw e;
              }
            }
            if (cancelledAfter) {
              stopReason = "cancelled";
              stopDetail = "cancelled";
              jsonLog("run_cancellation_detected", {
                run_id: run.id,
                checkpoint: "after_report_pool",
              });
            }
            for (const rid of reportIds) {
              if (doneReports.has(rid)) continue;
              const { data: leftover } = await sb.from("scenarios")
                .select("id, criticality")
                .eq("report_id", rid)
                .eq("deferred", false);
              const n = await persistUnexecutedScenarios(
                sb, run.id, leftover || [], stopReason, stopDetail,
              );
              try {
                await finalizeChild(
                  sb, run.id, rid, 0, n, true,
                  stopDetail || stopReason,
                );
              } catch (finErr) {
                jsonLog("workstream_unstarted_finalize_failed", {
                  run_id: run.id, report_id: rid,
                  error: errorDetail(finErr).slice(0, 300),
                });
              }
            }
            if (stopReason === "auth_failure" && parentRow?.status === "running") {
              // Only mark failed if finalize_workstream_report did not already terminalize.
              const { data: after } = await sb.from("runs").select("status").eq("id", run.id).maybeSingle();
              if (after?.status === "running") {
                const admin = getServiceClient();
                await (admin || sb).from("runs").update({
                  status: "failed",
                  finished_at: new Date().toISOString(),
                  summary: {
                    ...((parentRow?.summary as any) || {}),
                    error: "auth_expired",
                    failure_category: "auth_failure",
                  },
                }).eq("id", run.id).eq("status", "running");
              }
            }
          } catch (e) {
            if (isRunAuthExpiredError(e)) {
              jsonLog("run_auth_expired_stop", {
                run_id: run.id,
                checkpoint: "after_report_pool",
                error: e.causeMessage.slice(0, 300),
              });
              return;
            }
            if (isRunCancelledError(e)) {
              jsonLog("run_cancellation_detected", {
                run_id: run.id,
                checkpoint: "after_report_pool",
              });
              return;
            }
            throw e;
          }
        } catch (e) {
          if (isRunCancelledError(e)) {
            jsonLog("run_cancellation_detected", {
              run_id: run.id,
              checkpoint: e.context?.checkpoint || "workstream_dispatch",
              ...e.context,
            });
            return;
          }
          if (isRunAuthExpiredError(e)) {
            jsonLog("run_auth_expired_stop", {
              run_id: run.id,
              checkpoint: "workstream_dispatch",
              error: e.causeMessage.slice(0, 300),
            });
            try {
              const admin = getServiceClient();
              await (admin || sb).from("runs").update({
                status: "failed",
                finished_at: new Date().toISOString(),
                summary: { error: "auth_expired", failure_category: "auth_failure" },
              }).eq("id", run.id).eq("status", "running");
            } catch { /* best-effort terminalize */ }
            return;
          }
          throw e;
        } finally {
          releaseSession();
        }
      };
      // @ts-ignore
      if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
        // @ts-ignore
        EdgeRuntime.waitUntil(dispatch());
      } else {
        dispatch().catch(() => {});
      }
      if (reportIds.length === 0) {
        // Never overwrite a user-cancelled run with completed.
        await checkedWrite(sb.from("runs").update({
          status: "completed", finished_at: new Date().toISOString(),
          summary: { pass: 0, fail: 0, total: 0, done: 0, child_count: 0 },
        }).eq("id", run.id).eq("status", "running"), "Run update failed");
      }
      return new Response(JSON.stringify({ run_id: run.id, status: "running" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Heavy work runs in the background so we don't hit the 150s edge timeout.
    // Client polls runs/test_results to observe progress.
    const work = async () => { try { await workInner(); } finally { releaseSession(); } };
    const workInner = async () => {
      let pass = 0, fail = 0;
      /** When set, stop dispatching further Browserless work and terminalize. */
      let browserlessInfraDown: string | null = null;
      // Stop subsequent units sharing credentials after an auth failure within
      // this worker. Cross-worker/process protection requires a shared breaker.
      const stoppedReportLogins = new Map<string, any>();
      try {
        const health0 = await checkBrowserlessHealth({ timeoutMs: 4000 });
        if (!health0.ok) {
          browserlessInfraDown = health0.reason || "browserless_unhealthy";
          jsonLog("browserless_health_failed", {
            run_id: run.id,
            reason: browserlessInfraDown,
            checkpoint: "before_first_report",
          });
        }
        for (const reportId of reportIds) {
          await cancellation.throwIfCancelled({
            checkpoint: "before_report",
            report_id: reportId,
          });
          const { data: report } = await sb.from("reports").select("*").eq("id", reportId).maybeSingle();
          if (!report) continue;

          const reportKpiLabels: string[] = Array.isArray(report.kpi_config)
            ? report.kpi_config.filter((x: any) => typeof x === "string")
            : (report.kpi_config && typeof report.kpi_config === "object"
                ? Object.keys(report.kpi_config) : []);

          const { data: keyMap } = await sb.from("scenario_filter_key_map")
            .select("fe_label, be_column").eq("report_id", reportId);

          let scenariosQuery = sb.from("scenarios")
            .select("id, title, type, criticality, deferred")
            .eq("report_id", reportId)
            .eq("deferred", false);
          if (scope_type === "scenario") scenariosQuery = scenariosQuery.eq("id", scope_id);
          const { data: scenarios, error: scenariosError } = await scenariosQuery;
          if (scenariosError) throw new Error(`Scenario loading failed: ${errorDetail(scenariosError)}`);

          const scenarioOutcomes = await mapPool(scenarios || [], concurrency, async (s) => {
            await cancellation.throwIfCancelled({
              checkpoint: "before_scenario",
              report_id: reportId,
              scenario_id: s.id,
            });
            if (browserlessInfraDown) {
              await cancellation.throwIfCancelled({
                checkpoint: "before_persist",
                report_id: reportId,
                scenario_id: s.id,
              });
              const earlyFailure = await sb.from("test_results").insert({
                run_id: run.id,
                scenario_id: s.id,
                status: "browserless_timeout",
                expected: { error: "browserless_unhealthy", reason: browserlessInfraDown },
                actual: {
                  error: browserlessInfraDown,
                  execution: buildExecutionAudit({
                    run_id: run.id,
                    scenario_id: s.id,
                    status: "browserless_timeout",
                    failure_category: "browserless_timeout",
                    error: browserlessInfraDown,
                  }),
                },
                diff: { failure_category: "browserless_timeout", error: browserlessInfraDown },
                criticality: s.criticality || "medium",
                severity: s.criticality || "medium",
              });
              if (earlyFailure.error) throw new Error(`Failed to persist execution failure: ${errorDetail(earlyFailure.error)}`);
              return { pass: 0, fail: 1 };
            }
            let { data: script, error: scriptErr } = await fetchCanonicalScript(
              sb,
              s.id,
              "id, playwright_code, assertion_spec, sql_template_id, created_at",
            );
            if (scriptErr) {
              await cancellation.throwIfCancelled({
                checkpoint: "before_persist",
                report_id: reportId,
                scenario_id: s.id,
              });
              const earlyFailure = await sb.from("test_results").insert({
                run_id: run.id, scenario_id: s.id, status: "fail",
                expected: { error: "script_lookup_failed" },
                actual: { error: scriptErr.message },
                diff: null, criticality: s.criticality || "medium", severity: s.criticality || "medium",
              });
              if (earlyFailure.error) throw new Error(`Failed to persist execution failure: ${errorDetail(earlyFailure.error)}`);
              return { pass: 0, fail: 1 };
            }
            // Saved scripts may contain page-specific selectors that generic
            // templates cannot reproduce. Never replace them automatically;
            // regeneration remains an explicit operator action.
            if (!scriptHasSavedCode(script)) {
              const gen = await callFn("agent-scripts", { scenario_id: s.id });
              if (gen?.script?.playwright_code) {
                script = gen.script;
              } else {
                await cancellation.throwIfCancelled({
                  checkpoint: "before_persist",
                  report_id: reportId,
                  scenario_id: s.id,
                });
                const earlyFailure = await sb.from("test_results").insert({
                  run_id: run.id, scenario_id: s.id, status: "fail",
                  expected: { error: "script_generation_failed" },
                  actual: { error: gen?.message || gen?.error || "agent-scripts returned no code" },
                  diff: null, criticality: s.criticality || "medium", severity: s.criticality || "medium",
                });
              if (earlyFailure.error) throw new Error(`Failed to persist execution failure: ${errorDetail(earlyFailure.error)}`);
                return { pass: 0, fail: 1 };
              }
            }

            // Case-level KPI configuration is the source of truth. Report KPI
            // config is only a default for legacy cases that have no saved KPI
            // list or tolerances in their assertion spec.
            // Match Solo (ScenarioDetail Run headless): send the raw saved script.
            // withCurrentFilterCore here made Brand ≠ Solo bytes and caused intermittent
            // empty Actual while Solo Latest result extracted the same scenario fine
            // (see BRAND_EXTRACTION_RCA_RECONCILED.md — SCRIPT_TRANSFORM_DIVERGENCE).
            // Filter-core upgrades still land on Generate/Regenerate into the saved script.
            const executableCode = String((script as any)?.playwright_code || "");
            const assertionSpec: any = (script as any)?.assertion_spec || {};
            const configuredKpis: string[] = Array.isArray(assertionSpec.kpis)
              ? assertionSpec.kpis
                  .map((x: any) =>
                    typeof x === "string"
                      ? x
                      : (x && typeof x === "object" ? (x.label || x.name || "") : "")
                  )
                  .filter((x: any) => typeof x === "string" && x.trim())
              : (assertionSpec.kpis && typeof assertionSpec.kpis === "object"
                  ? Object.keys(assertionSpec.kpis) : []);
            const toleranceKpis = assertionSpec.kpi_tolerances &&
                typeof assertionSpec.kpi_tolerances === "object"
              ? Object.keys(assertionSpec.kpi_tolerances)
              : [];
            // Add/Remove KPIs updates kpi_tolerances. Treat that map as the
            // current case configuration so a stale legacy `kpis` array cannot
            // reintroduce a KPI that the user removed.
            const preferredKpis = toleranceKpis.length
              ? toleranceKpis
              : (configuredKpis.length ? configuredKpis : reportKpiLabels);
            const kpiLabels: string[] = Array.from(new Set<string>(
              preferredKpis
                .map((label: any) => String(label || "").trim())
                .filter((label: string) => label && !label.startsWith("__")),
            ));
            const kpiAliases: Record<string, string> =
              assertionSpec.kpi_aliases && typeof assertionSpec.kpi_aliases === "object"
                ? assertionSpec.kpi_aliases
                : {};
            const isPccScenario = /\bpcc\b/i.test(String(s.title || ""));
            // Names configured as KPIs are business values, not verification
            // metadata. Include them in both extraction maps and comparison so
            // a missing physician/HCP/account name is recorded as a failure.
            const comparisonKpiLabels = kpiLabels;

            let matrixQuery = sb.from("scenario_filter_matrix")
              .select("id, label, filters").eq("scenario_id", s.id)
              .order("created_at", { ascending: true });
            if (single_combo_id) matrixQuery = matrixQuery.eq("id", single_combo_id);
            const matrix = await loadCompleteRows((start, end) => matrixQuery.order("id").range(start, end));
            if (single_combo_id && !matrix?.length) {
              throw new Error(`filter combination ${single_combo_id} was not found for scenario ${s.id}`);
            }
            const hasCombos = !!(matrix && matrix.length > 0);
            // Name always from current filter values so an edited combo does not
            // keep a stale stored label on the next run.
            const combos = hasCombos
              ? (matrix || []).map((m: any, i: number) => {
                  const filters = m.filters || {};
                  const derived = labelFromFilterValues(filters);
                  return {
                    id: m.id,
                    label: derived || m.label || `combo_${i + 1}`,
                    filters,
                  };
                })
              : [{ id: null, label: null as string | null, filters: {} as Record<string, any> }];

            const isRef = s.type === "reference_match";
            const isTrend = s.type === "trend";
            let sqlTplId = (isRef || isTrend) ? null : ((script as any)?.sql_template_id || (report as any)?.default_sql_template_id || null);

            // Prepare reference script first (no browser) so main + reference can scrape in parallel.
            let refCode = "";
            let refError: string | null = null;
            if (isRef) {
              const refUrl: string = (report as any)?.reference_url || "";
              const primaryUrl: string = (report as any)?.url || "";
              const aspec: any = (script as any)?.assertion_spec || {};
              refCode = aspec.__reference_playwright_code || "";
              if (!refCode || !refCode.trim()) {
                const isEnvSwap = !!refUrl && !!primaryUrl && refUrl !== primaryUrl;
                if (isEnvSwap) {
                  refCode = swapGotoUrl(executableCode, refUrl, primaryUrl);
                  if (refCode && (script as any)?.id) {
                    await updateScriptRow(sb, (script as any).id, {
                      assertion_spec: { ...aspec, __reference_playwright_code: refCode, __reference_generated_by: "url_swap" },
                    });
                  }
                } else {
                  const gen = await callFn("agent-scripts", { scenario_id: s.id, target: "reference" });
                  const genSpec: any = gen?.script?.assertion_spec || {};
                  refCode = genSpec.__reference_playwright_code || "";
                  if (!refCode || !refCode.trim()) {
                    refError = gen?.error || gen?.message || "reference_script_generation_failed";
                  }
                }
              }
              // Keep reference bytes aligned with Solo too (raw saved / generated code).
            }

            // A long matrix script can carry stale filters, tabs, popups, grids,
            // or chart grain state into the next combination. Give every combo
            // its own Browserless function call/page. Non-PCC scenarios retry
            // empty / failed extractions up to EXTRACTION_MAX_ATTEMPTS. PCC
            // scalar scrapes use one attempt to avoid doubling long Browserless
            // runtime; grid/chart (requireStructured) still retries. playwright-
            // runtime remains unchanged; its existing override narrows the
            // injected matrix to exactly one combination.
            const requireStructuredExtraction = comparisonKpiLabels.some((label) =>
              looksLikeStructuredKpiLabel(label)
            ) || /graph|chart|grid|show\s*data|segment summary|overall performance/i
              .test(`${s.title || ""} ${(s as any).description || ""}`);
            const scenarioTiming = createTimingCollector();
            const runtimeCtx = (
              target: "main" | "reference",
              comboLabel: string | null,
              attempt: number,
              checkpoint: CancellationContext["checkpoint"],
            ): CancellationContext => ({
              checkpoint,
              report_id: reportId,
              scenario_id: s.id,
              combo: comboLabel,
              target,
              attempt,
            });
            const invokeRuntimeWithRetry = async (
              body: Record<string, any>,
              target: "main" | "reference",
              comboLabel: string | null,
            ) => {
              // Only Browserless timeouts permit a second bounded attempt.
              // Generic empty KPI retries stay limited for long PCC scrapes, but
              // grid/chart (requireStructured) always gets EXTRACTION_MAX_ATTEMPTS
              // so intermittent empty Show Data / grid scrapes can recover.
              // Timeout is ambiguous: the script may already have submitted a
              // password. Do not replay automatically before operator review.
              const authOrTimeoutMax = 1;
              const profileKey = target === "reference"
                ? script?.reference_credential_profile_id || report.reference_credential_profile_id || script?.credential_profile_id || report.credential_profile_id
                : script?.credential_profile_id || report.credential_profile_id;
              const loginKey = String(profileKey || `${reportId}:${target}`);
              const kpiMaxAttempts = (isPccScenario && !requireStructuredExtraction)
                ? 1
                : EXTRACTION_MAX_ATTEMPTS;
              await cancellation.throwIfCancelled(
                runtimeCtx(target, comboLabel, 1, "before_runtime"),
              );
              const timedBody = { ...body, code: instrumentReportTiming(prepareReportExecution(String(body.code || ""), parse), parse) };
              const timedCall = async (attempt: number, reason: string | null) => {
                const stopped = stoppedReportLogins.get(loginKey);
                if (stopped) return { ...stopped, __rtb_login_blocked: true };
                const result = await scenarioTiming.time({ target, combo: comboLabel, attempt }, () => callFn("playwright-runtime", timedBody),
                  (r: any) => { const c = classifyRuntimePayload(r, { target }); return c.auth_failure ? "auth_failure" : c.browserless_timeout ? "browserless_timeout" : reason; });
                const classified = classifyRuntimePayload(result, { target });
                if (classified.auth_failure) stoppedReportLogins.set(loginKey, { ok: false, error: classified.error, extracted: { ok: false, error: classified.error } });
                return result;
              };
              let response = await timedCall(1, null);
              await cancellation.throwIfCancelled(
                runtimeCtx(target, comboLabel, 1, "after_runtime"),
              );
              let attempts = 1;

              while (attempts < authOrTimeoutMax) {
                const classified = classifyRuntimePayload(response, { target });
                if (classified.auth_failure || !classified.browserless_timeout) break;
                if (classified.browserless_timeout) {
                  const health = await checkBrowserlessHealth({ timeoutMs: 4000 });
                  jsonLog("browserless_health_after_timeout", {
                    run_id: run.id,
                    scenario_id: s.id,
                    combo: comboLabel,
                    target,
                    ok: health.ok,
                    reason: health.reason,
                  });
                  if (!health.ok) {
                    browserlessInfraDown = health.reason || "browserless_unhealthy";
                    (response as any).__rtb_browserless_unhealthy = true;
                    break;
                  }
                }
                attempts += 1;
                await cancellation.throwIfCancelled(
                  runtimeCtx(target, comboLabel, attempts, "before_retry"),
                );
                jsonLog("combo_extraction_retry", {
                  run_id: run.id,
                  scenario_id: s.id,
                  combo: comboLabel,
                  target,
                  attempt: attempts,
                  max_attempts: authOrTimeoutMax,
                  reason: classified.auth_failure ? "auth_failure" : "browserless_timeout",
                  error: classified.error,
                });
                response = await timedCall(attempts, null);
                await cancellation.throwIfCancelled(
                  runtimeCtx(target, comboLabel, attempts, "after_runtime"),
                );
              }

              const afterAuth = classifyRuntimePayload(response, { target });
              if (
                !afterAuth.auth_failure &&
                !afterAuth.browserless_timeout &&
                !(response as any).__rtb_browserless_unhealthy
              ) {
                for (let attempt = attempts; attempt < kpiMaxAttempts; attempt++) {
                  const currentOutcome = classifyRuntimePayload(response, { target });
                  if (currentOutcome.auth_failure || currentOutcome.browserless_timeout) break;
                  const needsRetry = comboExtractionNeedsRetry(response, comboLabel, {
                    requireStructured: requireStructuredExtraction,
                    configuredLabels: comparisonKpiLabels,
                  });
                  if (!needsRetry) break;
                  attempts = attempt + 1;
                  await cancellation.throwIfCancelled(
                    runtimeCtx(target, comboLabel, attempts, "before_retry"),
                  );
                  jsonLog("combo_extraction_retry", {
                    run_id: run.id,
                    scenario_id: s.id,
                    combo: comboLabel,
                    target,
                    attempt: attempts,
                    max_attempts: kpiMaxAttempts,
                    reason: "runtime_or_empty_extraction",
                  });
                  response = await timedCall(attempts, null);
                  await cancellation.throwIfCancelled(
                    runtimeCtx(target, comboLabel, attempts, "after_runtime"),
                  );
                }
              }

              (response as any).__rtb_attempts = attempts;
              return response;
            };
            const isolatedRunResponses = new Map<string, any>();
            const isolatedRefResponses = new Map<string, any>();
            let runResp: any;
            let refRespRaw: any;
            // Always match Solo: one Browserless call with the full filter matrix.
            // Per-combo isolation (PCC and/or combos.length > 8) made suite runs much
            // slower (N × main[+reference]) while the same scripts succeed as a single
            // full-matrix scrape. Missing-grid retries still work via
            // missingRequiredStructuredExtraction on the full-matrix payload.
            const isolateCombos = false;
            if (hasCombos && isolateCombos) {
              const isolated = await mapPool(combos, 1, async (combo) => {
                await cancellation.throwIfCancelled({
                  checkpoint: "before_combo",
                  report_id: reportId,
                  scenario_id: s.id,
                  combo: combo.label,
                });
                const mainBody = {
                  mode: "headless",
                  scenario_id: s.id,
                  code: executableCode,
                  filter_combinations: [{ id: combo.id, label: combo.label, filters: combo.filters || {} }],
                };
                const mainResponse = await invokeRuntimeWithRetry(mainBody, "main", combo.label);
                let referenceResponse: any = null;
                if (isRef && !refError && refCode) {
                  await cancellation.throwIfCancelled({
                    checkpoint: "before_reference",
                    report_id: reportId,
                    scenario_id: s.id,
                    combo: combo.label,
                    target: "reference",
                  });
                  const referenceBody = {
                    mode: "headless",
                    scenario_id: s.id,
                    code: refCode,
                    target: "reference",
                    filter_combinations: [{ id: combo.id, label: combo.label, filters: combo.filters || {} }],
                  };
                  referenceResponse = await invokeRuntimeWithRetry(referenceBody, "reference", combo.label);
                }
                return { key: String(combo.id), mainResponse, referenceResponse };
              }, () => cancellation.isCancelled());
              for (const item of isolated) {
                if (!item) continue;
                isolatedRunResponses.set(item.key, item.mainResponse);
                if (item.referenceResponse) isolatedRefResponses.set(item.key, item.referenceResponse);
              }
              await cancellation.throwIfCancelled({
                checkpoint: "after_pool",
                report_id: reportId,
                scenario_id: s.id,
              });
              runResp = { ok: true, extracted: { result: { results: {} } } };
              refRespRaw = null;
            } else {
              const fullMatrix = hasCombos
                ? combos.map((c) => ({ id: c.id, label: c.label, filters: c.filters || {} }))
                : undefined;
              jsonLog("combo_matrix_mode", {
                run_id: run.id,
                scenario_id: s.id,
                mode: hasCombos ? "full_matrix_like_solo" : "no_matrix",
                combo_count: hasCombos ? combos.length : 0,
                isolate: false,
              });
              [runResp, refRespRaw] = await Promise.all([
                invokeRuntimeWithRetry({
                  mode: "headless",
                  scenario_id: s.id,
                  code: executableCode,
                  ...(fullMatrix ? { filter_combinations: fullMatrix } : {}),
                }, "main", null),
                (isRef && !refError && refCode)
                  ? invokeRuntimeWithRetry({
                      mode: "headless",
                      scenario_id: s.id,
                      code: refCode,
                      target: "reference",
                      ...(fullMatrix ? { filter_combinations: fullMatrix } : {}),
                    }, "reference", null)
                  : Promise.resolve(null),
              ]);
              // #region agent log
              {
                const resultKeys = (resp: any) => {
                  const root = resp?.extracted?.result;
                  if (!root || typeof root !== "object") return [];
                  const nested = root.results && typeof root.results === "object" ? root.results : root;
                  return Object.keys(nested).filter((k) => !String(k).startsWith("__")).slice(0, 20);
                };
                agentDebugLog("A", "agent-orchestrate/index.ts:after_parallel_scrape", "main+ref Promise.all finished", {
                  run_id: run.id,
                  scenario_id: s.id,
                  ref_code_bytes: refCode ? refCode.length : 0,
                  main_code_bytes: executableCode ? String(executableCode).length : 0,
                  main_ok: runResp?.ok !== false && !runResp?.error,
                  ref_ok: refRespRaw == null ? null : (refRespRaw?.ok !== false && !refRespRaw?.error),
                  ref_error: refRespRaw?.error || refRespRaw?.extracted?.error || null,
                  main_result_keys: resultKeys(runResp),
                  ref_result_keys: resultKeys(refRespRaw),
                  main_usable_null_label: countUsableKpisInPayload(runResp, null),
                  ref_usable_null_label: refRespRaw ? countUsableKpisInPayload(refRespRaw, null) : null,
                  combo_count: combos.length,
                }, run.id);
              }
              // #endregion
              await cancellation.throwIfCancelled({
                checkpoint: "after_runtime",
                report_id: reportId,
                scenario_id: s.id,
              });
            }
            const runExec = runResp?.extracted;
            if (!hasCombos && (
              runResp?.error ||
              runResp?.ok === false ||
              runExec?.ok === false ||
              runExec?.error
            )) {
              await cancellation.throwIfCancelled({
                checkpoint: "before_persist",
                report_id: reportId,
                scenario_id: s.id,
              });
              const partialScraped = pickComboKpis(runResp, null) || {};
              const runtimeClass = classifyRuntimePayload(runResp, { target: "main" });
              const completeness = assessConfiguredCompleteness(
                comparisonKpiLabels,
                partialScraped,
                kpiAliases,
              );
              const outcome = finalizeTargetOutcome(runtimeClass, completeness);
              const scrapeError =
                outcome.error ||
                runResp?.error ||
                runResp?.message ||
                runExec?.error ||
                runExec?.message ||
                "scrape failed";
              const persistStatus = statusFromCategory(outcome.category, false);
              const attemptCount = Number((runResp as any)?.__rtb_attempts) ||
                Number((runResp as any)?.auth_session_attempts) || 1;
              const failureInsert = await sb.from("test_results").insert({
                run_id: run.id,
                scenario_id: s.id,
                status: persistStatus,
                expected: { source: "scrape" },
                actual: {
                  timing: scenarioTiming.snapshot(null),
                  error: scrapeError,
                  values: partialScraped,
                  execution: buildExecutionAudit({
                    run_id: run.id,
                    scenario_id: s.id,
                    target: "main",
                    status: persistStatus,
                    attempt_count: attemptCount,
                    missing_fields: outcome.missing_fields,
                    failure_category: outcome.category,
                    error: scrapeError,
                    url: runtimeClass.url,
                  }),
                },
                diff: {
                  failure_category: outcome.category,
                  missing_fields: outcome.missing_fields,
                  extracted_fields: outcome.extracted_fields,
                  error: scrapeError,
                },
                criticality: s.criticality || "medium",
                severity: s.criticality || "medium",
                screenshot_url: runResp?.screenshot_url || null,
              });
              if (failureInsert.error) throw new Error(`Failed to persist scrape failure: ${errorDetail(failureInsert.error)}`);
              return { pass: 0, fail: 1 };
            }

            let refResp: any = refRespRaw;
            const refExec = refResp?.extracted;
            if (
              isRef &&
              !refError &&
              refResp &&
              (
                refResp.error ||
                refResp.ok === false ||
                refExec?.ok === false ||
                refExec?.error
              )
            ) {
              refError =
                refResp.error ||
                refResp.message ||
                refExec?.error ||
                refExec?.message ||
                "reference scrape failed";
            }

            const selectedResponse = (response: any, combo: any) => {
              const ambiguous = combos.filter(c => c.label === combo.label).length > 1;
              let node = selectComboNode(response, combo.label, combo.id, ambiguous);
              if (!node && combo.id == null && combo.label == null) node = selectComboNode(response, null);
              if (!node) {
                const failure = classifyRuntimePayload(response);
                const error = failure.error || 'Unresolved combination identity';
                return { ...response, ok: false, error, extracted: { ok: false, error, result: {} } };
              }
              return { ...response, extracted: { ...(response?.extracted || {}), result: { [combo.label || "__single__"]: node } } };
            };
            if (hasCombos && !isolateCombos && !isPccScenario) {
              for (const combo of combos) {
                const current = selectedResponse(runResp, combo);
                if (comboExecutionError(current, combo.label) || comboExtractionNeedsRetry(current, combo.label, { requireStructured: requireStructuredExtraction, configuredLabels: comparisonKpiLabels })) {
                  const retried = await invokeRuntimeWithRetry({ mode: "headless", scenario_id: s.id, code: executableCode, filter_combinations: [{ id: combo.id, label: combo.label, filters: combo.filters || {} }] }, "main", combo.label);
                  isolatedRunResponses.set(String(combo.id), retried);
                }
                if (isRef && !refError && refCode) {
                  const reference = selectedResponse(refResp, combo);
                  const refNeedsRetry = comboExecutionError(reference, combo.label) || comboExtractionNeedsRetry(reference, combo.label, { requireStructured: requireStructuredExtraction, configuredLabels: comparisonKpiLabels });
                  // #region agent log
                  {
                    const scraped = pickComboKpis(reference, combo.label, comparisonKpiLabels, kpiAliases) || {};
                    const configuredNonEmpty = comparisonKpiLabels.filter((lbl) => {
                      const raw = lookupConfiguredKpiValue(scraped, lbl, kpiAliases);
                      return raw != null && String(raw).trim() !== "";
                    }).length;
                    agentDebugLog("B", "agent-orchestrate/index.ts:ref_combo_retry_gate", "reference per-combo retry gate", {
                      run_id: run.id,
                      scenario_id: s.id,
                      combo: combo.label,
                      needs_retry: refNeedsRetry,
                      exec_error: comboExecutionError(reference, combo.label),
                      usable_count: countUsableKpisInPayload(reference, combo.label),
                      configured_non_empty: configuredNonEmpty,
                      configured_total: comparisonKpiLabels.length,
                      scraped_keys: Object.keys(scraped).slice(0, 15),
                    }, run.id);
                  }
                  // #endregion
                  if (refNeedsRetry) {
                    const retried = await invokeRuntimeWithRetry({ mode: "headless", scenario_id: s.id, code: refCode, target: "reference", filter_combinations: [{ id: combo.id, label: combo.label, filters: combo.filters || {} }] }, "reference", combo.label);
                    isolatedRefResponses.set(String(combo.id), retried);
                  }
                }
              }
            }
            const comboOutcomes = await mapPool(combos, Math.min(concurrency, 8), async (combo) => {
              await cancellation.throwIfCancelled({
                checkpoint: "before_combo",
                report_id: reportId,
                scenario_id: s.id,
                combo: combo.label,
              });
              const comboRunResp = selectedResponse(isolatedRunResponses.get(String(combo.id)) || runResp, combo);
              const comboExec = comboRunResp?.extracted;
              const innerComboError = comboExecutionError(comboRunResp, combo.label);
              if ((comboRunResp as any)?.__rtb_browserless_unhealthy) {
                browserlessInfraDown = browserlessInfraDown || "browserless_unhealthy";
              }
              if (
                comboRunResp?.error ||
                comboRunResp?.ok === false ||
                comboExec?.ok === false ||
                comboExec?.error ||
                innerComboError
              ) {
                // Preserve any KPI fields that survived alongside ok:false / error
                // (scripts that catch per-KPI failures instead of throwing).
                const partialScraped = pickComboKpis(comboRunResp, combo.label, comparisonKpiLabels, kpiAliases) || {};
                const runtimeClass = classifyComboRuntime(comboRunResp, combo.label, "main");
                const completeness = assessConfiguredCompleteness(
                  comparisonKpiLabels,
                  partialScraped,
                  kpiAliases,
                );
                const outcome = finalizeTargetOutcome(runtimeClass, completeness);
                const comboError =
                  outcome.error ||
                  comboRunResp?.error ||
                  comboRunResp?.message ||
                  comboExec?.error ||
                  comboExec?.message ||
                  "scrape failed";
                const persistStatus = statusFromCategory(outcome.category, false);
                const attemptCount = Number((comboRunResp as any)?.__rtb_attempts) ||
                  Number((comboRunResp as any)?.auth_session_attempts) || 1;
                await cancellation.throwIfCancelled({
                  checkpoint: "before_persist",
                  report_id: reportId,
                  scenario_id: s.id,
                  combo: combo.label,
                });
                const { error: insertError } = await sb.from("test_results").insert({
                  run_id: run.id,
                  scenario_id: s.id,
                  status: persistStatus,
                  expected: { combo_id: combo.id, source: isRef ? "reference_script" : "scrape", filter: combo.label,
                    values: isRef ? pickComboKpis(selectedResponse(isolatedRefResponses.get(String(combo.id)) || refResp, combo), combo.label, comparisonKpiLabels, kpiAliases) || {} : {},
                    error: isRef ? comboExecutionError(selectedResponse(isolatedRefResponses.get(String(combo.id)) || refResp, combo), combo.label) : null },
                  actual: {
                    timing: scenarioTiming.snapshot(combo.label),
                    filter: combo.label,
                    error: comboError,
                    values: partialScraped,
                    combo_id: combo.id,
                    requested_filters: combo.filters || {},
                    filters_applied: pickComboFiltersApplied(comboRunResp, combo.label),
                    execution: buildExecutionAudit({
                      run_id: run.id,
                      scenario_id: s.id,
                      combo: combo.label,
                      target: "main",
                      status: persistStatus,
                      attempt_count: attemptCount,
                      missing_fields: outcome.missing_fields,
                      failure_category: outcome.category,
                      error: comboError,
                      url: runtimeClass.url,
                    }),
                  },
                  diff: {
                    failure_category: outcome.category,
                    missing_fields: outcome.missing_fields,
                    extracted_fields: outcome.extracted_fields,
                    error: comboError,
                  },
                  criticality: s.criticality || "medium",
                  severity: s.criticality || "medium",
                  screenshot_url: comboRunResp?.screenshot_url || null,
                });
                if (insertError) throw new Error(`Failed to persist scrape failure: ${insertError.message}`);
                return { pass: 0, fail: 1 };
              }
              const scraped = pickComboKpis(comboRunResp, combo.label, comparisonKpiLabels, kpiAliases) || {};
              const filtersApplied =
                pickComboFiltersApplied(comboRunResp, combo.label);
              const filterVerification = verifyFilterEvidence(combo.filters || {}, filtersApplied);
              // Plain matrix filters (string values) mean the script envelope was
              // missing filters_applied — usually empty/unparseable extraction.
              const filtersLookUnverified = (() => {
                if (!filtersApplied || typeof filtersApplied !== "object") return true;
                const vals = Object.values(filtersApplied);
                if (!vals.length) return true;
                return vals.every((v) => v == null || typeof v !== "object");
              })();
              const scrapedUseful = Object.entries(scraped).some(([k, v]) =>
                !isExtractionNoiseKey(k) && v != null && String(v).trim() !== ""
              );
              if (!scrapedUseful && filtersLookUnverified) {
                jsonLog("empty_extracted_main", {
                  run_id: run.id,
                  scenario_id: s.id,
                  combo: combo.label,
                  result_keys: Object.keys(
                    (comboRunResp?.extracted?.result && typeof comboRunResp.extracted.result === "object")
                      ? comboRunResp.extracted.result
                      : (comboRunResp?.extracted || {}),
                  ).slice(0, 20),
                });
              }

              let expectedMap: Record<string, any> = {};
              let sqlMeta: any = { source: isRef ? "reference_script" : (sqlTplId ? "warehouse" : "none") };
              let sqlRow: Record<string, any> | null = null;
              // Reference values only count when its own filters were read back.
              let refFilterVerificationOk = true;

              if (isRef) {
                const comboRefResp = selectedResponse(isolatedRefResponses.get(String(combo.id)) || refResp, combo);
                const comboRefExec = comboRefResp?.extracted;
                const referenceVerification = verifyFilterEvidence(combo.filters || {}, pickComboFiltersApplied(comboRefResp, combo.label));
                refFilterVerificationOk = referenceVerification.ok;
                const comboRefError =
                  refError || (!referenceVerification.ok ? "Reference filter verification failed" : null) ||
                  comboExecutionError(comboRefResp, combo.label) ||
                  comboRefResp?.error ||
                  (comboRefResp?.ok === false ? comboRefResp?.message || "reference scrape failed" : null) ||
                  (comboRefExec?.ok === false || comboRefExec?.error
                    ? comboRefExec?.error || comboRefExec?.message || "reference scrape failed"
                    : null);
                const refScraped = pickComboKpis(comboRefResp, combo.label, comparisonKpiLabels, kpiAliases) || {};
                sqlMeta = {
                  source: "reference_script",
                  reference_url: (report as any)?.reference_url || null,
                  ok: !comboRefError,
                  error: comboRefError,
                  ran_without_filters: !hasCombos,
                };
                sqlRow = comboRefError ? null : refScraped;
                for (const lbl of comparisonKpiLabels.length ? comparisonKpiLabels : Object.keys(scraped)) {
                  const raw = lookupConfiguredKpiValue(refScraped, lbl, kpiAliases);
                  expectedMap[lbl] = (raw != null && typeof raw === "object")
                    ? raw
                    : (looksLikeDateValue(raw) ? String(raw).trim() : preserveConfiguredScalar(raw, lbl));
                }
                // #region agent log
                {
                  const expNonEmpty = Object.entries(expectedMap).filter(([, v]) => v != null && String(v).trim() !== "").length;
                  agentDebugLog("C", "agent-orchestrate/index.ts:ref_expected_build", "reference expected map built", {
                    run_id: run.id,
                    scenario_id: s.id,
                    combo: combo.label,
                    ref_filter_ok: refFilterVerificationOk,
                    combo_ref_error: comboRefError,
                    used_isolated_retry: isolatedRefResponses.has(String(combo.id)),
                    exp_non_empty: expNonEmpty,
                    exp_total: Object.keys(expectedMap).length,
                    ref_scraped_keys: Object.keys(refScraped).slice(0, 15),
                    filter_evidence: (referenceVerification.evidence || []).slice(0, 6).map((e: any) => ({
                      key: e.key,
                      outcome: e.verification_outcome,
                      selection: e.selection_outcome,
                    })),
                  }, run.id);
                }
                // #endregion
                const refGrid = pickStructured(refScraped);
                if (refGrid && expectedMap[refGrid.k] == null) {
                  const alias = configuredStructuredKpiAlias(refGrid.k, comparisonKpiLabels);
                  // Keep incidental grids off scalar-owned configured KPIs.
                  if (!configuredKpiOwnsScalar(alias, expectedMap, kpiAliases)) {
                    expectedMap[refGrid.k] = refGrid.v;
                  }
                }
              } else if (sqlTplId) {
                const { where, pairs, missing } = hasCombos
                  ? buildWhere(combo.filters || {}, keyMap || [])
                  : { where: "", pairs: [] as { be: string; value: string }[], missing: [] as string[] };
                if (missing.length) {
                  const message = `Missing FE-to-BE filter mapping for: ${missing.join(", ")}`;
                  await cancellation.throwIfCancelled({
                    checkpoint: "before_persist",
                    report_id: reportId,
                    scenario_id: s.id,
                    combo: combo.label,
                  });
                  const { error: mappingInsertError } = await sb.from("test_results").insert({
                    run_id: run.id,
                    scenario_id: s.id,
                    status: "fail",
                    expected: {
                      source: "warehouse",
                      filter: combo.label,
                      error: "missing_filter_mapping",
                      missing_keys: missing,
                    },
                    actual: {
                      filter: combo.label,
                      error: message,
                      filters_applied:
                        pickComboFiltersApplied(comboRunResp, combo.label) ||
                        combo.filters ||
                        null,
                    },
                    diff: { error: "missing_filter_mapping", missing_keys: missing },
                    criticality: s.criticality || "medium",
                    severity: s.criticality || "medium",
                  });
                  if (mappingInsertError) {
                    throw new Error(`Failed to persist mapping error: ${mappingInsertError.message}`);
                  }
                  return { pass: 0, fail: 1 };
                }
                const sqlResp = await callFn("run-warehouse-sql", {
                  sql_template_id: sqlTplId,
                  scenario_id: s.id,
                  where_clause: where || undefined,
                  filter_pairs: pairs,
                  limit: 5,
                });
                sqlMeta = {
                  source: "warehouse",
                  connector: sqlResp?.connector,
                  where_clause: where || null,
                  missing_keys: missing,
                  ok: sqlResp?.ok,
                  error: sqlResp?.error,
                  row_count: sqlResp?.row_count ?? (sqlResp?.rows?.length ?? 0),
                  ran_without_filters: !hasCombos,
                };
                const rows = sqlResp?.rows || [];
                const cols: string[] = sqlResp?.columns || [];
                sqlRow = rows[0] || null;
                const norm = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
                const colNorms = cols.map((c) => ({ c, n: norm(c) }));
                const findCol = (lbl: string): string | null => {
                  const n = norm(lbl);
                  if (!n) return null;
                  const exact = colNorms.find((x) => x.n === n);
                  if (exact) return exact.c;
                  const prefix = colNorms.find((x) => x.n.startsWith(n) || n.startsWith(x.n));
                  return prefix ? prefix.c : null;
                };
                const warehouseLabels = comparisonKpiLabels.length
                  ? comparisonKpiLabels
                  : Object.keys(scraped);
                const structuredWarehouseLabel = warehouseLabels.length === 1 &&
                    isStructuredVal(lookupConfiguredKpiValue(scraped, warehouseLabels[0], kpiAliases))
                  ? warehouseLabels[0]
                  : null;
                if (structuredWarehouseLabel && rows.length && cols.length) {
                  expectedMap[structuredWarehouseLabel] = {
                    columns: cols,
                    rows: rows.map((row: Record<string, any>) =>
                      cols.map((column) => row?.[column] ?? null)
                    ),
                  };
                }
                for (const lbl of warehouseLabels) {
                  if (lbl === structuredWarehouseLabel) continue;
                  const col = findCol(lbl);
                  if (col && rows[0]) {
                    const raw = rows[0][col];
                    expectedMap[lbl] = looksLikeDateValue(raw)
                      ? String(raw).trim()
                      : preserveConfiguredScalar(raw, lbl);
                  } else if (sqlResp?.scalar != null) {
                    expectedMap[lbl] = looksLikeDateValue(sqlResp.scalar)
                      ? String(sqlResp.scalar).trim()
                      : preserveConfiguredScalar(sqlResp.scalar, lbl);
                  }
                  else expectedMap[lbl] = null;
                }
              }

              const actualMap: Record<string, any> = {};
              const diffMap: Record<string, any> = {};
              let comboPass = true;
              const labels = (comparisonKpiLabels.length ? comparisonKpiLabels : Object.keys(scraped));
              const kpiTol: Record<string, any> = ((script as any)?.assertion_spec || {}).kpi_tolerances || {};
              const structuredLabels = labels.filter((label) =>
                isStructuredVal(lookupConfiguredKpiValue(scraped, label, kpiAliases))
              );
              const hasMultipleStructuredKpis = structuredLabels.length > 1;
              const mainGrid = pickComparableStructured(scraped);
              const expGrid = pickComparableStructured(expectedMap);
              const structuredLabel = mainGrid
                ? configuredStructuredKpiAlias(mainGrid.k, comparisonKpiLabels)
                : null;
              const skipIncidentalStructuredPromotion = !!(
                structuredLabel &&
                (configuredKpiOwnsScalar(structuredLabel, scraped, kpiAliases) ||
                  configuredKpiOwnsScalar(structuredLabel, expectedMap, kpiAliases))
              );
              const structuredSourceKeys: Record<string, string> = {};

              if (isTrend) {
                const grainMap = scraped.grains && typeof scraped.grains === "object" ? scraped.grains : null;
                if (grainMap) actualMap.grains = grainMap;
                for (const grain of ["Weekly", "Monthly", "Quarterly"]) {
                  const one = grainMap?.[grain];
                  if (!one) continue;
                  actualMap[`Trend check ${grain}`] = one.consecutive ? 1 : 0;
                }
                const consecutive = grainMap
                  ? ["Weekly", "Monthly", "Quarterly"].every((g) => grainMap[g]?.consecutive === true)
                  : (scraped.consecutive === true || scraped["Trend check"] === 1);
                const explicitFail = scraped.consecutive === false || scraped["Trend check"] === 0;
                const periods = Array.isArray(scraped.periods) ? scraped.periods : [];
                const missing = Array.isArray(scraped.missing) ? scraped.missing : [];
                actualMap["Trend check"] = consecutive ? 1 : (explicitFail || missing.length || grainMap ? 0 : null);
                actualMap.consecutive = consecutive;
                if (periods.length) actualMap.periods = periods;
                if (missing.length) actualMap.missing = missing;
                if (scraped.time_grain) actualMap.time_grain = scraped.time_grain;
                if (scraped.trend_error) actualMap.trend_error = scraped.trend_error;
                comboPass = consecutive;
                diffMap["Trend check"] = {
                  consecutive,
                  grains: grainMap,
                  missing,
                  periods,
                  error: comboPass ? null : (scraped.trend_error || "gap_in_periods"),
                };
              } else {
              if (
                !hasMultipleStructuredKpis &&
                mainGrid &&
                structuredLabel &&
                !skipIncidentalStructuredPromotion
              ) {
                actualMap[structuredLabel] = mainGrid.v;
                structuredSourceKeys[structuredLabel] = mainGrid.k;
                if (expGrid) {
                  expectedMap[structuredLabel] = expGrid.v;
                  if (expGrid.k !== structuredLabel) delete expectedMap[expGrid.k];
                }
              }
              if (
                !hasMultipleStructuredKpis &&
                mainGrid &&
                expGrid &&
                !skipIncidentalStructuredPromotion
              ) {
                // Grid / graph Show Data: compare cell by cell so the configured
                // comparator + tolerance apply. JSON.stringify equality ignored both
                // and failed the whole visual on any single differing cell.
                // Change/delta rows (NBRx Change, TRx Change, ...) are skipped.
                const gTolEntry: any = lookupKpiTol(kpiTol, structuredLabel || mainGrid.k);
                const gTolVal = gTolEntry && typeof gTolEntry === "object" ? Number(gTolEntry.value) : Number(gTolEntry);
                const gTolUnit = (gTolEntry && typeof gTolEntry === "object" && gTolEntry.unit) === "abs" ? "abs" : "pct";
                let gTolOp = (gTolEntry && typeof gTolEntry === "object" && gTolEntry.op) || "eq";
                if (isRef && comparator_override) gTolOp = comparator_override;

                const aTable = toTableModel(mainGrid.v);
                const eTable = toTableModel(expGrid.v);
                let gridPass: boolean;
                if (aTable && eTable) {
                  const cmp = compareTables(
                    aTable,
                    eTable,
                    { value: Number.isFinite(gTolVal) ? gTolVal : 0, unit: gTolUnit as any, op: gTolOp as any },
                    { skipChangeRows: true },
                  );
                  gridPass = cmp.pass;
                  diffMap[structuredLabel || mainGrid.k] = {
                    structured: true,
                    pass: gridPass,
                    cellwise: true,
                    compared_cells: cmp.comparedCells,
                    skipped_change_rows: cmp.skippedRows,
                    failed_cells: cmp.failedCells.slice(0, 50),
                    rows_only_in_actual: cmp.rowsOnlyInActual,
                    rows_only_in_reference: cmp.rowsOnlyInExpected,
                    tolerance: { value: Number.isFinite(gTolVal) ? gTolVal : 0, unit: gTolUnit, op: gTolOp },
                    summary: summarizeTableCompare(cmp),
                  };
                } else {
                  // Unrecognised shape: fall back to the previous exact match.
                  gridPass = structuredEqual(mainGrid.v, expGrid.v);
                  diffMap[structuredLabel || mainGrid.k] = { structured: true, pass: gridPass, cellwise: false };
                }
                if (!gridPass) comboPass = false;
              } else if (
                !hasMultipleStructuredKpis &&
                mainGrid &&
                (isRef || sqlTplId) &&
                !expGrid &&
                !skipIncidentalStructuredPromotion
              ) {
                comboPass = false;
                diffMap[structuredLabel || mainGrid.k] = { structured: true, error: "no_expected_grid" };
              }

              for (const lbl of labels) {
                const rawA = lookupConfiguredKpiValue(scraped, lbl, kpiAliases);
                if (isStructuredVal(rawA) || STRUCTURED_KPI_KEYS.has(String(lbl).toLowerCase().replace(/[^a-z0-9]/g, ""))) {
                  if (actualMap[lbl] === undefined) actualMap[lbl] = rawA;
                  if (isStructuredVal(rawA)) structuredSourceKeys[lbl] = lbl;
                  if (hasMultipleStructuredKpis && (isRef || sqlTplId)) {
                    const rawE = lookupKpiValue(expectedMap, lbl);
                    if (!isStructuredVal(rawE)) {
                      comboPass = false;
                      diffMap[lbl] = { structured: true, error: "no_expected_grid" };
                      continue;
                    }

                    const tolEntry: any = lookupKpiTol(kpiTol, lbl);
                    const tolValue = tolEntry && typeof tolEntry === "object"
                      ? Number(tolEntry.value)
                      : Number(tolEntry);
                    const tolUnit = (tolEntry && typeof tolEntry === "object" && tolEntry.unit) === "abs"
                      ? "abs"
                      : "pct";
                    let tolOp = (tolEntry && typeof tolEntry === "object" && tolEntry.op) || "eq";
                    if (isRef && comparator_override) tolOp = comparator_override;
                    const actualTable = toTableModel(rawA);
                    const expectedTable = toTableModel(rawE);
                    let structuredPass: boolean;

                    if (actualTable && expectedTable) {
                      const cmp = compareTables(
                        actualTable,
                        expectedTable,
                        {
                          value: Number.isFinite(tolValue) ? tolValue : 0,
                          unit: tolUnit as any,
                          op: tolOp as any,
                        },
                        { skipChangeRows: true },
                      );
                      structuredPass = cmp.pass;
                      diffMap[lbl] = {
                        structured: true,
                        pass: structuredPass,
                        cellwise: true,
                        compared_cells: cmp.comparedCells,
                        skipped_change_rows: cmp.skippedRows,
                        failed_cells: cmp.failedCells.slice(0, 50),
                        rows_only_in_actual: cmp.rowsOnlyInActual,
                        rows_only_in_reference: cmp.rowsOnlyInExpected,
                        tolerance: {
                          value: Number.isFinite(tolValue) ? tolValue : 0,
                          unit: tolUnit,
                          op: tolOp,
                        },
                        summary: summarizeTableCompare(cmp),
                      };
                    } else {
                      structuredPass = structuredEqual(rawA, rawE);
                      diffMap[lbl] = {
                        structured: true,
                        pass: structuredPass,
                        cellwise: false,
                      };
                    }
                    if (!structuredPass) comboPass = false;
                  }
                  continue;
                }
                const rawExpected = lookupKpiValue(expectedMap, lbl);
                if (isIdentifierKpi(lbl) && rawA != null) {
                  const aText = String(rawA).trim();
                  const eRaw = rawExpected;
                  const eText = eRaw == null ? null : String(eRaw).trim();
                  actualMap[lbl] = aText;
                  if (!sqlTplId && !isRef) {
                    diffMap[lbl] = { value: aText, kind: "text" };
                  } else {
                    const textPass = eText != null && aText === eText;
                    diffMap[lbl] = {
                      kind: "text",
                      actual: aText,
                      expected: eText,
                      pass: textPass,
                    };
                    if (!textPass) comboPass = false;
                  }
                  continue;
                }
                // Refresh dates stay as text for display, but compare them with
                // the configured operator (eq/lte/gte/gt/lt), not equality only.
                if (looksLikeDateValue(rawA)) {
                  const aStr = String(rawA).trim();
                  actualMap[lbl] = aStr;
                  const eRaw = expectedMap[lbl] ?? null;
                  const eStr = eRaw == null ? null : String(eRaw).trim();
                  if (!sqlTplId && !isRef) {
                    // Nothing to compare against: presence is the only check.
                    diffMap[lbl] = { value: aStr, kind: "date" };
                  } else {
                    const tEntry: any = lookupKpiTol(kpiTol, lbl);
                    const tVal = tEntry && typeof tEntry === "object" ? Number(tEntry.value) : Number(tEntry);
                    const tUnit = (tEntry && typeof tEntry === "object" && tEntry.unit) || "pct";
                    let tOp = (tEntry && typeof tEntry === "object" && tEntry.op) || "eq";
                    if (isRef && comparator_override) tOp = comparator_override;
                    const toleranceDays = tUnit === "abs" && Number.isFinite(tVal) ? tVal : 0;
                    const datePass = eStr != null && evalDatePass(aStr, eStr, tOp, toleranceDays) === true;
                    diffMap[lbl] = {
                      kind: "date",
                      actual: aStr,
                      expected: eStr,
                      pass: datePass,
                      tolerance: Number.isFinite(tVal) ? { value: tVal, unit: tUnit, op: tOp } : { value: 0, unit: "pct", op: tOp },
                    };
                    if (!datePass) comboPass = false;
                  }
                  continue;
                }
                if (typeof rawA === "string" && !isNumericScalar(rawA)) {
                  const aText = rawA.trim();
                  const eRaw = expectedMap[lbl] ?? null;
                  const eText = eRaw == null ? null : String(eRaw).trim();
                  actualMap[lbl] = aText;
                  if (!sqlTplId && !isRef) {
                    diffMap[lbl] = { value: aText, kind: "text" };
                  } else {
                    const textPass =
                      eText != null &&
                      normalizeTextScalar(aText) === normalizeTextScalar(eText);
                    diffMap[lbl] = {
                      kind: "text",
                      actual: aText,
                      expected: eText,
                      pass: textPass,
                    };
                    if (!textPass) comboPass = false;
                  }
                  continue;
                }
                const a = toNum(rawA);
                actualMap[lbl] = a;
                const e = expectedMap[lbl] ?? null;
                if (s.type === "range_check") {
                  const ok = a != null && a >= 0 && a <= 1e12;
                  diffMap[lbl] = { value: a };
                  if (!ok) comboPass = false;
                } else if (!sqlTplId && !isRef) {
                  if (a == null) { comboPass = false; diffMap[lbl] = { error: "no_value" }; }
                  else diffMap[lbl] = { value: a };
                } else {
                  // Tolerance-aware evaluation, matching the UI logic in RunScenarioCard
                  const tEntry: any = lookupKpiTol(kpiTol, lbl);
                  const tVal = tEntry && typeof tEntry === "object" ? Number(tEntry.value) : Number(tEntry);
                  const tUnit = (tEntry && typeof tEntry === "object" && tEntry.unit) || "pct";
                  let tOp = (tEntry && typeof tEntry === "object" && tEntry.op) || "eq";
                  // Schedule-level comparator override (reference_match only)
                  if (isRef && comparator_override) tOp = comparator_override;
                  let pass = false;
                  let pct: number | null = null;
                  if (a == null || e == null) {
                    pass = false;
                  } else {
                    const d = a - e;
                    pct = e !== 0 ? Math.abs(d) / Math.abs(e) : (d === 0 ? 0 : 1);
                    const allowed = Number.isFinite(tVal)
                      ? (tUnit === "abs" ? Math.abs(tVal) : (Math.abs(tVal) / 100) * Math.abs(e))
                      : 0;
                    if (tOp === "lte") pass = (d - allowed) <= 0;
                    else if (tOp === "gte") pass = (-d - allowed) <= 0;
                    else if (tOp === "gt") pass = (d - allowed) > 0;
                    else if (tOp === "lt") pass = (-d - allowed) > 0;
                    else pass = Math.abs(d) <= allowed;
                  }
                  diffMap[lbl] = {
                    pct, expected: e, actual: a,
                    tolerance: Number.isFinite(tVal) ? { value: tVal, unit: tUnit, op: tOp } : null,
                    ...(
                      a == null
                        ? { error: "no_value" }
                        : e == null
                          ? { error: "no_expected_value" }
                          : {}
                    ),
                  };
                  if (!pass) comboPass = false;
                }
              }

              // Guard against false positives: if no KPI labels were evaluated,
              // or every actual value is missing/null, treat the combo as failed
              // rather than letting an empty loop default to pass.
              const actualVals = Object.values(actualMap);
              const allActualsNull = actualVals.length === 0 || actualVals.every((v) => v == null);
              if (!mainGrid && (labels.length === 0 || allActualsNull)) {
                comboPass = false;
                if (labels.length === 0) {
                  diffMap["__no_kpi__"] = { error: "no_kpi_values_returned" };
                } else {
                  for (const lbl of labels) {
                    if (actualMap[lbl] == null) {
                      diffMap[lbl] = { ...(diffMap[lbl] || {}), error: "no_value" };
                    }
                  }
                }
              }
              }

              // Completeness gate: configured KPIs must be extracted or explicitly failed.
              const mainRuntime = classifyComboRuntime(comboRunResp, combo.label, "main");
              const mainCompleteness = assessConfiguredCompleteness(
                labels,
                actualMap,
                kpiAliases,
              );
              let mainOutcome = finalizeTargetOutcome(mainRuntime, mainCompleteness);
              for (const missing of mainOutcome.missing_fields) {
                if (actualMap[missing] == null) {
                  diffMap[missing] = { ...(diffMap[missing] || {}), error: "no_value" };
                }
              }

              let refOutcome: ReturnType<typeof finalizeTargetOutcome> | null = null;
              if (isRef) {
                const comboRefResp = selectedResponse(isolatedRefResponses.get(String(combo.id)) || refResp, combo);
                const refRuntime = classifyComboRuntime(
                  comboRefResp || { error: refError || sqlMeta?.error || "reference scrape failed" },
                  combo.label,
                  "reference",
                );
                const refCompleteness = assessConfiguredCompleteness(
                  labels,
                  expectedMap,
                  kpiAliases,
                );
                refOutcome = finalizeTargetOutcome(refRuntime, refCompleteness);
                for (const missing of refOutcome.missing_fields) {
                  if (expectedMap[missing] == null) {
                    diffMap[missing] = {
                      ...(diffMap[missing] || {}),
                      error: "no_expected_value",
                    };
                  }
                }
                if (refOutcome.category !== "pass") comboPass = false;
              }

              if (mainOutcome.category !== "pass" || !filterVerification.ok || !refFilterVerificationOk) comboPass = false;

              let failureCategory: ExtractionFailureCategory = comboPass
                ? "pass"
                : worseExtractionCategory(
                  mainOutcome.category === "pass" ? "fail" : mainOutcome.category,
                  refOutcome && refOutcome.category !== "pass" ? refOutcome.category : "fail",
                );
              if (comboPass) failureCategory = "pass";
              else if (mainOutcome.category === "pass" && (!refOutcome || refOutcome.category === "pass")) {
                failureCategory = "fail";
              } else {
                failureCategory = worseExtractionCategory(
                  mainOutcome.category,
                  refOutcome?.category || "pass",
                );
                if (failureCategory === "pass") failureCategory = "fail";
              }

              if (!filterVerification.ok || !refFilterVerificationOk) failureCategory = "partial_extraction";
              const status = statusFromCategory(failureCategory, comboPass);
              // #region agent log
              agentDebugLog("D", "agent-orchestrate/index.ts:combo_persist_outcome", "combo persist outcome", {
                run_id: run.id,
                scenario_id: s.id,
                combo: combo.label,
                status,
                failure_category: failureCategory,
                combo_pass: comboPass,
                main_filter_ok: filterVerification.ok,
                ref_filter_ok: refFilterVerificationOk,
                main_missing: mainOutcome.missing_fields,
                ref_missing: refOutcome?.missing_fields || [],
                expected_non_empty: Object.entries(expectedMap).filter(([, v]) => v != null && String(v).trim() !== "").length,
                actual_non_empty: Object.entries(actualMap).filter(([, v]) => v != null && String(v).trim() !== "").length,
              }, run.id);
              // #endregion
              const attemptCount = Number((comboRunResp as any)?.__rtb_attempts) ||
                Number((comboRunResp as any)?.auth_session_attempts) || 1;
              const missingAll = Array.from(new Set([
                ...mainOutcome.missing_fields,
                ...(refOutcome?.missing_fields || []),
              ]));
              diffMap.__execution = {
                failure_category: failureCategory,
                missing_fields: missingAll,
                main: mainOutcome,
                reference: refOutcome,
                attempt_count: attemptCount,
              };
              const worstDiff = Object.values(diffMap)
                .map((d: any) => (typeof d?.pct === "number" ? d.pct : null))
                .filter((x): x is number => x != null)
                .reduce((m, v) => Math.max(m, v), 0);
              const crit = comboPass ? null : computeCriticality((s as any).criticality || "medium", worstDiff || null);

              // Snapshot tolerances that were in effect at run time so future
              // edits in ScenarioDetail do NOT mutate this historical run's pass/fail.
              const tolerancesSnapshot: Record<string, any> = {};
              const VALID_OPS = new Set(["lte","gte","eq","gt","lt"]);
              const overrideOp = (isRef && comparator_override && VALID_OPS.has(comparator_override)) ? comparator_override : null;
              for (const lbl of labels) {
                const tEntry: any = lookupKpiTol(kpiTol, lbl);
                if (tEntry && typeof tEntry === "object") {
                  const baseOp = VALID_OPS.has(tEntry.op) ? tEntry.op : "eq";
                  tolerancesSnapshot[lbl] = { value: Number(tEntry.value) || 0, unit: tEntry.unit === "abs" ? "abs" : "pct", op: overrideOp || baseOp };
                } else if (Number.isFinite(Number(tEntry))) {
                  tolerancesSnapshot[lbl] = { value: Number(tEntry), unit: "pct", op: overrideOp || "eq" };
                } else if (overrideOp) {
                  tolerancesSnapshot[lbl] = { value: 0, unit: "pct", op: overrideOp };
                } else {
                  // Keep the historical KPI list immutable even when the user
                  // did not configure a non-zero tolerance for this KPI.
                  tolerancesSnapshot[lbl] = { value: 0, unit: "pct", op: "eq" };
                }
              }
              await cancellation.throwIfCancelled({
                checkpoint: "before_persist",
                report_id: reportId,
                scenario_id: s.id,
                combo: combo.label,
              });
              const { data: tr, error: trError } = await sb.from("test_results").insert({
                run_id: run.id, scenario_id: s.id, status,
                expected: { combo_id: combo.id, error: refOutcome?.error || null, source: sqlMeta.source, filter: combo.label, where_clause: sqlMeta.where_clause, values: expectedMap, row: sqlRow, sql: sqlMeta },
                actual: {
                  timing: scenarioTiming.snapshot(combo.label),
                  combo_id: combo.id,
                  requested_filters: combo.filters || {},
                  filter_verification: filterVerification,
                  execution_status: failureCategory,
                  error: !filterVerification.ok ? "Filter verification failed" : mainOutcome.error || null,
                  filter: combo.label,
                  values: actualMap,
                  filters_applied: filtersApplied,
                  tolerances_snapshot: tolerancesSnapshot,
                  structured_source_keys: Object.keys(structuredSourceKeys).length
                    ? structuredSourceKeys
                    : null,
                  execution: buildExecutionAudit({
                    run_id: run.id,
                    scenario_id: s.id,
                    combo: combo.label,
                    target: "compare",
                    status,
                    attempt_count: attemptCount,
                    missing_fields: missingAll,
                    failure_category: failureCategory,
                    error: mainOutcome.error || refOutcome?.error || null,
                    url: mainRuntime.url || null,
                  }),
                },
                diff: diffMap,
                criticality: crit,
                severity: crit,
                rank_score: comboPass ? 0 : (["low", "medium", "high", "critical"].indexOf(crit || "medium") + 1),
                screenshot_url: comboRunResp?.screenshot_url || null,
              }).select().single();
              if (trError || !tr) {
                throw new Error(`Failed to persist test result: ${trError?.message || "unknown error"}`);
              }

              if (!comboPass && tr?.id) {
                let skipAnalyze = false;
                try {
                  skipAnalyze = await cancellation.refresh();
                } catch (e) {
                  if (isRunAuthExpiredError(e)) throw e;
                  if (isRunCancelledError(e)) skipAnalyze = true;
                  else throw e;
                }
                if (skipAnalyze) {
                  jsonLog("run_cancellation_skip_analyze", {
                    run_id: run.id,
                    scenario_id: s.id,
                    combo: combo.label,
                    test_result_id: tr.id,
                    checkpoint: "before_analyze",
                  });
                } else {
                  callFn("agent-analyze", { test_result_id: tr.id }).catch(() => {});
                }
              }
              return { pass: comboPass ? 1 : 0, fail: comboPass ? 0 : 1 };
            }, () => cancellation.isCancelled());
            let localPass = 0, localFail = 0;
            for (const o of comboOutcomes) {
              if (!o) continue;
              localPass += o.pass;
              localFail += o.fail;
            }
            await cancellation.throwIfCancelled({
              checkpoint: "after_pool",
              report_id: reportId,
              scenario_id: s.id,
            });
            return { pass: localPass, fail: localFail };
          }, () => cancellation.isCancelled());
          for (const o of scenarioOutcomes) {
            if (!o) continue;
            pass += o.pass;
            fail += o.fail;
          }
          // Reconcile before cancel check: mapPool stop leaves unclaimed scenarios
          // with no rows — account them explicitly (cancel / infra / incomplete).
          {
            let cancelledNow = cancellation.isCancelled();
            try {
              if (!cancelledNow) cancelledNow = await cancellation.refresh();
            } catch (refreshErr) {
              if (isRunAuthExpiredError(refreshErr)) {
                await persistUnexecutedScenarios(
                  sb, run.id, scenarios || [], "auth_failure", refreshErr.causeMessage,
                );
                throw refreshErr;
              }
              if (!isRunCancelledError(refreshErr)) throw refreshErr;
              cancelledNow = true;
            }
            const reason = unexecutedReasonFromStop({
              cancelled: cancelledNow,
              browserlessInfraDown,
            });
            const unexec = await persistUnexecutedScenarios(
              sb,
              run.id,
              scenarios || [],
              reason,
              browserlessInfraDown || (cancelledNow ? "cancelled" : "report_incomplete"),
            );
            // Unexecuted rows count as fail for child pass/fail rollup (not fabricated pass).
            fail += unexec;
          }
          await cancellation.throwIfCancelled({
            checkpoint: "after_pool",
            report_id: reportId,
          });
        }

        await cancellation.throwIfCancelled({
          checkpoint: "before_finalize",
          report_id: single_report_id || reportIds[0] || null,
        });
        if (existing_run_id) {
          const rows = await loadCompleteRows((start, end) => sb.from("test_results").select("id,status,actual,expected,diff,scenarios!inner(report_id)").eq("run_id", run.id).eq("scenarios.report_id", single_report_id || reportIds[0]).order("id").range(start, end));
          const counts = outcomeCounts(rows.map(row => deriveExecutionOutcome(row, row.status === "pass" ? "pass" : row.status === "pending" ? "pending" : "fail")));
          const incomplete = Boolean(browserlessInfraDown) || counts.pending > 0;
          if (counts.pending) throw new Error("Report has unresolved combination work; cannot finalize as completed");
          await finalizeChild(sb, run.id, single_report_id || reportIds[0], counts.pass, counts.fail + counts.cancelled, incomplete, incomplete ? (browserlessInfraDown || "report_unresolved") : undefined);
        } else {
          // Preserve cancelled — never overwrite with completed.
          const incomplete = Boolean(browserlessInfraDown);
          const persisted: any[] = [];
          for (let offset = 0; ; offset += 1000) {
            const page = await sb.from("test_results").select("id,scenario_id,actual,expected,status,diff").eq("run_id", run.id).order("id").range(offset, offset + 999);
            if (page.error) throw new Error(`Final totals read failed: ${errorDetail(page.error)}`);
            persisted.push(...(page.data || []));
            if (!page.data || page.data.length < 1000) break;
          }
          const counts = outcomeCounts(persisted.map(row => deriveExecutionOutcome(row, row.status === "pass" ? "pass" : row.status === "pending" ? "pending" : "fail")));
          const finalized = await retryFinalizationOperation(() => sb.from("runs").update({
            status: counts.pending ? "running" : incomplete || counts.fail ? "failed" : counts.cancelled ? "cancelled" : "completed",
            finished_at: counts.pending ? null : new Date().toISOString(),
            summary: { ...counts, ...(incomplete ? { error: browserlessInfraDown || "browserless_unhealthy", failure_category: "browserless_timeout" } : {}) },
          }).eq("id", run.id).eq("status", "running"), (result: any) => result?.error);
          if (finalized.error) throw new Error(`Final totals update failed: ${errorDetail(finalized.error)}`);
        }
      } catch (e) {
        if (isRunCancelledError(e)) {
          cancellation.markCancelled();
          jsonLog("run_cancellation_detected", {
            run_id: run.id,
            checkpoint: e.context?.checkpoint || "work_inner",
            report_id: e.context?.report_id ?? single_report_id ?? reportIds[0] ?? null,
            scenario_id: e.context?.scenario_id ?? null,
            combo: e.context?.combo ?? null,
            target: e.context?.target ?? null,
            attempt: e.context?.attempt ?? null,
          });
          // Account remaining scenarios for the in-flight report before leaving cancelled.
          try {
            const rid = e.context?.report_id ?? single_report_id ?? reportIds[0];
            if (rid) {
              const { data: leftover } = await sb.from("scenarios")
                .select("id, criticality")
                .eq("report_id", rid)
                .eq("deferred", false);
              await persistUnexecutedScenarios(sb, run.id, leftover || [], "cancelled", "cancelled");
              if (existing_run_id) {
                await finalizeChild(sb, run.id, rid, pass, fail, true, "cancelled");
              }
            }
          } catch (accountErr) {
            jsonLog("cancel_unexecuted_account_failed", {
              run_id: run.id,
              error: errorDetail(accountErr).slice(0, 300),
            });
          }
          // Leave runs.status = "cancelled" when user cancelled; do not flip to failed.
          return;
        }
        if (isRunAuthExpiredError(e)) {
          jsonLog("run_auth_expired_stop", {
            run_id: run.id,
            error: e.causeMessage.slice(0, 300),
            can_refresh: Boolean(session?.canRefresh),
          });
          try {
            const rid = single_report_id || reportIds[0];
            if (rid) {
              const { data: leftover } = await sb.from("scenarios")
                .select("id, criticality")
                .eq("report_id", rid)
                .eq("deferred", false);
              await persistUnexecutedScenarios(
                sb, run.id, leftover || [], "auth_failure", e.causeMessage,
              );
            }
            if (existing_run_id && rid) {
              // Child of Brand: never wipe coordinator summary — finalize this report only.
              await finalizeChild(
                sb, run.id, rid, pass, fail, true, "auth_expired",
              );
            } else {
              const admin = getServiceClient();
              const finisher = admin || sb;
              await checkedWrite(finisher.from("runs").update({
                status: "failed",
                finished_at: new Date().toISOString(),
                summary: {
                  pass,
                  fail,
                  total: pass + fail,
                  error: "auth_expired",
                  failure_category: "auth_failure",
                },
              }).eq("id", run.id).eq("status", "running"), "Auth-expired run update failed");
            }
          } catch (finErr) {
            jsonLog("run_auth_expired_finalize_failed", {
              run_id: run.id,
              error: String((finErr as any)?.message || finErr).slice(0, 300),
            });
          }
          return;
        }
        if (cancellation.isCancelled()) {
          jsonLog("run_cancellation_skip_finalize", {
            run_id: run.id,
            checkpoint: "work_inner_error",
            error: errorDetail(e).slice(0, 500),
          });
          return;
        }
        // refresh() may throw RunAuthExpiredError — handle before generic finalize.
        try {
          if (await cancellation.refresh()) {
            jsonLog("run_cancellation_skip_finalize", {
              run_id: run.id,
              checkpoint: "work_inner_error",
              error: errorDetail(e).slice(0, 500),
            });
            return;
          }
        } catch (cancelErr) {
          if (isRunCancelledError(cancelErr) || isRunAuthExpiredError(cancelErr)) {
            jsonLog("run_cancellation_skip_finalize", {
              run_id: run.id,
              checkpoint: "work_inner_error",
              error: errorDetail(cancelErr).slice(0, 500),
            });
            return;
          }
          throw cancelErr;
        }
        if (existing_run_id) {
          await finalizeChild(sb, run.id, single_report_id || reportIds[0], pass, fail, true, String((e as any)?.message || e));
        } else {
          // Preserve cancelled — never overwrite with failed.
          await checkedWrite(sb.from("runs").update({
            status: "failed", finished_at: new Date().toISOString(),
            summary: { pass, fail, total: pass + fail, error: String(e) },
          }).eq("id", run.id).eq("status", "running"), "Run update failed");
        }
      }
    };

    // Child invocations (workstream → report) await work locally so the parent
    // pool can cap in-flight Browserless sessions. Hosted Edge still uses
    // waitUntil to stay under the 150s request timeout.
    // @ts-ignore — EdgeRuntime is available in Supabase Edge runtime
    const isEdge = typeof EdgeRuntime !== "undefined";
    if (existing_run_id && !isEdge) {
      await work();
      const childStatus = cancellation.isCancelled() ? "cancelled" : "completed";
      return new Response(JSON.stringify({ run_id: run.id, status: childStatus, concurrency }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    // @ts-ignore — EdgeRuntime is available in Supabase Edge runtime
    if (isEdge && EdgeRuntime?.waitUntil) {
      // @ts-ignore
      EdgeRuntime.waitUntil(work());
    } else {
      work().catch((error) => jsonLog("background_work_failed", { run_id: run.id, error: errorDetail(error).slice(0, 300) }));
    }

    return new Response(JSON.stringify({ run_id: run.id, status: "running", concurrency }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

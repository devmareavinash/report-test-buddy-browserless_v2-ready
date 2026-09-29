import { corsHeaders } from "../_shared/cors.ts";
import { getSupabaseForRequest, requireAuth } from "../_shared/auth.ts";
import { resolveFunctionAuth, resolveFunctionUrl } from "../_shared/internal-functions.ts";
import { extractFirstTableAlias, qualifyColumn } from "../_shared/sql-filter.ts";
import { fetchCanonicalScript, scriptHasSavedCode, updateScriptRow } from "../_shared/canonical-script.ts";
import { compareTables, summarizeTableCompare, toTableModel } from "../_shared/table-compare.ts";

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

function makeCallFn(callerAuthorization: string) {
  return async (name: string, body: any) => {
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
// Read-modify-write with retries; finalises the parent run when all children done.
async function finalizeChild(sb: any, runId: string, addPass: number, addFail: number, hadError: boolean, errMsg?: string) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const { data: cur } = await sb.from("runs").select("summary, status").eq("id", runId).maybeSingle();
    if (!cur) return;
    const s: any = cur.summary || {};
    const childCount = Number(s.child_count || 0);
    const done = Number(s.done || 0) + 1;
    const merged: any = {
      pass: Number(s.pass || 0) + addPass,
      fail: Number(s.fail || 0) + addFail,
      total: Number(s.total || 0) + addPass + addFail,
      done,
      child_count: childCount,
    };
    if (hadError) merged.errors = [...(Array.isArray(s.errors) ? s.errors : []), errMsg || "child error"];
    const isLast = childCount > 0 && done >= childCount;
    const patch: any = { summary: merged };
    if (isLast) {
      patch.status = (merged.fail > 0 || hadError || (merged.errors && merged.errors.length)) ? "completed" : "completed";
      patch.finished_at = new Date().toISOString();
    }
    const { error } = await sb.from("runs").update(patch).eq("id", runId);
    if (!error) return;
    await new Promise((r) => setTimeout(r, 100 + attempt * 150));
  }
}

function orchestrateConcurrency(override?: unknown): number {
  const fromBody = Number(override);
  if (Number.isFinite(fromBody) && fromBody >= 1) return Math.min(10, Math.floor(fromBody));
  const raw = Deno.env.get("ORCHESTRATE_CONCURRENCY") || Deno.env.get("BROWSERLESS_CONCURRENT") || "3";
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.min(10, Math.floor(n)) : 3;
}

async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!items.length) return [];
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
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

/**
 * Refresh-date KPIs ("Sep 11 - 2026", "6/30/2026", "30 Jun 2026") must NOT go
 * through toNum: stripping non-digits leaves "11-2026" and parseFloat returns
 * 11, so the Latest-result tab showed a bare day-of-month instead of the date.
 * Dates are compared as text, so keep the original string.
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

const STRUCTURED_KPI_KEYS = new Set(["grid", "graph", "data", "table", "tabledata", "series", "chart", "rows", "heatmap", "viz", "dataset"]);

function isStructuredVal(v: any): boolean {
  if (v == null || typeof v === "boolean") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v !== "object") return false;
  return Object.keys(v).some((k) => STRUCTURED_KPI_KEYS.has(k.toLowerCase().replace(/[^a-z0-9]/g, "")));
}

function pickStructured(map: Record<string, any> | null | undefined): { k: string; v: any } | null {
  if (!map || typeof map !== "object") return null;
  for (const k of Object.keys(map)) {
    if (STRUCTURED_KPI_KEYS.has(k.toLowerCase().replace(/[^a-z0-9]/g, "")) && map[k] && typeof map[k] === "object") {
      return { k, v: map[k] };
    }
  }
  for (const [k, v] of Object.entries(map)) {
    if (isStructuredVal(v)) return { k, v };
  }
  return null;
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

// Pull a combo's KPI map out of the script return payload. The script may return
// data nested under several shapes — be liberal.
function pickComboKpis(payload: any, comboLabel: string | null): Record<string, any> | null {
  const candidates = [
    payload?.extracted?.result,
    payload?.extracted?.extracted,
    payload?.result?.extracted,
    payload?.result,
    payload?.extracted,
  ];
  for (const root of candidates) {
    if (!root || typeof root !== "object") continue;
    // Single-combo (no matrix) shape: flat KPI map
    if (!comboLabel) {
      const flat: Record<string, any> = {};
      for (const [k, v] of Object.entries(root)) {
        if (["filters_applied", "screenshot", "ok", "error", "url", "title", "note", "result", "extracted", "navigation"].includes(k)) continue;
        if (v && typeof v === "object") {
          if (k === "grains" || Array.isArray(v) && (k === "periods" || k === "missing")) flat[k] = v;
          else if (isStructuredVal(v)) flat[k] = v;
          continue;
        }
        flat[k] = v;
      }
      if (Object.keys(flat).length) return flat;
    } else {
      // Matrix shape: { "<comboLabel>": { "<KPI>": value, filters_applied: ... } }
      const node = (root as any)[comboLabel] || (root as any).results?.[comboLabel];
      if (node && typeof node === "object") {
        const flat: Record<string, any> = {};
        for (const [k, v] of Object.entries(node)) {
          if (k === "filters_applied" || k === "navigation") continue;
          if (v && typeof v === "object") {
            if (k === "grains" || Array.isArray(v) && (k === "periods" || k === "missing")) flat[k] = v;
            else if (isStructuredVal(v)) flat[k] = v;
            continue;
          }
          flat[k] = v;
        }
        return flat;
      }
    }
  }
  return null;
}

// Extract filters_applied for a combo from the runtime payload (pickComboKpis strips it).
function pickComboFiltersApplied(payload: any, comboLabel: string | null): Record<string, any> | null {
  const candidates = [
    payload?.extracted?.result,
    payload?.extracted?.extracted,
    payload?.result?.extracted,
    payload?.result,
    payload?.extracted,
  ];
  for (const root of candidates) {
    if (!root || typeof root !== "object") continue;
    if (comboLabel) {
      const node = (root as any)[comboLabel];
      if (node && typeof node === "object" && node.filters_applied && typeof node.filters_applied === "object") {
        return node.filters_applied;
      }
    } else if ((root as any).filters_applied && typeof (root as any).filters_applied === "object") {
      return (root as any).filters_applied;
    }
  }
  return null;
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
  const callerAuthorization = req.headers.get("Authorization") || (SERVICE_KEY ? `Bearer ${SERVICE_KEY}` : "");
  const callFn = makeCallFn(callerAuthorization);
  const sb = getSupabaseForRequest(req);
  try {
    const body = await req.json();
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
          await sb.from("runs").update({
            status: "cancelled",
            finished_at: new Date().toISOString(),
            summary: {
              ...initialSummary,
              error: "overlapping execution already running",
              active_run_id: winner.id,
            },
          }).eq("id", run.id);
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
    if (!existing_run_id && scope_type === "workstream") {
      const dispatch = async () => {
        // Cap in-flight child reports. Local Deno awaits each child until that
        // report finishes, so this pool actually limits Browserless load.
        // Parent summary updates are stored in one JSONB column. Process report
        // children serially until the aggregation is moved to an atomic DB RPC.
        const reportConcurrency = 1;
        const childConcurrency = Math.max(1, Math.floor(concurrency / reportConcurrency));
        await mapPool(reportIds, reportConcurrency, async (rid) => {
          try {
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
          } catch (e) {
            console.error("child dispatch failed", rid, e);
            await finalizeChild(sb, run.id, 0, 1, true, String(e));
          }
        });
      };
      // @ts-ignore
      if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
        // @ts-ignore
        EdgeRuntime.waitUntil(dispatch());
      } else {
        dispatch().catch(() => {});
      }
      if (reportIds.length === 0) {
        await sb.from("runs").update({
          status: "completed", finished_at: new Date().toISOString(),
          summary: { pass: 0, fail: 0, total: 0, done: 0, child_count: 0 },
        }).eq("id", run.id);
      }
      return new Response(JSON.stringify({ run_id: run.id, status: "running" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Heavy work runs in the background so we don't hit the 150s edge timeout.
    // Client polls runs/test_results to observe progress.
    const work = async () => {
      let pass = 0, fail = 0;
      try {
        for (const reportId of reportIds) {
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
          const { data: scenarios } = await scenariosQuery;

          const scenarioOutcomes = await mapPool(scenarios || [], concurrency, async (s) => {
            let { data: script, error: scriptErr } = await fetchCanonicalScript(
              sb,
              s.id,
              "id, playwright_code, assertion_spec, sql_template_id, created_at",
            );
            if (scriptErr) {
              await sb.from("test_results").insert({
                run_id: run.id, scenario_id: s.id, status: "fail",
                expected: { error: "script_lookup_failed" },
                actual: { error: scriptErr.message },
                diff: null, criticality: s.criticality || "medium", severity: s.criticality || "medium",
              });
              return { pass: 0, fail: 1 };
            }
            // Shared DB row — never per-user. Generate only when no saved playwright_code exists.
            if (!scriptHasSavedCode(script)) {
              const gen = await callFn("agent-scripts", { scenario_id: s.id });
              if (gen?.script?.playwright_code) {
                script = gen.script;
              } else {
                await sb.from("test_results").insert({
                  run_id: run.id, scenario_id: s.id, status: "fail",
                  expected: { error: "script_generation_failed" },
                  actual: { error: gen?.message || gen?.error || "agent-scripts returned no code" },
                  diff: null, criticality: s.criticality || "medium", severity: s.criticality || "medium",
                });
                return { pass: 0, fail: 1 };
              }
            }

            // Case-level KPI configuration is the source of truth. Report KPI
            // config is only a default for legacy cases that have no saved KPI
            // list or tolerances in their assertion spec.
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
            const preferredKpis = configuredKpis.length
              ? configuredKpis
              : (toleranceKpis.length ? toleranceKpis : reportKpiLabels);
            const kpiLabels: string[] = Array.from(new Set<string>(
              preferredKpis
                .map((label: any) => String(label || "").trim())
                .filter((label: string) => label && !label.startsWith("__")),
            ));

            let matrixQuery = sb.from("scenario_filter_matrix")
              .select("id, label, filters").eq("scenario_id", s.id)
              .order("created_at", { ascending: true });
            if (single_combo_id) matrixQuery = matrixQuery.eq("id", single_combo_id);
            const { data: matrix } = await matrixQuery;
            if (single_combo_id && !matrix?.length) {
              throw new Error(`filter combination ${single_combo_id} was not found for scenario ${s.id}`);
            }
            const hasCombos = !!(matrix && matrix.length > 0);
            const combos = hasCombos
              ? matrix!.map((m: any, i: number) => ({ id: m.id, label: m.label || `combo_${i + 1}`, filters: m.filters || {} }))
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
                  refCode = swapGotoUrl(script.playwright_code || "", refUrl, primaryUrl);
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
            }

            const [runResp, refRespRaw] = await Promise.all([
              callFn("playwright-runtime", {
                mode: "headless", scenario_id: s.id, code: script.playwright_code,
              }),
              (isRef && !refError && refCode)
                ? callFn("playwright-runtime", {
                    mode: "headless", scenario_id: s.id, code: refCode, target: "reference",
                  })
                : Promise.resolve(null),
            ]);
            const runExec = runResp?.extracted;
            if (
              runResp?.error ||
              runResp?.ok === false ||
              runExec?.ok === false ||
              runExec?.error
            ) {
              await sb.from("test_results").insert({
                run_id: run.id, scenario_id: s.id, status: "fail",
                expected: { source: "scrape" },
                actual: {
                  error:
                    runResp?.error ||
                    runResp?.message ||
                    runExec?.error ||
                    runExec?.message ||
                    "scrape failed",
                },
                diff: null, criticality: s.criticality || "medium", severity: s.criticality || "medium",
                screenshot_url: runResp?.screenshot_url || null,
              });
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

            const comboOutcomes = await mapPool(combos, Math.min(concurrency, 8), async (combo) => {
              const scraped = pickComboKpis(runResp, combo.label) || {};

              let expectedMap: Record<string, any> = {};
              let sqlMeta: any = { source: isRef ? "reference_script" : (sqlTplId ? "warehouse" : "none") };
              let sqlRow: Record<string, any> | null = null;

              if (isRef) {
                const refScraped = refError ? {} : (pickComboKpis(refResp, combo.label) || {});
                sqlMeta = {
                  source: "reference_script",
                  reference_url: (report as any)?.reference_url || null,
                  ok: !refError,
                  error: refError,
                  ran_without_filters: !hasCombos,
                };
                sqlRow = refError ? null : refScraped;
                for (const lbl of kpiLabels.length ? kpiLabels : Object.keys(scraped)) {
                  const raw = (refScraped as any)[lbl];
                  expectedMap[lbl] = (raw != null && typeof raw === "object")
                    ? raw
                    : (looksLikeDateValue(raw) ? String(raw).trim() : toNum(raw));
                }
                const refGrid = pickStructured(refScraped);
                if (refGrid && expectedMap[refGrid.k] == null) expectedMap[refGrid.k] = refGrid.v;
              } else if (sqlTplId) {
                const { where, pairs, missing } = hasCombos
                  ? buildWhere(combo.filters || {}, keyMap || [])
                  : { where: "", pairs: [] as { be: string; value: string }[], missing: [] as string[] };
                if (missing.length) {
                  const message = `Missing FE-to-BE filter mapping for: ${missing.join(", ")}`;
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
                        pickComboFiltersApplied(runResp, combo.label) ||
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
                for (const lbl of kpiLabels.length ? kpiLabels : Object.keys(scraped)) {
                  const col = findCol(lbl);
                  if (col && rows[0]) {
                    const raw = rows[0][col];
                    expectedMap[lbl] = looksLikeDateValue(raw)
                      ? String(raw).trim()
                      : toNum(raw);
                  } else if (sqlResp?.scalar != null) {
                    expectedMap[lbl] = looksLikeDateValue(sqlResp.scalar)
                      ? String(sqlResp.scalar).trim()
                      : toNum(sqlResp.scalar);
                  }
                  else expectedMap[lbl] = null;
                }
              }

              const actualMap: Record<string, any> = {};
              const diffMap: Record<string, any> = {};
              let comboPass = true;
              const labels = (kpiLabels.length ? kpiLabels : Object.keys(scraped));
              const kpiTol: Record<string, any> = ((script as any)?.assertion_spec || {}).kpi_tolerances || {};
              const mainGrid = pickStructured(scraped);
              const expGrid = pickStructured(expectedMap);

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
              if (mainGrid) actualMap[mainGrid.k] = mainGrid.v;
              if (mainGrid && expGrid) {
                // Grid / graph Show Data: compare cell by cell so the configured
                // comparator + tolerance apply. JSON.stringify equality ignored both
                // and failed the whole visual on any single differing cell.
                // Change/delta rows (NBRx Change, TRx Change, ...) are skipped.
                const gTolEntry: any = kpiTol[mainGrid.k];
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
                  diffMap[mainGrid.k] = {
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
                  diffMap[mainGrid.k] = { structured: true, pass: gridPass, cellwise: false };
                }
                if (!gridPass) comboPass = false;
              } else if (mainGrid && (isRef || sqlTplId) && !expGrid) {
                comboPass = false;
                diffMap[mainGrid.k] = { structured: true, error: "no_expected_grid" };
              }

              for (const lbl of labels) {
                const rawA = (scraped as any)[lbl];
                if (isStructuredVal(rawA) || STRUCTURED_KPI_KEYS.has(String(lbl).toLowerCase().replace(/[^a-z0-9]/g, ""))) {
                  if (actualMap[lbl] === undefined) actualMap[lbl] = rawA;
                  continue;
                }
                // Refresh dates stay as text — see looksLikeDateValue.
                if (looksLikeDateValue(rawA)) {
                  const aStr = String(rawA).trim();
                  actualMap[lbl] = aStr;
                  const eRaw = expectedMap[lbl] ?? null;
                  const eStr = eRaw == null ? null : String(eRaw).trim();
                  if (!sqlTplId && !isRef) {
                    // Nothing to compare against: presence is the only check.
                    diffMap[lbl] = { value: aStr, kind: "date" };
                  } else {
                    const norm = (x: string) => x.replace(/\s+/g, " ").replace(/\s*[-,]\s*/g, " ").trim().toLowerCase();
                    const datePass = eStr != null && norm(aStr) === norm(eStr);
                    diffMap[lbl] = { kind: "date", actual: aStr, expected: eStr, pass: datePass };
                    if (!datePass) comboPass = false;
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
                  const tEntry: any = kpiTol[lbl];
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

              const status = comboPass ? "pass" : "fail";
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
                const tEntry: any = kpiTol[lbl];
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
              const { data: tr, error: trError } = await sb.from("test_results").insert({
                run_id: run.id, scenario_id: s.id, status,
                expected: { source: sqlMeta.source, filter: combo.label, where_clause: sqlMeta.where_clause, values: expectedMap, row: sqlRow, sql: sqlMeta },
                actual: { filter: combo.label, values: actualMap, filters_applied: pickComboFiltersApplied(runResp, combo.label) || combo.filters || null, tolerances_snapshot: tolerancesSnapshot },
                diff: diffMap,
                criticality: crit,
                severity: crit,
                rank_score: comboPass ? 0 : (["low", "medium", "high", "critical"].indexOf(crit || "medium") + 1),
                screenshot_url: runResp?.screenshot_url || null,
              }).select().single();
              if (trError || !tr) {
                throw new Error(`Failed to persist test result: ${trError?.message || "unknown error"}`);
              }

              if (!comboPass && tr?.id) {
                callFn("agent-analyze", { test_result_id: tr.id }).catch(() => {});
              }
              return { pass: comboPass ? 1 : 0, fail: comboPass ? 0 : 1 };
            });
            let localPass = 0, localFail = 0;
            for (const o of comboOutcomes) {
              localPass += o.pass;
              localFail += o.fail;
            }
            return { pass: localPass, fail: localFail };
          });
          for (const o of scenarioOutcomes) {
            pass += o.pass;
            fail += o.fail;
          }
        }

        if (existing_run_id) {
          await finalizeChild(sb, run.id, pass, fail, false);
        } else {
          await sb.from("runs").update({
            status: "completed", finished_at: new Date().toISOString(),
            summary: { pass, fail, total: pass + fail },
          }).eq("id", run.id);
        }
      } catch (e) {
        if (existing_run_id) {
          await finalizeChild(sb, run.id, pass, fail, true, String(e));
        } else {
          await sb.from("runs").update({
            status: "failed", finished_at: new Date().toISOString(),
            summary: { pass, fail, total: pass + fail, error: String(e) },
          }).eq("id", run.id);
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
      return new Response(JSON.stringify({ run_id: run.id, status: "completed", concurrency }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    // @ts-ignore — EdgeRuntime is available in Supabase Edge runtime
    if (isEdge && EdgeRuntime?.waitUntil) {
      // @ts-ignore
      EdgeRuntime.waitUntil(work());
    } else {
      work().catch(() => {});
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

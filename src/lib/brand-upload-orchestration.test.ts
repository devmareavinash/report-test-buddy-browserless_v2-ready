import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as extraction from "../../supabase/functions/_shared/brand-extraction";
import * as outcomes from "../../supabase/functions/_shared/extraction-outcome";
import * as cancellation from "../../supabase/functions/_shared/run-cancellation";
import * as accounting from "../../supabase/functions/_shared/run-accounting";
import * as structuredRetry from "../../supabase/functions/_shared/structured-extraction-retry";
import * as tables from "../../supabase/functions/_shared/table-compare";
import * as filters from "../../supabase/functions/_shared/filter-verification";
import * as retries from "../../supabase/functions/_shared/transient-retry";
import * as identity from "../../supabase/functions/_shared/combination-identity";
import * as executionStatus from "../../supabase/functions/_shared/execution-status";
import * as runTiming from "../../supabase/functions/_shared/run-timing";

// Exercise the uploaded handler's actual persistence path with deterministic
// browser responses; no live browser, credentials or database are used.
async function execute(secondError = false, options: { duplicate?: boolean; missingFilters?: boolean; rejectInsert?: boolean } = {}) {
  const inserted: any[] = [];
  const calls: any[] = [];
  const updates: any[] = [];
  const diagnostics: any[] = [];
  const work: Promise<unknown>[] = [];
  const table = { columns: ["Region", "TRx"], rows: [["East", 42]] };
  const run = { id: "run-1", status: "running", summary: {} };
  const db = {
    from(tableName: string) {
      let mode = "read";
      let data: any;
      const query: any = {
        select: () => query, eq: () => query, in: () => query,
        range: () => query, order: () => query, limit: () => query, filter: () => query,
        insert(value: any) {
          mode = "insert";
          data = value;
          if (tableName === "test_results") { if (options.rejectInsert) throw new Error("database connection unavailable"); inserted.push(value); }
          return query;
        },
        update: (value: any) => { if (tableName === "runs") updates.push(value); return query; },
        async maybeSingle() {
          return { data: tableName === "runs" ? run : { id: "report-1", kpi_config: [] }, error: null };
        },
        async single() {
          return { data: tableName === "runs" ? run : { ...data, id: "result-1" }, error: null };
        },
        then(resolve: (value: any) => void) {
          const rows = tableName === "scenarios"
            ? [{ id: "scenario-1", title: "Summary", type: "kpi", criticality: "medium" }]
            : tableName === "scenario_filter_matrix"
              ? [{ id: "a", label: options.duplicate ? "East" : "A", filters: { Region: options.duplicate ? "East" : "A" } }, { id: "b", label: options.duplicate ? "East" : "B", filters: options.duplicate ? { Territory: "East" } : { Region: "B" } }]
              : tableName === "test_results" ? inserted.map(row => ({ ...row, scenario_id: "scenario-1" })) : [];
          resolve({ data: mode === "insert" ? data : rows, error: null });
        },
      };
      return query;
    },
  };
  let handler: ((request: Request) => Promise<Response>) | undefined;
  const code = readFileSync("supabase/functions/agent-orchestrate/index.ts", "utf8")
    .replace(/^import[\s\S]*?;\n/gm, "");
  const compiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(compiled, {
    ...extraction, ...outcomes, ...cancellation, ...accounting, ...structuredRetry, ...tables, ...filters, ...retries, ...identity, ...executionStatus, ...runTiming,
    Deno: { env: { get: () => undefined }, serve: (fn: typeof handler) => { handler = fn; }, mkdir: async () => {}, writeTextFile: async () => {} },
    EdgeRuntime: { waitUntil: (promise: Promise<unknown>) => work.push(promise) },
    console: { log: (line: string) => diagnostics.push(line), error: (line: string) => diagnostics.push(line) },
    Response, Request, URL, setTimeout: (fn: () => void) => { fn(); return 0; },
    corsHeaders: {}, getServiceClient: () => db, requireAuth: async () => null,
    getRunSession: () => undefined, registerRunSession: () => {}, releaseRunSession: () => {},
    resolveFunctionAuth: () => "test", resolveFunctionUrl: (name: string) => `https://test.invalid/${name}`,
    internalAuthSource: () => "test", checkBrowserlessHealth: async () => ({ ok: true }),
    fetchCanonicalScript: async () => ({ data: { id: "script-1", playwright_code: "saved-script", assertion_spec: { kpis: ["TRx", "Summary Graph"] } }, error: null }),
    scriptHasSavedCode: () => true,
    fetch: async (url: string, requestOptions: any) => {
      const body = JSON.parse(requestOptions.body);
      calls.push({ url, body });
      if (!url.endsWith("playwright-runtime")) return new Response("{}");
      const a = { filters_applied: options.missingFilters ? null : { Region: options.duplicate ? "East" : "A" }, KPIs: { TRx: { value: 0 } }, "Summary Graph": table };
      const b = { filters_applied: options.duplicate ? { Territory: "East" } : { Region: "B" }, ...(secondError ? { ok: false, error: "Label not found" } : {}), KPIs: { TRx: { value: 7 } }, "Summary Graph": table };
      return new Response(JSON.stringify({ ok: true, extracted: { ok: true, result: options.duplicate ? { results_by_id: { a, b } } : { results: { A: a, B: b } } } }));
    },
  });
  if (!handler) throw new Error("Handler did not register");
  await handler(new Request("https://test.invalid", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope_type: "report", scope_id: "report-1", concurrency: 1 }) }));
  await Promise.all(work);
  return { inserted, calls, table, updates, diagnostics };
}

describe("updated upload Brand persistence", () => {
  it("saves each full-matrix combination's nested scalar and named table without changing script bytes", async () => {
    const { inserted, calls, table } = await execute();
    expect(inserted.map((row) => row.actual.values.TRx)).toEqual([0, 7]);
    expect(inserted.map((row) => row.actual.values["Summary Graph"])).toEqual([table, table]);
    expect(inserted.map((row) => row.status)).toEqual(["pass", "pass"]);
    const runtime = calls.filter((call) => call.url.endsWith("playwright-runtime"));
    expect(runtime).toHaveLength(1);
    expect(runtime[0].body.code).toBe("saved-script");
    expect(runtime[0].body.filter_combinations).toHaveLength(2);
  });
  it("persists the selected combination's hidden error and surviving values without failing its sibling", async () => {
    const { inserted } = await execute(true);
    expect(inserted[0].status).toBe("pass");
    expect(inserted[1].status).toBe("fail");
    expect(inserted[1].actual.error).toBe("Label not found");
    expect(extraction.lookupConfiguredKpiValue(inserted[1].actual.values, "TRx", {})).toBe(7);
  });
  it("keeps duplicate-label small matrices separate through persistence", async () => {
    const { inserted, calls } = await execute(false, { duplicate: true });
    expect(inserted.map(row => row.actual.combo_id)).toEqual(["a", "b"]);
    expect(inserted.map(row => row.actual.values.TRx)).toEqual([0, 7]);
    expect(calls.filter(call => call.url.endsWith("playwright-runtime"))[0].body.filter_combinations.map((combo: any) => combo.id)).toEqual(["a", "b"]);
  });
  it("retains KPI evidence but cannot pass unobserved filters", async () => {
    const { inserted } = await execute(false, { missingFilters: true });
    expect(inserted[0].actual.values.TRx).toBe(0);
    expect(inserted[0].status).not.toBe("pass");
    expect(inserted[0].actual.filter_verification.ok).toBe(false);
  });
  it("surfaces failed result persistence instead of claiming completion", async () => {
    const { updates } = await execute(false, { rejectInsert: true });
    expect(updates.some(update => update.status === "completed")).toBe(false);
    expect(updates.some(update => update.summary?.error?.includes("database connection unavailable"))).toBe(true);
  });

});
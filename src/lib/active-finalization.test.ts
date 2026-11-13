import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { retryTransient } from "../../supabase/functions/_shared/transient-retry";
import { buildUnexecutedRows } from "../../supabase/functions/_shared/run-accounting";

function activeFinalizer() {
  const source = readFileSync("supabase/functions/agent-orchestrate/index.ts", "utf8");
  const start = source.indexOf("async function retryFinalizationOperation");
  const end = source.indexOf("function ", source.indexOf("throw new Error(`Failed to finalize workstream report after retries", start));
  const context: any = { retryTransient, jsonLog: () => {}, errorDetail: (error: any) => error?.message || String(error), setTimeout, Date };
  runInNewContext(ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return context;
}
describe("active inline finalization", () => {
  it("retries a rejected transient RPC and does not double finalize", async () => {
    let calls = 0;
    const sb = { rpc: async () => { calls++; if (calls < 2) throw new Error("network unavailable"); return { error: null }; } };
    await activeFinalizer().finalizeChild(sb, "run", "report", 1, 0, false);
    expect(calls).toBe(2);
  });
  it("retries returned transient fallback write errors while preserving CAS", async () => {
    let writes = 0;
    const filters: any[] = [];
    const chain: any = { select: () => chain, eq: () => chain, filter: (...args: any[]) => { filters.push(args); return chain; }, update: () => { writes++; return chain; }, maybeSingle: async () => writes === 0 ? { data: { status: "running", summary: { child_count: 1 } }, error: null } : writes === 1 ? { data: null, error: { code: "503", message: "temporarily unavailable" } } : { data: { id: "run" }, error: null } };
    const sb = { rpc: async () => ({ error: { code: "42883", message: "function unavailable" } }), from: () => chain };
    await activeFinalizer().finalizeChild(sb, "run", "report", 1, 0, false);
    expect(writes).toBe(2);
    expect(filters).toEqual([["summary", "eq", '{"child_count":1}'], ["summary", "eq", '{"child_count":1}']]);
  });
  it("does not retry authorization errors", async () => {
    let calls = 0;
    const result = await retryTransient(async () => { calls++; return { error: { code: "403", message: "forbidden" } }; }, response => response.error);
    expect(calls).toBe(1);
    expect(result.error.code).toBe("403");
  });
  it("records missing work by scenario plus immutable combination", () => {
    const rows = buildUnexecutedRows({ runId: "run", scenarios: [{ id: "scenario", combo_id: "a" }, { id: "scenario", combo_id: "b" }], accountedIds: new Set(["scenario:a"]), reason: "not_started" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scenario_id: "scenario", status: "pending", actual: { combo_id: "b" } });
  });
});
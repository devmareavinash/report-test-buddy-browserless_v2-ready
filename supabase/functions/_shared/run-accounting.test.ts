import { buildUnexecutedRows, reconcileInvariant } from "./run-accounting.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

Deno.test("builds explicit unexecuted rows for never-started scenarios", () => {
  const scenarios = [
    { id: "a", criticality: "high" },
    { id: "b", criticality: "medium" },
    { id: "c", criticality: "low" },
  ];
  const rows = buildUnexecutedRows({
    runId: "run-1",
    scenarios,
    accountedIds: new Set(["a"]),
    reason: "browserless_timeout",
    detail: "browserless_unhealthy",
  });
  assert(rows.length === 2, `expected 2 rows, got ${rows.length}`);
  assert(rows.every((r) => r.status === "browserless_timeout"), "status");
  assert(rows.every((r: any) => r.diff?.unexecuted === true), "unexecuted flag");
  assert(reconcileInvariant(3, 1, rows.length), "invariant");
});

Deno.test("cancel reason persists cancelled, not pass/fail", () => {
  const rows = buildUnexecutedRows({
    runId: "run-1",
    scenarios: [{ id: "x" }, { id: "y" }],
    accountedIds: new Set(),
    reason: "cancelled",
  });
  assert(rows.every((r) => r.status === "cancelled"), "cancelled status");
  assert(!rows.some((r) => r.status === "pass" || r.status === "fail"), "no fabricated pass/fail");
});

Deno.test("partial child leaves unexecuted count when not all accounted", () => {
  const expected = 10;
  const terminal = 3;
  const rows = buildUnexecutedRows({
    runId: "run-1",
    scenarios: Array.from({ length: expected }, (_, i) => ({ id: `s${i}` })),
    accountedIds: new Set(["s0", "s1", "s2"]),
    reason: "not_started",
  });
  assert(reconcileInvariant(expected, terminal, rows.length), "F invariant");
});

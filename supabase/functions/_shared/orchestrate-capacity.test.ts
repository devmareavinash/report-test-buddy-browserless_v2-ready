import {
  browserlessCapacityMessage,
  maxActiveOrchestrateRuns,
  pickBrowserlessCapacityConflict,
  pickBrowserlessCapacityLoser,
} from "./orchestrate-capacity.ts";

Deno.test("maxActiveOrchestrateRuns defaults to 1", () => {
  if (maxActiveOrchestrateRuns() !== 1) throw new Error("expected default 1");
  if (maxActiveOrchestrateRuns("") !== 1) throw new Error("expected empty -> 1");
  if (maxActiveOrchestrateRuns("0") !== 1) throw new Error("expected 0 -> 1");
  if (maxActiveOrchestrateRuns("2") !== 2) throw new Error("expected 2");
  if (maxActiveOrchestrateRuns("99") !== 5) throw new Error("expected clamp 5");
});

Deno.test("pickBrowserlessCapacityConflict blocks when at shared Browserless capacity", () => {
  const active = [
    { id: "a", scope_type: "workstream", started_at: "2026-11-06T06:00:00.000Z" },
    { id: "b", scope_type: "workstream", started_at: "2026-11-06T06:01:00.000Z" },
  ];
  const blocked = pickBrowserlessCapacityConflict(active, { maxActive: 1 });
  if (!blocked || blocked.id !== "a") throw new Error(`expected oldest conflict, got ${blocked?.id}`);

  const okWithRoom = pickBrowserlessCapacityConflict(
    [{ id: "a", scope_type: "workstream", started_at: "2026-11-06T06:00:00.000Z" }],
    { maxActive: 2 },
  );
  if (okWithRoom) throw new Error("expected null when under capacity");

  const atTwo = pickBrowserlessCapacityConflict(active, { maxActive: 2 });
  if (!atTwo || atTwo.id !== "a") throw new Error("expected conflict at max 2");

  const selfExcluded = pickBrowserlessCapacityConflict(active, {
    maxActive: 2,
    excludeRunId: "b",
  });
  if (selfExcluded) throw new Error("excluding one under max should leave room");
});

Deno.test("browserlessCapacityMessage mentions shared pool for single-slot mode", () => {
  const msg = browserlessCapacityMessage("abcdef12-xxxx", 1);
  if (!/Browserless is busy/i.test(msg) || !/abcdef12/.test(msg)) {
    throw new Error(`unexpected message: ${msg}`);
  }
});

Deno.test("pickBrowserlessCapacityLoser keeps oldest winners instead of cancelling everyone", () => {
  const active = [
    { id: "older", scope_type: "workstream", started_at: "2026-11-06T06:00:00.000Z" },
    { id: "newer", scope_type: "workstream", started_at: "2026-11-06T06:01:00.000Z" },
  ];
  const newerLoses = pickBrowserlessCapacityLoser(active, "newer", { maxActive: 1 });
  if (!newerLoses || newerLoses.id !== "older") {
    throw new Error(`expected newer to lose to older, got ${newerLoses?.id}`);
  }
  const olderWins = pickBrowserlessCapacityLoser(active, "older", { maxActive: 1 });
  if (olderWins) throw new Error("oldest run must keep its slot");

  const dualOk = pickBrowserlessCapacityLoser(active, "newer", { maxActive: 2 });
  if (dualOk) throw new Error("both runs should fit when maxActive=2");
});

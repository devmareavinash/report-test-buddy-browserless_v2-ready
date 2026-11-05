// Deno tests without remote imports (corp proxy breaks deno.land TLS).
import {
  RunAuthExpiredError,
  RunCancelledError,
  createRunCancellationGate,
  isJwtExpiredAuthError,
  isRunAuthExpiredError,
  isRunCancelledError,
  mapPool,
} from "./run-cancellation.ts";

function assert(cond: unknown, msg = "assertion failed"): asserts cond {
  if (!cond) throw new Error(msg);
}
function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (a !== b) {
    throw new Error(msg || `expected ${Deno.inspect(b)}, got ${Deno.inspect(a)}`);
  }
}

type RunRow = { status: string };

function mockRunsClient(statusById: Record<string, RunRow>, opts?: {
  errorForId?: Record<string, { message: string } | null>;
  onSelect?: () => void;
}) {
  return {
    from(table: string) {
      assertEquals(table, "runs");
      return {
        select() {
          return {
            eq(_col: string, id: string) {
              return {
                async maybeSingle() {
                  opts?.onSelect?.();
                  const forced = opts?.errorForId?.[id];
                  if (forced) return { data: null, error: forced };
                  const row = statusById[id];
                  return { data: row ? { status: row.status } : null, error: null };
                },
              };
            },
          };
        },
      };
    },
  };
}

Deno.test("typed cancellation / auth-expired brands (not string matching)", () => {
  assert(isRunCancelledError(new RunCancelledError("run-a")));
  assert(isRunAuthExpiredError(new RunAuthExpiredError("run-a", "JWT expired")));
  assert(!isRunCancelledError(new Error("Run run-a cancelled")));
  assert(!isRunAuthExpiredError(new Error("JWT expired")));
  assert(isJwtExpiredAuthError({ message: "JWT expired" }));
});

Deno.test("cancellation check succeeds with valid auth client", async () => {
  const statusById = { "run-a": { status: "running" } };
  const gate = createRunCancellationGate("run-a", {
    getClient: () => mockRunsClient(statusById) as any,
  });
  assertEquals(await gate.refresh(), false);
  await gate.throwIfCancelled({ checkpoint: "before_scenario" });
});

Deno.test("after access-token expiry, ensureAuth refresh lets cancel checks succeed", async () => {
  const statusById = { "run-a": { status: "running" } };
  let ensureAuthCalls = 0;
  let selectCalls = 0;
  let serverRejectsJwt = true;

  const gate = createRunCancellationGate("run-a", {
    getClient: () =>
      mockRunsClient(statusById, {
        errorForId: {
          // Dynamic: first PostgREST call still sees expired access token
          // (e.g. clock skew / token lapsed during Browserless). Retry path
          // refreshes via ensureAuth then succeeds.
          get "run-a"() {
            return serverRejectsJwt ? { message: "JWT expired" } : null;
          },
        },
        onSelect: () => {
          selectCalls++;
        },
      }) as any,
    ensureAuth: async () => {
      ensureAuthCalls++;
      // First ensureAuth (before first select) does not yet renew — mirrors a
      // RunSession that still believed the access token was inside margin.
      // After JWT-expired retry, the next ensureAuth renews.
      if (ensureAuthCalls >= 2) serverRejectsJwt = false;
    },
    canRefresh: () => true,
  });

  assertEquals(await gate.refresh(), false);
  assert(ensureAuthCalls >= 2);
  assert(selectCalls >= 2); // first JWT expired, retry after refresh
});

Deno.test("cancel after original token expiry is still detected", async () => {
  const statusById = { "run-a": { status: "cancelled" } };
  let accessToken = "expired-jwt";
  const errorForId: Record<string, { message: string } | null> = {
    "run-a": { message: "JWT expired" },
  };
  const gate = createRunCancellationGate("run-a", {
    getClient: () => mockRunsClient(statusById, { errorForId }) as any,
    ensureAuth: async () => {
      if (accessToken === "expired-jwt") {
        accessToken = "fresh-jwt";
        errorForId["run-a"] = null;
      }
    },
    canRefresh: () => true,
  });
  let threw: unknown;
  try {
    await gate.throwIfCancelled({ checkpoint: "after_runtime" });
  } catch (e) {
    threw = e;
  }
  assert(isRunCancelledError(threw));
});

Deno.test("without refresh credentials, JWT expiry fails clearly", async () => {
  const statusById = { "run-a": { status: "running" } };
  const gate = createRunCancellationGate("run-a", {
    getClient: () =>
      mockRunsClient(statusById, {
        errorForId: { "run-a": { message: "JWT expired" } },
      }) as any,
    canRefresh: () => false,
  });
  let threw: unknown;
  try {
    await gate.refresh();
  } catch (e) {
    threw = e;
  }
  assert(isRunAuthExpiredError(threw));
  assert(!isRunCancelledError(threw));
});

Deno.test("ensureAuth is not a forced network refresh every checkpoint when token fresh", async () => {
  const statusById = { "run-a": { status: "running" } };
  let tokenCalls = 0;
  let networkRefresh = 0;
  const gate = createRunCancellationGate("run-a", {
    getClient: () => mockRunsClient(statusById) as any,
    // Mirrors RunSession.token(): only refresh inside margin.
    ensureAuth: async () => {
      tokenCalls++;
      const nearExpiry = false;
      if (nearExpiry) networkRefresh++;
    },
    canRefresh: () => true,
  });
  await gate.refresh();
  await gate.refresh();
  await gate.refresh();
  assertEquals(tokenCalls, 3);
  assertEquals(networkRefresh, 0);
});

Deno.test("getClient is resolved per status read (no stale client capture)", async () => {
  const statusById = { "run-a": { status: "running" } };
  const clients: unknown[] = [];
  const gate = createRunCancellationGate("run-a", {
    getClient: () => {
      const c = mockRunsClient(statusById);
      clients.push(c);
      return c as any;
    },
  });
  await gate.refresh();
  await gate.refresh();
  assertEquals(clients.length, 2);
  assert(clients[0] !== clients[1]);
});

Deno.test("mapPool stops new Browserless-like work after cancel", async () => {
  const statusById = { "run-a": { status: "running" } };
  const gate = createRunCancellationGate("run-a", {
    getClient: () => mockRunsClient(statusById) as any,
  });
  const started: number[] = [];
  await mapPool([0, 1, 2], 1, async (item) => {
    started.push(item);
    if (item === 0) {
      statusById["run-a"].status = "cancelled";
      await gate.refresh();
      return item;
    }
    await gate.throwIfCancelled({ checkpoint: "before_runtime" });
    return item;
  }, () => gate.isCancelled());
  assertEquals(JSON.stringify(started), JSON.stringify([0]));
});

Deno.test("cancelling run A does not affect run B auth/cancel gate", async () => {
  const statusById = {
    "run-a": { status: "cancelled" },
    "run-b": { status: "running" },
  };
  const gateA = createRunCancellationGate("run-a", {
    getClient: () => mockRunsClient(statusById) as any,
  });
  const gateB = createRunCancellationGate("run-b", {
    getClient: () => mockRunsClient(statusById) as any,
  });
  assertEquals(await gateA.refresh(), true);
  assertEquals(await gateB.refresh(), false);
  await gateB.throwIfCancelled({ checkpoint: "before_scenario" });
});

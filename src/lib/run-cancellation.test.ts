import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RunAuthExpiredError,
  createRunCancellationGate,
  isRunAuthExpiredError,
} from "../../supabase/functions/_shared/run-cancellation";

describe("long-run auth wiring", () => {
  it("sends X-Refresh-Token for agent-orchestrate unless explicitly disabled", () => {
    const src = readFileSync(resolve(process.cwd(), "src/lib/functions.ts"), "utf8");
    expect(src).toContain('VITE_RUN_SESSION_REFRESH !== "false"');
    expect(src).toContain("authHeaders(name === \"agent-orchestrate\")");
    expect(src).toContain("X-Refresh-Token");
  });

  it("cancellation gate uses getClient + ensureAuth, not a captured JWT", () => {
    const src = readFileSync(
      resolve(process.cwd(), "supabase/functions/agent-orchestrate/index.ts"),
      "utf8",
    );
    expect(src).toContain("getClient: () => sb");
    expect(src).toContain("ensureAuth: session ? () => session.token()");
    expect(src).toContain("canRefresh: () => Boolean(session?.canRefresh)");
    expect(src).toContain("isRunAuthExpiredError");
  });

  it("JWT expiry without refresh fails clearly", async () => {
    const gate = createRunCancellationGate("run-a", {
      getClient: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: { message: "JWT expired" } }),
            }),
          }),
        }),
      }),
      canRefresh: () => false,
    });
    await expect(gate.refresh()).rejects.toBeInstanceOf(RunAuthExpiredError);
    expect(isRunAuthExpiredError(new RunAuthExpiredError("run-a", "JWT expired"))).toBe(true);
  });
});

/**
 * Cooperative run cancellation for agent-orchestrate (Phase 1).
 * Cancel is detected by reading runs.status; in-flight Browserless calls are
 * allowed to finish, then workers stop before the next unit of work.
 *
 * Auth: each status read obtains the current run-scoped Supabase client (via
 * getClient) after optional ensureAuth (RunSession.token()). Do not capture a
 * one-shot JWT at gate construction.
 */

export const RUN_CANCELLED_BRAND = Symbol.for("rtb.RunCancelledError");
export const RUN_AUTH_EXPIRED_BRAND = Symbol.for("rtb.RunAuthExpiredError");

export type CancellationCheckpoint =
  | "before_report"
  | "before_scenario"
  | "before_combo"
  | "before_runtime"
  | "after_runtime"
  | "before_retry"
  | "before_reference"
  | "before_persist"
  | "before_finalize"
  | "before_analyze"
  | "after_pool";

export type CancellationContext = {
  checkpoint?: CancellationCheckpoint | string;
  report_id?: string | null;
  scenario_id?: string | null;
  combo?: string | null;
  target?: "main" | "reference" | null;
  attempt?: number | null;
};

export class RunCancelledError extends Error {
  readonly [RUN_CANCELLED_BRAND] = true as const;
  readonly runId: string;
  readonly context: CancellationContext;

  constructor(runId: string, context: CancellationContext = {}) {
    super(`Run ${runId} cancelled`);
    this.name = "RunCancelledError";
    this.runId = runId;
    this.context = context;
  }
}

export class RunAuthExpiredError extends Error {
  readonly [RUN_AUTH_EXPIRED_BRAND] = true as const;
  readonly runId: string;
  readonly causeMessage: string;

  constructor(runId: string, causeMessage: string) {
    super(`Run ${runId} auth expired: ${causeMessage}`);
    this.name = "RunAuthExpiredError";
    this.runId = runId;
    this.causeMessage = causeMessage;
  }
}

export function isRunCancelledError(error: unknown): error is RunCancelledError {
  return typeof error === "object" &&
    error !== null &&
    (error as { [RUN_CANCELLED_BRAND]?: unknown })[RUN_CANCELLED_BRAND] === true;
}

export function isRunAuthExpiredError(error: unknown): error is RunAuthExpiredError {
  return typeof error === "object" &&
    error !== null &&
    (error as { [RUN_AUTH_EXPIRED_BRAND]?: unknown })[RUN_AUTH_EXPIRED_BRAND] === true;
}

export function isJwtExpiredAuthError(error: unknown): boolean {
  const msg = String(
    (error && typeof error === "object" && "message" in error)
      ? (error as { message?: unknown }).message
      : error ?? "",
  ).toLowerCase();
  return msg.includes("jwt expired") ||
    msg.includes("invalid jwt") ||
    msg.includes("token is expired");
}

export type CancellationLogFn = (
  event: string,
  details: Record<string, unknown>,
) => void;

export type RunDbClient = {
  from: (table: string) => any;
};

export type RunCancellationGateOptions = {
  /** Fresh client for each status read (must use current RunSession token). */
  getClient: () => RunDbClient | Promise<RunDbClient>;
  /**
   * Invoke before each status read so RunSession can refresh when near expiry.
   * Must not force a network refresh on every call — RunSession.token() already
   * refreshes only inside its margin.
   */
  ensureAuth?: () => Promise<unknown>;
  /** True when a refresh token is available for mid-run renewal. */
  canRefresh?: () => boolean;
  log?: CancellationLogFn;
};

export type RunCancellationGate = {
  /** Run-local flag — once true, all workers for this gate stop taking work. */
  isCancelled: () => boolean;
  /** Force the local flag (e.g. after observing cancelled status). */
  markCancelled: () => void;
  /** Read runs.status once (cached after cancelled). */
  refresh: () => Promise<boolean>;
  /** Refresh + throw RunCancelledError when cancelled. */
  throwIfCancelled: (context?: CancellationContext) => Promise<void>;
};

/**
 * Per-run cancellation gate. Local flag is run-scoped: cancelling run A never
 * flips the flag on a gate created for run B.
 */
export function createRunCancellationGate(
  runId: string,
  options: RunCancellationGateOptions,
): RunCancellationGate {
  let cancelled = false;
  const { getClient, ensureAuth, canRefresh, log } = options;

  const markCancelled = () => {
    cancelled = true;
  };

  const isCancelled = () => cancelled;

  const readStatus = async () => {
    await ensureAuth?.();
    const sb = await getClient();
    return await sb.from("runs").select("status").eq("id", runId).maybeSingle();
  };

  const refresh = async (): Promise<boolean> => {
    if (cancelled) return true;

    let { data, error } = await readStatus();

    // Access token may have lapsed during a long Browserless call. If RunSession
    // can refresh, ensureAuth + retry once with a fresh client/token.
    if (error && isJwtExpiredAuthError(error) && canRefresh?.()) {
      await ensureAuth?.();
      ({ data, error } = await readStatus());
    }

    if (error) {
      const errText = String(error?.message || error).slice(0, 300);
      if (isJwtExpiredAuthError(error)) {
        log?.("run_auth_expired", {
          run_id: runId,
          error: errText,
          can_refresh: Boolean(canRefresh?.()),
        });
        throw new RunAuthExpiredError(runId, errText);
      }
      log?.("run_cancellation_check_failed", {
        run_id: runId,
        error: errText,
      });
      // Non-auth DB errors: do not treat as cancelled (fail-open for cancel only).
      return false;
    }
    if (data?.status === "cancelled") {
      cancelled = true;
      return true;
    }
    return false;
  };

  const throwIfCancelled = async (context: CancellationContext = {}): Promise<void> => {
    const nowCancelled = await refresh();
    if (!nowCancelled) return;
    log?.("run_cancellation_detected", {
      run_id: runId,
      checkpoint: context.checkpoint ?? null,
      report_id: context.report_id ?? null,
      scenario_id: context.scenario_id ?? null,
      combo: context.combo ?? null,
      target: context.target ?? null,
      attempt: context.attempt ?? null,
    });
    throw new RunCancelledError(runId, context);
  };

  return { isCancelled, markCancelled, refresh, throwIfCancelled };
}

/**
 * Bounded-concurrency mapper. When `shouldStop` becomes true, workers stop
 * claiming new items; in-flight `fn` calls are allowed to finish.
 * Unclaimed slots remain `undefined` in the results array.
 */
export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  shouldStop?: () => boolean,
): Promise<Array<R | undefined>> {
  if (!items.length) return [];
  const results: Array<R | undefined> = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (true) {
        if (shouldStop?.()) return;
        const index = next++;
        if (index >= items.length) return;
        try {
          results[index] = await fn(items[index], index);
        } catch (error) {
          // Soft-stop on cooperative cancel so Promise.all does not reject while
          // sibling workers are still finishing (avoids unhandled rejections and
          // keeps RunCancelledError out of generic failure paths). Callers must
          // throwIfCancelled / refresh after the pool.
          if (isRunCancelledError(error)) return;
          throw error;
        }
      }
    },
  );
  await Promise.all(workers);
  return results;
}

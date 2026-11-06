/**
 * Shared Browserless capacity for brand / workstream runs.
 *
 * One Chromium pool serves every brand. Overlapping Prostate + Lynkuet runs
 * previously crashed Browserless (connection refused). Cap how many
 * orchestrate-scoped runs may be `running` at once.
 */

export const ORCHESTRATE_SCOPE_TYPES = ["scenario", "report", "workstream"] as const;

export type OrchestrateScopeType = (typeof ORCHESTRATE_SCOPE_TYPES)[number];

/** Safe default: one active brand/run. Raise via MAX_ACTIVE_ORCHESTRATE_RUNS after sizing the task. */
export function maxActiveOrchestrateRuns(envValue?: string | null): number {
  const raw = envValue ?? "";
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(5, Math.floor(n));
}

export function isOrchestrateScopeType(scopeType: string | null | undefined): boolean {
  return ORCHESTRATE_SCOPE_TYPES.includes(String(scopeType || "") as OrchestrateScopeType);
}

function sortOrchestrateRunsByAge<T extends { id: string; started_at?: string | null }>(runs: T[]): T[] {
  return runs.slice().sort((a, b) => {
    const time = new Date(a.started_at || 0).getTime() - new Date(b.started_at || 0).getTime();
    return time || String(a.id).localeCompare(String(b.id));
  });
}

/**
 * Oldest active run that fills the shared Browserless slot budget, if any.
 * `excludeRunId` skips the caller's own row (pre-insert / "other runs only" check).
 */
export function pickBrowserlessCapacityConflict<T extends { id: string; scope_type?: string | null; started_at?: string | null }>(
  activeRuns: T[],
  opts?: { maxActive?: number; excludeRunId?: string },
): T | null {
  const maxActive = opts?.maxActive ?? 1;
  const exclude = opts?.excludeRunId;
  const others = sortOrchestrateRunsByAge(
    (activeRuns || []).filter((run) => run.id !== exclude && isOrchestrateScopeType(run.scope_type)),
  );
  if (others.length >= maxActive) return others[0] || null;
  return null;
}

/**
 * Post-insert race: keep the oldest `maxActive` runs; everyone else must cancel.
 * Returns a surviving older run when `runId` is outside the winner set.
 */
export function pickBrowserlessCapacityLoser<T extends { id: string; scope_type?: string | null; started_at?: string | null }>(
  activeRuns: T[],
  runId: string,
  opts?: { maxActive?: number },
): T | null {
  const maxActive = opts?.maxActive ?? 1;
  const ranked = sortOrchestrateRunsByAge(
    (activeRuns || []).filter((run) => isOrchestrateScopeType(run.scope_type)),
  );
  if (ranked.length <= maxActive) return null;
  const winners = new Set(ranked.slice(0, maxActive).map((run) => run.id));
  if (winners.has(runId)) return null;
  return ranked[0] || null;
}

export function browserlessCapacityMessage(activeRunId: string, maxActive: number): string {
  const short = String(activeRunId || "").slice(0, 8);
  if (maxActive <= 1) {
    return (
      `Browserless is busy with another brand/run (${short}). ` +
      `Wait for it to finish or cancel it before starting a second brand — ` +
      `overlapping brands overload the shared Chromium pool.`
    );
  }
  return (
    `Browserless is at capacity (${maxActive} active runs). ` +
    `Wait for run ${short} (or another active run) to finish before starting more.`
  );
}

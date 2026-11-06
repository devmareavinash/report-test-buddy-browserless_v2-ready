/**
 * Keep in sync with supabase/functions/_shared/orchestrate-capacity.ts and
 * infra/ecs/task-definition.json MAX_ACTIVE_ORCHESTRATE_RUNS.
 * Vite inlines VITE_* at build time — rebuild web when raising dual-brand capacity.
 */
export function maxActiveOrchestrateRuns(): number {
  const raw = String((import.meta as any).env?.VITE_MAX_ACTIVE_ORCHESTRATE_RUNS ?? "");
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(5, Math.floor(n));
}

// Run timing: browser-call stopwatch + optional script phase marks.
// Records durations only — never selectors, URLs or credentials.
export type PhaseKey = "login" | "load" | "filters" | "data_ready" | "extract";
export const PHASE_KEYS: PhaseKey[] = ["login", "load", "filters", "data_ready", "extract"];

export interface TimedAttempt {
  target: "main" | "reference";
  combo: string | null;
  attempt: number;
  started_at: string;
  browser_ms: number;
  outcome: string | null;
  phases: Partial<Record<PhaseKey, number>> | null;
  script?: { script_started_at: string; script_ms: number; segments: Array<{ phase: PhaseKey; start_ms: number; end_ms: number }> } | null;
}

export function extractScriptTiming(response: unknown, depth = 0): TimedAttempt["script"] {
  if (!response || typeof response !== "object" || depth > 5) return null;
  const node = response as Record<string, any>;
  const t = node.__rtb_timing;
  if (t && Number.isFinite(t.script_ms) && Number.isFinite(Date.parse(t.script_started_at)) && Array.isArray(t.segments)) return t;
  for (const value of Object.values(node)) {
    const found = extractScriptTiming(value, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Find a script-reported `timings` block (numbers in ms) anywhere shallow in the response. */
export function extractPhases(response: unknown, depth = 0): Partial<Record<PhaseKey, number>> | null {
  if (!response || typeof response !== "object" || depth > 4) return null;
  const node = response as Record<string, unknown>;
  const t = node.timings ?? node.__rtb_timings;
  if (t && typeof t === "object" && !Array.isArray(t)) {
    const out: Partial<Record<PhaseKey, number>> = {};
    for (const key of PHASE_KEYS) {
      const v = Number((t as any)[key] ?? (t as any)[`${key}_ms`]);
      if (Number.isFinite(v) && v >= 0 && v < 3_600_000) out[key] = Math.round(v);
    }
    if (Object.keys(out).length) return out;
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") {
      const found = extractPhases(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

export function createTimingCollector(scenarioStartedAt = Date.now()) {
  const attempts: TimedAttempt[] = [];
  return {
    async time<T>(meta: { target: "main" | "reference"; combo: string | null; attempt: number }, fn: () => Promise<T>, outcomeOf?: (r: T) => string | null): Promise<T> {
      const start = Date.now();
      try {
        const result = await fn();
        try {
          attempts.push({ ...meta, started_at: new Date(start).toISOString(), browser_ms: Date.now() - start,
            outcome: outcomeOf ? outcomeOf(result) : null, phases: extractPhases(result), script: extractScriptTiming(result) });
        } catch { /* timing must never fail a test */ }
        return result;
      } catch (error) {
        attempts.push({ ...meta, started_at: new Date(start).toISOString(), browser_ms: Date.now() - start, outcome: "error", phases: null });
        throw error;
      }
    },
    /** Snapshot for one saved result: attempts for this combo plus whole-matrix (null combo) calls. */
    snapshot(combo: string | null) {
      try {
        const own = attempts.filter((a) => a.combo === null || combo === null || a.combo === combo);
        return {
          scenario_started_at: new Date(scenarioStartedAt).toISOString(),
          saved_at: new Date().toISOString(),
          scenario_elapsed_ms: Date.now() - scenarioStartedAt,
          attempts: own.map((a) => ({ ...a })),
        };
      } catch {
        return null;
      }
    },
  };
}

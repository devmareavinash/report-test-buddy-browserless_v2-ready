export const PHASES = [
    { key: "login", label: "Login" },
    { key: "load", label: "Report load" },
    { key: "filters", label: "Apply filters" },
    { key: "data_ready", label: "Data load" },
    { key: "extract", label: "Read values" },
  ] as const;
  export type PhaseKey = (typeof PHASES)[number]["key"];
  
  export interface TimingAttempt {
    target: "main" | "reference";
    combo: string | null;
    attempt: number;
    started_at: string;
    browser_ms: number;
    outcome: string | null;
    phases: Partial<Record<PhaseKey, number>> | null;
    script?: { script_started_at: string; script_ms: number; segments: Array<{ phase: PhaseKey; start_ms: number; end_ms: number }> } | null;
  }
  
  export type ToolKey = "launch" | "return" | "queue";
  export type ReportKey = PhaseKey | "other" | "no_detail";
  
  export interface RunTiming {
    wall_ms: number;
    report_ms: number;
    tool_ms: number;
    tool_parts: Record<ToolKey, number>;
    report_parts: Record<ReportKey, number>;
    launch_attempts: number;
    retry_count: number;
    report_retry_wait_ms: number;
    phase_ms: Record<PhaseKey, number>;
    phase_detail: boolean;
    attempts: TimingAttempt[];
  }
  
  const attemptKey = (a: TimingAttempt) => `${a.target}|${a.combo ?? ""}|${a.attempt}|${a.started_at}`;
  
  /** Unique browser attempts across results (shared full-matrix calls appear on several rows). */
  export function collectAttempts(results: Array<{ actual?: any; expected?: any }>): TimingAttempt[] {
    const seen = new Map<string, TimingAttempt>();
    for (const r of results || []) {
      const list = [r?.actual?.timing?.attempts, r?.expected?.timing?.attempts].flatMap(x => Array.isArray(x) ? x : []);
      for (const a of list) {
        if (!a || !Number.isFinite(Number(a.browser_ms))) continue;
        const k = attemptKey(a);
        if (!seen.has(k)) seen.set(k, { ...a, browser_ms: Math.max(0, Number(a.browser_ms)) });
      }
    }
    return [...seen.values()].sort((a, b) => a.started_at.localeCompare(b.started_at));
  }
  
  /** Wall-clock interval union prevents counting parallel calls twice. */
  function union(intervals: Array<[number, number]>): Array<[number, number]> {
    const merged: Array<[number, number]> = [];
    for (const [start, end] of intervals.filter(([s, e]) => Number.isFinite(s) && e > s).sort((a, b) => a[0] - b[0])) {
      const prev = merged[merged.length - 1];
      if (prev && start <= prev[1]) prev[1] = Math.max(prev[1], end);
      else merged.push([start, end]);
    }
    return merged;
  }
  const duration = (xs: Array<[number, number]>) => union(xs).reduce((sum, [s, e]) => sum + e - s, 0);
  
  type Label = ReportKey | ToolKey;
  const PRIORITY: Label[] = [...PHASES.map(p => p.key), "other", "no_detail", "launch", "return"];
  
  /** Every instant of the run is assigned to exactly one Tool or Report KPI (report wins overlaps). */
  export function summarizeRunTiming(attempts: TimingAttempt[], wallMs: number, runStart?: number): RunTiming {
    const parsedStarts = attempts.map(a => Date.parse(a.started_at)).filter(Number.isFinite);
    const start = Number.isFinite(runStart) ? Number(runStart) : parsedStarts.length ? Math.min(...parsedStarts) : 0;
    const pieces: Array<[number, number, Label]> = [];
    const retryReport: Array<[number, number]> = [];
    let retry_count = 0, phase_detail = false, callMax = start;
    for (const a of attempts) {
      const parsed = Date.parse(a.started_at);
      if (!Number.isFinite(parsed)) continue;
      const callStart = Math.max(start, parsed), callEnd = parsed + Math.max(0, a.browser_ms);
      if (callEnd <= callStart) continue;
      callMax = Math.max(callMax, callEnd);
      const retry = a.attempt > 1;
      if (retry) retry_count++;
      const scriptStart = a.script ? Date.parse(a.script.script_started_at) : NaN;
      const scriptEnd = scriptStart + Number(a.script?.script_ms ?? NaN);
      if (a.script && Number.isFinite(scriptEnd) && scriptEnd >= scriptStart && scriptStart >= parsed && scriptEnd <= callEnd) {
        const ss = Math.max(callStart, scriptStart);
        pieces.push([callStart, ss, "launch"], [scriptEnd, callEnd, "return"], [ss, scriptEnd, "other"]);
        if (retry) retryReport.push([ss, scriptEnd]);
        for (const s of a.script.segments || []) {
          if (!PHASES.some(p => p.key === s.phase)) continue;
          const st = Math.max(ss, scriptStart + s.start_ms), en = Math.min(scriptEnd, scriptStart + s.end_ms);
          if (en > st) { pieces.push([st, en, s.phase]); phase_detail = true; }
        }
      } else {
        pieces.push([callStart, callEnd, "no_detail"]);
        if (retry) retryReport.push([callStart, callEnd]);
      }
    }
    const wall_ms = Math.max(0, wallMs, callMax - start);
    const end = start + wall_ms;
    const cuts = [...new Set([start, end, ...pieces.flatMap(([s, e]) => [s, e])])].filter(x => x >= start && x <= end).sort((x, y) => x - y);
    const parts: Record<Label, number> = Object.fromEntries([...PRIORITY, "queue"].map(k => [k, 0])) as any;
    for (let k = 0; k < cuts.length - 1; k++) {
      const s = cuts[k], e = cuts[k + 1], mid = (s + e) / 2;
      const covering = new Set(pieces.filter(([ps, pe]) => ps <= mid && mid < pe).map(p => p[2]));
      const label = PRIORITY.find(l => covering.has(l)) ?? "queue";
      parts[label] += e - s;
    }
    const report_parts = Object.fromEntries([...PHASES.map(p => p.key), "other", "no_detail"].map(k => [k, parts[k as Label]])) as Record<ReportKey, number>;
    const tool_parts = { launch: parts.launch, return: parts.return, queue: parts.queue };
    const report_ms = Object.values(report_parts).reduce((x, y) => x + y, 0);
    const tool_ms = tool_parts.launch + tool_parts.return + tool_parts.queue;
    const phase_ms = Object.fromEntries(PHASES.map(p => [p.key, report_parts[p.key]])) as Record<PhaseKey, number>;
    return { wall_ms, report_ms, tool_ms, tool_parts, report_parts, launch_attempts: attempts.length, retry_count,
      report_retry_wait_ms: Math.min(report_ms, duration(retryReport)), phase_ms, phase_detail, attempts };
  }
  
  export function formatMs(ms: number): string {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
  }

  /** Longer labels for the summary strip, e.g. "30 min 20 sec". */
  export function formatMsLong(ms: number): string {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} sec`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} min ${s % 60} sec`;
    const h = Math.floor(m / 60);
    return `${h} hr ${m % 60} min ${s % 60} sec`;
  }
  
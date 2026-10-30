/** Frontend copy of script-agent proposal helpers (Vite ignores watching supabase/**). */

export type ScriptProposal = { code: string; explanation: string; baseCode: string };
export type ScriptChatTarget = "main" | "reference";

export type ConversationStore = {
  v: 2;
  threads: { main: unknown[]; reference: unknown[] };
};

export function canApplyScriptProposal(proposal: ScriptProposal, currentCode: string) {
  return proposal.baseCode === currentCode;
}

export function parseConversationStore(raw: unknown): { main: unknown[]; reference: unknown[] } {
  if (Array.isArray(raw)) return { main: raw, reference: [] };
  if (raw && typeof raw === "object") {
    const threads = (raw as { threads?: { main?: unknown; reference?: unknown } }).threads;
    if (threads && typeof threads === "object") {
      return {
        main: Array.isArray(threads.main) ? threads.main : [],
        reference: Array.isArray(threads.reference) ? threads.reference : [],
      };
    }
  }
  return { main: [], reference: [] };
}

export function writeConversationStore(
  previous: unknown,
  target: ScriptChatTarget,
  messages: unknown[],
): ConversationStore {
  const parsed = parseConversationStore(previous);
  return {
    v: 2,
    threads: {
      main: target === "main" ? messages : parsed.main,
      reference: target === "reference" ? messages : parsed.reference,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Flatten playwright-runtime shapes: extracted / result / results.combo_* */
function collectRunPayloads(runResult: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  const push = (value: unknown) => {
    const row = asRecord(value);
    if (!row || seen.has(row)) return;
    seen.add(row);
    out.push(row);
    const extracted = asRecord(row.extracted);
    if (extracted) push(extracted);
    const result = asRecord(row.result);
    if (result) push(result);
    const results = asRecord(row.results);
    if (results) {
      for (const [label, block] of Object.entries(results).slice(0, 6)) {
        const child = asRecord(block);
        if (child) {
          out.push({ __combo: label, ...child });
        }
      }
    }
  };
  push(runResult);
  return out;
}

function summarizeFiltersApplied(filters: unknown): string[] {
  const row = asRecord(filters);
  if (!row) return [];
  const lines: string[] = [];
  const failed: string[] = [];
  const okish: string[] = [];
  for (const [k, v] of Object.entries(row).slice(0, 16)) {
    const detail = asRecord(v);
    if (!detail) {
      okish.push(`${k}=${JSON.stringify(v).slice(0, 80)}`);
      continue;
    }
    if (detail.ok === false || detail.error) {
      failed.push(`${k}: ${JSON.stringify(detail).slice(0, 220)}`);
    } else {
      const via = detail.via || detail.verified || detail.option || detail.text;
      okish.push(`${k}: ok via=${String(via ?? "unknown").slice(0, 80)}`);
    }
  }
  if (failed.length) lines.push(`failed_filters:\n${failed.join("\n")}`);
  if (okish.length) lines.push(`filters_applied_summary:\n${okish.join("\n")}`);
  return lines;
}

function summarizeMissingKpis(payload: Record<string, unknown>): string[] {
  const missing: string[] = [];
  for (const [k, v] of Object.entries(payload)) {
    if (/^(ok|error|url|title|navigation|filters_applied|extract_debug|screenshot|__)/i.test(k)) continue;
    if (/_debug$|_navigation$|_filters$|_show_data$|_grid_ready$/i.test(k)) continue;
    if (v == null || v === "") missing.push(k);
  }
  return missing.slice(0, 12);
}

/** Build chat context from runError and/or last run JSON (including ok:true with empty KPIs / bad filters). */
export function summarizeRunFailureForChat(
  runError: string | null | undefined,
  runResult: unknown,
  maxChars = 5_000,
  expectedFilters?: Record<string, string> | null,
): string | null {
  const parts: string[] = [];
  const err = String(runError || "").trim();
  if (err) parts.push(err);

  if (expectedFilters && Object.keys(expectedFilters).length) {
    parts.push(
      `expected_filter_combo:\n${
        Object.entries(expectedFilters).map(([k, v]) => `  ${k}=${v}`).join("\n")
      }`,
    );
  }

  const payloads = collectRunPayloads(runResult);

  for (const root of payloads.slice(0, 4)) {
    const combo = root.__combo ? `combo=${String(root.__combo)} ` : "";
    if (root.error) parts.push(`${combo}error: ${String(root.error)}`);
    if (root.failed_on) parts.push(`${combo}failed_on: ${String(root.failed_on)}`);
    if (root.filter_error) {
      try {
        parts.push(`${combo}filter_error: ${JSON.stringify(root.filter_error).slice(0, 500)}`);
      } catch { /* ignore */ }
    }
    if (root.extract_debug) {
      try {
        parts.push(`${combo}extract_debug: ${JSON.stringify(root.extract_debug).slice(0, 1_000)}`);
      } catch { /* ignore */ }
    }
    parts.push(...summarizeFiltersApplied(root.filters_applied).map((line) => `${combo}${line}`));

    const debugKeys = Object.keys(root).filter((k) =>
      /_debug$|_navigation$|_filters$|_show_data$|_grid_ready$/i.test(k)
    );
    for (const key of debugKeys.slice(0, 8)) {
      try {
        const blob = JSON.stringify(root[key]);
        if (blob && blob !== "{}" && blob !== "null") parts.push(`${combo}${key}: ${blob.slice(0, 500)}`);
      } catch { /* ignore */ }
    }

    const missing = summarizeMissingKpis(root);
    if (missing.length) {
      parts.push(
        `${combo}missing_or_null_kpis: ${missing.join(", ")} — treat as extraction failure even if ok:true`,
      );
    }
    if (root.ok === false) parts.push(`${combo}run.ok=false`);
    if (root.ok === true && missing.length) {
      parts.push(`${combo}WARNING: ok:true with null KPIs — do not trust ok; fix nav/filters/extract`);
    }
  }

  const text = parts.join("\n").trim();
  if (!text) return null;
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

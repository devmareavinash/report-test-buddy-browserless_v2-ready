export type ScriptProposal = { code: string; explanation: string; baseCode: string };

export type ScriptChatTarget = "main" | "reference";

/** Persist main + reference Agent chat threads in one `messages` JSON column (no DB migration). */
export type ConversationStore = {
  v: 2;
  threads: { main: unknown[]; reference: unknown[] };
};

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

export function buildScriptProposal(code: string, explanation: string, baseCode: string): ScriptProposal {
  if (!code.trim()) throw new Error("The proposed script is empty.");
  if (code.trim() === baseCode.trim()) throw new Error("The proposed script has no changes.");
  return { code, explanation, baseCode };
}

export function canApplyScriptProposal(proposal: ScriptProposal, currentCode: string) {
  return proposal.baseCode === currentCode;
}

function countExact(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

/** Prefer exact match; fall back to CRLF/LF normalization only. */
function resolveUniqueSpan(code: string, original: string): { start: number; end: number } {
  const exact = countExact(code, original);
  if (exact === 1) {
    const start = code.indexOf(original);
    return { start, end: start + original.length };
  }
  if (exact > 1) {
    throw new Error(
      `Edit matched ${exact} places (need exactly 1). Use a longer, more unique original string copied from the script excerpt.`,
    );
  }

  const variants = [
    original.replace(/\r\n/g, "\n"),
    original.replace(/\n/g, "\r\n"),
    original.trim(),
  ].filter((v, i, arr) => v && v !== original && arr.indexOf(v) === i);

  for (const variant of variants) {
    const n = countExact(code, variant);
    if (n === 1) {
      const start = code.indexOf(variant);
      return { start, end: start + variant.length };
    }
    if (n > 1) {
      throw new Error(
        `Edit matched ${n} places after whitespace normalization (need exactly 1). Use a longer unique original string.`,
      );
    }
  }

  const preview = original.length > 120 ? `${original.slice(0, 120)}…` : original;
  throw new Error(
    `Edit matched 0 places in the live editor script. Copy original text EXACTLY from the provided script excerpt (not invented). Failed original starts with: ${JSON.stringify(preview)}`,
  );
}

function readApplyOrderKeys(code: string): string[] {
  const match = code.match(/GEO_ORDER\s*=\s*\[([^\]]*)\]/);
  if (!match) return [];
  return Array.from(match[1].matchAll(/['"]([^'"]+)['"]/g)).map((m) => m[1]);
}

function filterKeyStillReferenced(code: string, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`['"]${escaped}['"]\\s*:`).test(code)
    || new RegExp(`filters\\[['"]${escaped}['"]\\]`).test(code);
}

/** Structural guards only — not scenario-specific. */
function assertExtractionSafeEdits(
  baseCode: string,
  nextCode: string,
  edits: Array<{ original: string; replacement: string }>,
) {
  for (const edit of edits) {
    const inventsCore =
      /@@RTB_FILTER_CORE|applyFiltersVerified|__rtbCheckErrorDialog|__rtbReadFilter/.test(edit.replacement)
      && !/@@RTB_FILTER_CORE|applyFiltersVerified|__rtbCheckErrorDialog|__rtbReadFilter/.test(edit.original);
    if (inventsCore) {
      throw new Error(
        "Rejected edit: do not inject a new filter-core block. Patch the helpers already present in this script.",
      );
    }
  }

  // Past Agent-chat failures: "softening" filter errors so Team/Brand look fine while
  // Area/Territory/Time Bucket stay on dossier defaults — then extract still runs.
  const softensFailures =
    (/label_not_found|verification failed,\s*continuing|skipped:\s*true,\s*reason:\s*['"]label_not_found['"]/i.test(nextCode)
      && !/label_not_found|verification failed,\s*continuing/i.test(baseCode))
    || (/Filter .* not found on page, skipping/i.test(nextCode)
      && !/Filter .* not found on page, skipping/i.test(baseCode));
  if (softensFailures) {
    throw new Error(
      "Rejected edit: do not skip Label not found or continue after FILTER_NOT_APPLIED. Abort scrape on the first failed filter and fix selectByLabel so the chip actually changes.",
    );
  }

  const hadStrictAbort = /if\s*\(\s*!applied\s*\|\|\s*applied\.ok\s*===\s*false\s*\)/.test(baseCode)
    && /filterFailed/.test(baseCode)
    && /break\s*;/.test(baseCode);
  const stillStrictAbort = /if\s*\(\s*!applied\s*\|\|\s*applied\.ok\s*===\s*false\s*\)/.test(nextCode)
    && /filterFailed/.test(nextCode);
  if (hadStrictAbort && !stillStrictAbort) {
    throw new Error(
      "Rejected edit: do not remove the strict scrapeOnce abort (if (!applied || applied.ok === false) break). Failed filters must stop the run.",
    );
  }

  const before = readApplyOrderKeys(baseCode);
  const after = readApplyOrderKeys(nextCode);
  if (before.length && after.length) {
    const stillNeeded = before.filter((k) => !after.includes(k) && filterKeyStillReferenced(baseCode, k));
    if (stillNeeded.length) {
      throw new Error(
        `Rejected edit: do not remove ${stillNeeded.join(", ")} from GEO_ORDER while this script still applies those filter keys. Fix apply/verify instead of skipping keys.`,
      );
    }
  }
}

export function applyScriptEdits(
  baseCode: string,
  edits: Array<{ original: string; replacement: string }>,
  explanation: string,
) {
  let code = baseCode;
  for (const edit of edits) {
    if (!edit.original) {
      throw new Error("Each correction needs a non-empty original string.");
    }
    const span = resolveUniqueSpan(code, edit.original);
    code = `${code.slice(0, span.start)}${edit.replacement}${code.slice(span.end)}`;
  }
  assertExtractionSafeEdits(baseCode, code, edits);
  return buildScriptProposal(code, explanation, baseCode);
}

/**
 * Return one top-level helper from the live script (full body when possible).
 * External chatbots "fix filters" by rewriting selectByLabel — this gives Magentic
 * the same exact source without dumping the whole 60k file into the system prompt.
 */
export function getScriptHelper(
  code: string,
  helperName: string,
  maxChars = 20_000,
): { helper: string; found: boolean; start: number; end: number; truncated: boolean; message?: string } {
  const name = String(helperName || "").trim();
  const original = code || "";
  if (!name || name.length < 2) {
    return { helper: "", found: false, start: -1, end: -1, truncated: false, message: "helper name required" };
  }

  const patterns = [
    new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`, "m"),
    new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*async\\s*\\(`, "m"),
    new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*async\\s+function\\s*\\(`, "m"),
    new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*function\\s*\\(`, "m"),
    new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*\\(`, "m"),
  ];

  let start = -1;
  for (const re of patterns) {
    const m = re.exec(original);
    if (m) {
      start = m.index;
      break;
    }
  }
  if (start < 0) {
    return {
      helper: "",
      found: false,
      start: -1,
      end: -1,
      truncated: false,
      message: `Helper "${name}" not found. Try lookupScript with a short unique query.`,
    };
  }

  const braceAt = original.indexOf("{", start);
  if (braceAt < 0) {
    return { helper: "", found: false, start, end: -1, truncated: false, message: "No function body `{` after helper name." };
  }

  let depth = 0;
  let end = -1;
  for (let i = braceAt; i < original.length; i++) {
    const ch = original[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        // Include trailing semicolon for const foo = async () => { ... };
        if (original[end] === ";") end++;
        break;
      }
    }
  }
  if (end < 0) {
    return {
      helper: original.slice(start, Math.min(original.length, start + maxChars)),
      found: true,
      start,
      end: -1,
      truncated: true,
      message: "Unbalanced braces; returning a truncated slice.",
    };
  }

  const block = original.slice(start, end);
  if (block.length <= maxChars) {
    return { helper: block, found: true, start, end, truncated: false };
  }
  return {
    helper: block.slice(0, maxChars),
    found: true,
    start,
    end,
    truncated: true,
    message: `Helper is ${block.length} chars; returned first ${maxChars}. Use lookupScript for the remainder.`,
  };
}

/** Let the chat agent fetch exact live-script snippets before proposeScript (cuts hallucinated originals). */
export function lookupScriptSnippets(
  code: string,
  query: string,
  maxHits = 3,
  windowChars = 1_200,
): { query: string; hits: Array<{ index: number; snippet: string }> } {
  const q = String(query || "").trim();
  const original = code || "";
  if (!q || q.length < 2) {
    return { query: q, hits: [] };
  }
  // Filter helpers need a wide window so proposeScript can replace the real picker body.
  const wide = /selectByLabel|pickInFrame|scrapeOnce|GEO_ORDER|filters_applied|FILTER_NOT_APPLIED/i.test(q);
  const win = wide ? Math.max(windowChars, 4_500) : windowChars;
  const hits: Array<{ index: number; snippet: string }> = [];
  let from = 0;
  while (hits.length < maxHits) {
    const idx = original.indexOf(q, from);
    if (idx < 0) break;
    const start = Math.max(0, idx - Math.floor(win * 0.2));
    const end = Math.min(original.length, idx + q.length + Math.floor(win * 0.8));
    hits.push({
      index: idx,
      snippet: original.slice(start, end),
    });
    from = idx + Math.max(1, q.length);
  }
  if (!hits.length) {
    // Case-insensitive fallback — still return exact source bytes from the live script.
    const lower = original.toLowerCase();
    const qLower = q.toLowerCase();
    from = 0;
    while (hits.length < maxHits) {
      const idx = lower.indexOf(qLower, from);
      if (idx < 0) break;
      const start = Math.max(0, idx - Math.floor(win * 0.2));
      const end = Math.min(original.length, idx + q.length + Math.floor(win * 0.8));
      hits.push({
        index: idx,
        snippet: original.slice(start, end),
      });
      from = idx + Math.max(1, q.length);
    }
  }
  return { query: q, hits };
}

const PINNED_EXCERPT_HINTS = [
  "SUB_TABS",
  "NAV_STEPS",
  "clickByText",
  "scrapeOnce",
  "selectByLabel",
  "GEO_ORDER",
  "waitForTargetGridStable",
  "openShowData",
  "extractShowDataRowCount",
  "applyFiltersVerified",
];

/** Head + tail + keyword windows so proposeScript can copy exact strings without sending the full ~60k script. */
export function excerptScriptForChat(
  code: string,
  hints: string[] = [],
  maxChars = 12_000,
): { text: string; truncated: boolean; original_bytes: number } {
  const original = code || "";
  if (original.length <= maxChars) {
    return { text: original, truncated: false, original_bytes: original.length };
  }

  type Win = { start: number; end: number; label: string };
  const windows: Win[] = [];
  const headLen = Math.floor(maxChars * 0.22);
  const tailLen = Math.floor(maxChars * 0.22);
  windows.push({ start: 0, end: headLen, label: "head" });
  windows.push({
    start: Math.max(0, original.length - tailLen),
    end: original.length,
    label: "tail",
  });

  const cleanedHints = [...PINNED_EXCERPT_HINTS, ...hints]
    .map((h) => String(h || "").trim())
    .filter((h) => h.length >= 4)
    .filter((h, i, arr) => arr.findIndex((x) => x.toLowerCase() === h.toLowerCase()) === i)
    .slice(0, 20);

  for (const hint of cleanedHints) {
    let from = 0;
    let hits = 0;
    const wideHint = /selectByLabel|scrapeOnce|GEO_ORDER|applyFiltersVerified/i.test(hint);
    const before = wideHint ? 200 : 700;
    const after = wideHint ? 3_500 : 1_400;
    while (hits < 2) {
      const idx = original.indexOf(hint, from);
      if (idx < 0) break;
      windows.push({
        start: Math.max(0, idx - before),
        end: Math.min(original.length, idx + hint.length + after),
        label: `match:${hint.slice(0, 40)}`,
      });
      from = idx + Math.max(1, hint.length);
      hits++;
    }
  }

  windows.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Win[] = [];
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (!last || w.start > last.end + 80) merged.push({ ...w });
    else {
      last.end = Math.max(last.end, w.end);
      if (!last.label.includes(w.label)) last.label = `${last.label}+${w.label}`;
    }
  }

  let used = 0;
  const chunks: string[] = [];
  for (const w of merged) {
    const slice = original.slice(w.start, w.end);
    if (used + slice.length > maxChars) {
      const remain = maxChars - used;
      if (remain > 400) {
        chunks.push(
          `/* … lines ~${w.start}-${w.start + remain} (${w.label}, truncated) … */\n${original.slice(w.start, w.start + remain)}`,
        );
      }
      break;
    }
    const gapNote = chunks.length
      ? `\n\n/* … omitted ${w.start - (merged[chunks.length - 1]?.end ?? 0)} chars … */\n\n`
      : "";
    chunks.push(`${gapNote}/* … lines ~${w.start}-${w.end} (${w.label}) … */\n${slice}`);
    used += slice.length + gapNote.length;
  }

  return {
    text: chunks.join(""),
    truncated: true,
    original_bytes: original.length,
  };
}

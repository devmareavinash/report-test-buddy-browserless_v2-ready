/**
 * Description-driven MSTR nav / widget-title parsing.
 * Never invent Performance vs Activity screens — only use what the scenario text says.
 */

export function scenarioTextBlob(scenario: any): string {
  return `${scenario?.reports?.name || ""}\n${scenario?.title || ""}\n${scenario?.description || ""}`;
}

function cleanStep(raw: string): string {
  return String(raw || "")
    .replace(/^(on|of)\s+(the\s+)?/i, "")
    .replace(/^(the|a|an)\s+/i, "")
    .replace(/\s+sub$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isJunkNavStep(step: string, opts: { allowGeography?: boolean } = {}): boolean {
  if (!step || step.length < 2) return true;
  if (/^(weekly|monthly|quarterly|quaterly|toggle)$/i.test(step)) return true;
  if (/^(screen|page|dashboard|tab|sub|dossier|report|trend|main)$/i.test(step)) return true; // lone "Trend"/"Main" are not tab labels
  if (/^(to|of|on|vs|after|before|compare)$/i.test(step)) return true;
  // A footer/sub-tab caption never starts with a stop-word nor contains " of ".
  // "tab of Performance" (screenRe over "... Trend tab of Performance screen") is not a tab.
  if (/^(tab|sub|screen|page|dashboard|report|of|on|in|to|for|from|and|the|a|an)\b/i.test(step)) return true;
  if (/\s(?:of|on|in|for|from)\s/i.test(step)) return true;
  if (/^vs\b/i.test(step)) return true;
  if (/\b(after|before|navigat|main report)\b/i.test(step)) return true;
  if (/toggle/i.test(step)) return true;
  if (/\b(go to|navigate|switch to|then open|open the)\b/i.test(step)) return true;
  // Widget titles are not footer tabs ("Activity Trend Graph", "… Chart").
  if (/\b(graph|chart|plot|grid)\b/i.test(step) && !/geography/i.test(step)) return true;
  if (/\bgrid\b/i.test(step) && !/geography/i.test(step)) return true;
  if (!opts.allowGeography && /^geography$/i.test(step)) return true;
  if (step.split(/\s+/).length > 4) return true;
  return false;
}

/**
 * Extract footer/left-nav click labels from scenario description (preferred),
 * then title, then report name "A - B" as last resort.
 */
export function parseNavStepsFromScenario(
  scenario: any,
  opts: { allowGeography?: boolean } = {},
): string[] {
  const blob = scenarioTextBlob(scenario);
  const reportName = String(scenario?.reports?.name || "");

  // Report "Performance - Activity" → click Performance, then Activity (authoritative order).
  // Do not invent a joined "Performance Activity" label.
  const reportParts = /\bvs\b/i.test(reportName)
    ? []
    : reportName
      .split(/\s*[-–—]\s*/)
      .map((p) => cleanStep(p))
      .filter((p) => p && !/^(graph|chart|grid|kpi|overview|summary)$/i.test(p) && !isJunkNavStep(p, opts));
  if (reportParts.length >= 2) {
    const deduped = reportParts.filter((p, i) => i === 0 || p.toLowerCase() !== reportParts[i - 1].toLowerCase());
    if (deduped.length >= 2) return deduped;
    if (deduped.length === 1) return deduped;
  }

  const steps: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const step = cleanStep(raw);
    // "Performance - Activity" / "A – B" are separate footer/page clicks, not one label.
    if (/\s[-–—]\s/.test(step) || /[-–—]/.test(step)) {
      const parts = step
        .split(/\s*[-–—]\s*/)
        .map((p) => p.trim())
        .filter(Boolean);
      if (parts.length >= 2) {
        for (const p of parts) add(p);
        return;
      }
    }
    if (isJunkNavStep(step, opts)) return;
    const key = step.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    steps.push(step);
  };

  // 1) "navigate/go/open/switch to the X screen|tab|…"
  const navRe =
    /(?:go to|open|navigate to|switch to)\s+(?:the\s+)?([A-Za-z][A-Za-z0-9 /&-]{1,40}?)\s+(?:sub[-\s]?tab|tab|screen|page|dashboard)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = navRe.exec(blob))) add(m[1]);

  // 2) Explicit sub-tab label: "Activity sub-tab" (last 1–2 words only — not "after navigating to Activity")
  const subRe =
    /(?:\bthe\s+)?([A-Za-z][A-Za-z0-9]*(?:\s+[A-Za-z][A-Za-z0-9]*)?)\s+sub[-\s]?tab\b/gi;
  while ((m = subRe.exec(blob))) add(m[1]);

  // 3) "… Performance screen" / "Activity Screen" — skip "Overview screen (main URL)" compare wording
  const screenRe =
    /(?:\b(?:of|on)\s+)?(?:\bthe\s+)?(\b(?!(?:tab|sub|screen|page|of|on|in|to|for|from|and|the)\b)[A-Za-z][A-Za-z0-9]*(?:\s+[A-Za-z][A-Za-z0-9]*){0,2})\s+(?:screen|page)\b/gi;
  while ((m = screenRe.exec(blob))) {
    const after = blob.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 28);
    if (/\(\s*(main|reference)\s+url/i.test(after)) continue;
    if (/^vs\b/i.test(String(m[1] || ""))) continue;
    add(m[1]);
  }

  // 4) "… the Performance tab" but not "… sub tab" (handled above)
  const tabRe =
    /(?:\bthe\s+)?(\b(?!(?:tab|sub|screen|page|of|on|in|to|for|from|and|the)\b)[A-Za-z][A-Za-z0-9 /&-]{1,40}?)\s+tab\b/gi;
  while ((m = tabRe.exec(blob))) {
    const full = m[0] || "";
    if (/\bsub[-\s]?tab\b/i.test(full)) continue;
    if (/\bsub\s+tab\b/i.test(blob.slice(Math.max(0, (m.index ?? 0) - 4), (m.index ?? 0) + full.length))) {
      continue;
    }
    const idx = m.index ?? 0;
    if (/\bsub\s+$/i.test(blob.slice(Math.max(0, idx - 4), idx))) continue;
    add(m[1]);
  }

  // 5) "… on the Performance - Activity report" (common reference_match wording)
  const reportPhraseRe =
    /(?:\bon\s+)?(?:\bthe\s+)?([A-Za-z][A-Za-z0-9 /&-]{1,50}?)\s+report\b/gi;
  while ((m = reportPhraseRe.exec(blob))) {
    add(m[1]);
  }

  // 6) Single-segment report name as a nav hint when description yielded nothing.
  if (!steps.length && reportParts.length === 1) add(reportParts[0]);

  // Click order: parent screen before sub-view when one label contains the other
  // e.g. Performance → Performance Trend (not hardcoded to those names).
  const ordered = [...steps];
  ordered.sort((a, b) => {
    const al = a.toLowerCase();
    const bl = b.toLowerCase();
    if (bl.includes(al) && al.length < bl.length) return -1;
    if (al.includes(bl) && bl.length < al.length) return 1;
    return 0;
  });
  return ordered;
}

function normalizeVizTitle(t: string): string {
  const s = String(t || "").replace(/\s+/g, " ").trim();
  if (/^performance\s+trends$/i.test(s)) return "Performance Trend";
  return s;
}

/** Widget / chart title from description + scenario title — never invent a default screen widget. */
export function parseVizTitleFromScenario(
  scenario: any,
  kind: "chart" | "grid",
): string {
  const blob = scenarioTextBlob(scenario);
  const desc = String(scenario?.description || "");
  const title = String(scenario?.title || "");
  const noun = kind === "grid" ? "grid" : "(?:graph|chart|plot)";

  // Accept ASCII ", curly “”, and single-quoted 'Activity Trend' from UI copy.
  const fromDesc = [
    new RegExp(`capture\\s+(?:the\\s+)?["“‘']?([A-Za-z][A-Za-z0-9 &/-]{2,60})["”’']?\\s+${noun}`, "i"),
    new RegExp(`(?:compare|displayed on)\\s+(?:the\\s+)?["“‘']?([A-Za-z][A-Za-z0-9 &/-]{2,60})["”’']?\\s+${noun}`, "i"),
    new RegExp(`(?:from|for)\\s+(?:the\\s+)?["“‘']?([A-Za-z][A-Za-z0-9 &/-]{2,60})["”’']?\\s+${noun}`, "i"),
    new RegExp(`(?:that\\s+)?(?:the\\s+)?["“‘']([A-Za-z][A-Za-z0-9 &/-]{2,60})["”’']\\s+${noun}`, "i"),
    new RegExp(`${noun}\\s+(?:titled|called|named|labeled)\\s*["“‘']([^"”’']{3,80})["”’']`, "i"),
    new RegExp(`["“‘']([^"”’']{3,80})["”’']\\s+${noun}`, "i"),
  ];
  for (const re of fromDesc) {
    const m = (desc || blob).match(re);
    if (m?.[1] && !/\b(reference|prod|pre-?prod|match)\b/i.test(m[1]) && m[1].trim().length >= 4) {
      return normalizeVizTitle(m[1]);
    }
  }

  const titleNoun = kind === "grid" ? "Grid" : "(?:Graph|Chart|Plot)";
  const fromTitle = title.match(new RegExp(`^([\\w][\\w\\s&/-]{2,60}?)\\s+${titleNoun}\\b`, "i"));
  if (
    fromTitle?.[1] &&
    !/\b(reference|prod|pre-?prod|match)\b/i.test(fromTitle[1]) &&
    fromTitle[1].trim().length >= 8
  ) {
    return normalizeVizTitle(fromTitle[1]);
  }

  // Named widgets only when the phrase appears in scenario text.
  if (kind === "chart") {
    if (/\bactivity\s+trend\b/i.test(blob)) return "Activity Trend";
    if (/\bsegment\s+summary\b/i.test(blob)) return "Segment Summary";
    if (/\boverall\s+performance\b/i.test(blob)) return "Overall Performance";
  } else {
    if (/geography\s+details/i.test(blob)) return "Geography Details";
    if (/performance[\s\-–—]*trends?\b/i.test(blob) || /\btrends?\s+grid\b/i.test(blob)) {
      return "Performance Trend";
    }
  }

  const quoted = blob.match(/["“‘']([^"”’']{3,80})["”’']/);
  if (quoted?.[1] && !/\b(reference|prod|pre-?prod)\b/i.test(quoted[1])) {
    return normalizeVizTitle(quoted[1]);
  }
  return "";
}

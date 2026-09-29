import { normalizeReportUrl } from "./mstr-overview-template.ts";

async function loadRecordCountReference(): Promise<string> {
  const url = new URL("./references/browserless-record-count.js", import.meta.url);
  return await Deno.readTextFile(url);
}

export function sanitizeRecordCountNavSteps(
  navSteps: string[],
  subTabs: string[],
): string[] {
  const subTabKeys = new Set(
    (subTabs || []).map((s) => String(s || "").trim().toLowerCase()).filter(Boolean),
  );
  const junkNav =
    /^(?:please\s+)?(?:visit|navigate|open|go|switch)(?:\s+(?:to|each|all|the|every|these|those))*$/i;
  const junkPhrase =
    /^(?:visit|navigate|open|go|switch)\s+(?:each|all|every|the)\b/i;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of navSteps || []) {
    let s = String(raw || "").replace(/\s+/g, " ").trim();
    // Parsers can capture the preposition from "navigate to HCP Customer".
    s = s.replace(/^(?:to|on|of)\s+(?:the\s+)?/i, "").trim();
    if (
      !s
      || junkNav.test(s)
      || junkPhrase.test(s)
      || /^(screen|page|dashboard|tab|sub[-\s]?tab)$/i.test(s)
      || subTabKeys.has(s.toLowerCase())
    ) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/**
 * Assemble the confirmed record-count flow:
 * login -> parent navigation -> filters -> sub-tab -> stable grid ->
 * Show Data -> top "Rows: N" value.
 */
export async function assembleRecordCountScript(opts: {
  reportUrl: string;
  navSteps: string[];
  subTabs: string[];
  kpiPrefix?: string;
}): Promise<string> {
  let src = await loadRecordCountReference();
  const reportUrl = normalizeReportUrl(opts.reportUrl);
  const subTabs = (opts.subTabs || [])
    .map((s) => String(s || "").trim())
    .filter(Boolean);
  // A description can identify the quoted sub-tab as a nav step as well. Visit it
  // only after filters are applied, so parent navigation excludes those duplicates.
  const navSteps = sanitizeRecordCountNavSteps(opts.navSteps || [], subTabs);
  const kpiPrefix = String(opts.kpiPrefix || "Row Count").trim() || "Row Count";

  src = src.replace(
    'const __reportUrl = "";',
    `const __reportUrl = ${JSON.stringify(reportUrl)};`,
  );
  src = src.replace(
    'const reportUrl = "";',
    `const reportUrl = ${JSON.stringify(reportUrl)};`,
  );
  src = src.replace(
    "const NAV_STEPS = [];",
    `const NAV_STEPS = ${JSON.stringify(navSteps)};`,
  );
  src = src.replace(
    "const SUB_TABS = [];",
    `const SUB_TABS = ${JSON.stringify(subTabs)};`,
  );
  src = src.replace(
    "const KPI_PREFIX = 'Row Count';",
    `const KPI_PREFIX = ${JSON.stringify(kpiPrefix)};`,
  );
  return src;
}

// Reuse live-scraped KPI values from test_results so orchestrate can skip
// playwright-runtime for one side (Main or Reference). No snapshot table.

export const SCRAPE_REUSE_MAX_AGE_MS = 9 * 24 * 60 * 60 * 1000;

export type ScrapeMode = "live" | "reused";

export type ScrapeProvenance = {
  mode: ScrapeMode;
  scraped_at: string;
  report_url: string;
  credential_profile_id: string | null;
  source_test_result_id: string | null;
};

export function normalizeScenarioTitle(title: string): string {
  return String(title || "")
    .trim()
    .toLowerCase()
    .replace(/\(copy\)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function scenariosPairMatch(
  a: { pair_key?: string | null; title?: string | null },
  b: { pair_key?: string | null; title?: string | null },
): boolean {
  if (a.pair_key && b.pair_key && a.pair_key === b.pair_key) return true;
  const ta = normalizeScenarioTitle(String(a.title || ""));
  const tb = normalizeScenarioTitle(String(b.title || ""));
  return Boolean(ta && tb && ta === tb);
}

/** Stable hash of filter combo for donor matching. */
export function filterComboKey(label: string, filters: Record<string, unknown> | null | undefined): string {
  const normLabel = String(label || "").trim().toLowerCase();
  const entries = Object.entries(filters || {})
    .map(([k, v]) => [String(k).trim().toLowerCase(), v == null ? "" : String(v).trim()] as const)
    .sort((x, y) => x[0].localeCompare(y[0]));
  return `${normLabel}|${JSON.stringify(Object.fromEntries(entries))}`;
}

function isEmptyValue(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string" && !v.trim()) return true;
  if (typeof v === "object") {
    if (Array.isArray(v)) return v.length === 0;
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.columns) && Array.isArray(o.rows)) return o.rows.length === 0;
    return Object.keys(o).length === 0;
  }
  return false;
}

export function kpiKeysCompatible(
  storedValues: Record<string, unknown> | null | undefined,
  neededLabels: string[],
): boolean {
  if (!storedValues || typeof storedValues !== "object") return false;
  const keys = Object.keys(storedValues);
  if (!keys.length) return false;
  if (!neededLabels.length) {
    return keys.some((k) => !isEmptyValue(storedValues[k]));
  }
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const byNorm = new Map(keys.map((k) => [norm(k), k]));
  for (const label of neededLabels) {
    const key = byNorm.get(norm(label));
    if (!key || isEmptyValue(storedValues[key])) return false;
  }
  return true;
}

export function readScrapeTag(side: unknown): ScrapeProvenance | null {
  if (!side || typeof side !== "object") return null;
  const scrape = (side as Record<string, unknown>).scrape;
  if (!scrape || typeof scrape !== "object") return null;
  const s = scrape as Record<string, unknown>;
  if (s.mode !== "live" && s.mode !== "reused") return null;
  return {
    mode: s.mode,
    scraped_at: String(s.scraped_at || ""),
    report_url: String(s.report_url || ""),
    credential_profile_id: s.credential_profile_id == null ? null : String(s.credential_profile_id),
    source_test_result_id: s.source_test_result_id == null ? null : String(s.source_test_result_id),
  };
}

export function buildScrapeTag(opts: {
  mode: ScrapeMode;
  reportUrl: string;
  credentialProfileId?: string | null;
  sourceTestResultId?: string | null;
  scrapedAt?: string;
}): ScrapeProvenance {
  return {
    mode: opts.mode,
    scraped_at: opts.scrapedAt || new Date().toISOString(),
    report_url: opts.reportUrl || "",
    credential_profile_id: opts.credentialProfileId ?? null,
    source_test_result_id: opts.mode === "live" ? null : (opts.sourceTestResultId ?? null),
  };
}

export function isFreshScrapedAt(scrapedAt: string, nowMs = Date.now(), maxAgeMs = SCRAPE_REUSE_MAX_AGE_MS): boolean {
  const t = Date.parse(scrapedAt);
  if (!Number.isFinite(t)) return false;
  const age = nowMs - t;
  return age >= 0 && age <= maxAgeMs;
}

export type DonorSide = "main" | "reference";

/** Values live in actual for main donors, expected for reference donors. */
export function extractDonorValues(
  row: { actual?: any; expected?: any; id?: string; created_at?: string },
  side: DonorSide,
  reportUrl: string,
  credentialProfileId: string | null,
  neededLabels: string[],
  comboLabel: string,
): { values: Record<string, unknown>; provenance: ScrapeProvenance; testResultId: string } | null {
  const blob = side === "main" ? row.actual : row.expected;
  if (!blob || typeof blob !== "object") return null;
  const tag = readScrapeTag(blob);
  // Legacy rows (no scrape tag): treat as live only if values exist and filter matches.
  const values = (blob.values && typeof blob.values === "object") ? blob.values as Record<string, unknown> : null;
  if (!values || !kpiKeysCompatible(values, neededLabels)) return null;

  const filter = String(blob.filter || "");
  if (comboLabel && filter && filter !== comboLabel) return null;

  if (tag) {
    if (tag.mode !== "live") return null;
    if (tag.report_url && reportUrl && tag.report_url !== reportUrl) return null;
    if (
      credentialProfileId &&
      tag.credential_profile_id &&
      tag.credential_profile_id !== credentialProfileId
    ) return null;
    if (!isFreshScrapedAt(tag.scraped_at || row.created_at || "")) return null;
    return {
      values,
      provenance: tag,
      testResultId: String(row.id || ""),
    };
  }

  // Legacy: allow reuse from recent rows without scrape tag (bootstrap Week 0).
  if (!isFreshScrapedAt(String(row.created_at || ""))) return null;
  return {
    values,
    provenance: buildScrapeTag({
      mode: "live",
      reportUrl,
      credentialProfileId,
      scrapedAt: String(row.created_at || new Date().toISOString()),
    }),
    testResultId: String(row.id || ""),
  };
}

/** Shape accepted by pickComboKpis in agent-orchestrate. */
export function toRuntimeResponseFromValues(
  values: Record<string, unknown>,
  comboLabel: string | null,
  meta?: { reused_from?: string; source_test_result_id?: string },
): Record<string, unknown> {
  const block = { ...values };
  const result = comboLabel
    ? { [comboLabel]: block, results: { [comboLabel]: block } }
    : block;
  return {
    ok: true,
    extracted: { ok: true, result },
    provider: "scrape-reuse",
    reused: true,
    reused_from: meta?.reused_from || null,
    source_test_result_id: meta?.source_test_result_id || null,
  };
}

export type FindDonorArgs = {
  sb: any;
  scenario: { id: string; title?: string | null; pair_key?: string | null; report_id: string };
  pairedReportId: string | null;
  side: DonorSide;
  reportUrl: string;
  credentialProfileId: string | null;
  comboLabel: string;
  neededLabels: string[];
};

export async function findLiveDonor(args: FindDonorArgs): Promise<{
  values: Record<string, unknown>;
  provenance: ScrapeProvenance;
  testResultId: string;
} | null> {
  const {
    sb, scenario, pairedReportId, side, reportUrl, credentialProfileId,
    comboLabel, neededLabels,
  } = args;

  const scenarioIds = new Set<string>([scenario.id]);
  if (pairedReportId) {
    const { data: pairedScenarios } = await sb
      .from("scenarios")
      .select("id, title, pair_key")
      .eq("report_id", pairedReportId)
      .limit(200);
    for (const ps of pairedScenarios || []) {
      if (scenariosPairMatch(scenario, ps)) scenarioIds.add(ps.id);
    }
  }

  const ids = [...scenarioIds];
  const since = new Date(Date.now() - SCRAPE_REUSE_MAX_AGE_MS).toISOString();
  const { data: rows, error } = await sb
    .from("test_results")
    .select("id, scenario_id, actual, expected, created_at")
    .in("scenario_id", ids)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(80);
  if (error || !rows?.length) return null;

  for (const row of rows) {
    const hit = extractDonorValues(
      row,
      side,
      reportUrl,
      credentialProfileId,
      neededLabels,
      comboLabel,
    );
    if (hit) return hit;
  }
  return null;
}

/** Front-end mirror of supabase/functions/_shared/scrape-reuse.ts (vitest). */

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

export function scrapeBadgeLabel(side: unknown): string {
  const tag = readScrapeTag(side);
  if (!tag) return "Live";
  if (tag.mode === "reused") {
    const d = tag.scraped_at ? new Date(tag.scraped_at) : null;
    const when = d && Number.isFinite(d.getTime())
      ? d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
      : "prior run";
    return `Reused from ${when}`;
  }
  return "Live";
}

export function confirmReuseRunMessage(preset: "preprod" | "prod" | "both"): string {
  if (preset === "preprod") {
    return "Scrape Pre-prod (reference) live and reuse Prod (actual) from Supabase when available. Continue?";
  }
  if (preset === "prod") {
    return "Scrape Prod (actual) live and reuse Pre-prod (reference) from the last Pre-prod run in Supabase when available. Continue?";
  }
  return "Scrape both Main and Reference live (no reuse). Continue?";
}

import { describe, expect, it } from "vitest";
import {
  buildScrapeTag,
  filterComboKey,
  isFreshScrapedAt,
  kpiKeysCompatible,
  normalizeScenarioTitle,
  readScrapeTag,
  scenariosPairMatch,
  scrapeBadgeLabel,
  SCRAPE_REUSE_MAX_AGE_MS,
} from "./scrapeReuse";

describe("scrapeReuse", () => {
  it("matches scenarios by pair_key or normalized title", () => {
    expect(scenariosPairMatch(
      { pair_key: "aaa", title: "Overview" },
      { pair_key: "aaa", title: "Other" },
    )).toBe(true);
    expect(scenariosPairMatch(
      { pair_key: null, title: "Overview (copy)" },
      { pair_key: null, title: "Overview" },
    )).toBe(true);
    expect(scenariosPairMatch(
      { title: "A" },
      { title: "B" },
    )).toBe(false);
    expect(normalizeScenarioTitle("  Foo  (copy) ")).toBe("foo");
  });

  it("builds stable filter combo keys", () => {
    expect(filterComboKey("Combo 1", { b: "2", a: "1" }))
      .toBe(filterComboKey("combo 1", { a: "1", b: "2" }));
  });

  it("checks KPI compatibility", () => {
    expect(kpiKeysCompatible({ NBRx: 1, TRx: 2 }, ["NBRx"])).toBe(true);
    expect(kpiKeysCompatible({ NBRx: null }, ["NBRx"])).toBe(false);
    expect(kpiKeysCompatible({ grid: { columns: ["a"], rows: [["1"]] } }, ["grid"])).toBe(true);
    expect(kpiKeysCompatible({}, ["NBRx"])).toBe(false);
  });

  it("enforces 9-day freshness", () => {
    const now = Date.parse("2026-11-10T00:00:00Z");
    expect(isFreshScrapedAt("2026-11-05T00:00:00Z", now)).toBe(true);
    expect(isFreshScrapedAt("2026-10-01T00:00:00Z", now)).toBe(false);
    expect(SCRAPE_REUSE_MAX_AGE_MS).toBe(9 * 24 * 60 * 60 * 1000);
  });

  it("reads scrape tags and badge labels", () => {
    const live = { values: { a: 1 }, scrape: buildScrapeTag({ mode: "live", reportUrl: "https://prod" }) };
    expect(readScrapeTag(live)?.mode).toBe("live");
    expect(scrapeBadgeLabel(live)).toBe("Live");
    const reused = {
      values: { a: 1 },
      scrape: buildScrapeTag({
        mode: "reused",
        reportUrl: "https://prod",
        sourceTestResultId: "x",
        scrapedAt: "2026-11-03T10:00:00.000Z",
      }),
    };
    expect(scrapeBadgeLabel(reused)).toMatch(/^Reused from /);
  });
});

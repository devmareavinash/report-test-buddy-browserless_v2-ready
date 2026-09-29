import { describe, expect, it } from "vitest";
import { pickTrendView } from "./trend-payload";

describe("pickTrendView", () => {
  it("reads nested grains from orchestrate persist", () => {
    const view = pickTrendView({
      filter: "combo_1",
      values: {
        grains: {
          Weekly: { periods: ["W1", "W2"], consecutive: true },
          Monthly: { periods: ["Jan", "Feb"], consecutive: true },
          Quarterly: { periods: ["Q1", "Q2"], consecutive: false, missing: ["Q3"] },
        },
        "Trend check": 0,
      },
    });
    expect(view?.grains.map((g) => g.name)).toEqual(["Weekly", "Monthly", "Quarterly"]);
    expect(view?.grains[0].periods).toEqual(["W1", "W2"]);
    expect(view?.consecutive).toBe(false);
  });

  it("reconstructs grains from Trend check scores when grains were stripped", () => {
    const view = pickTrendView({
      source: "manual_headless",
      values: {
        "Trend check": 1,
        "Trend check Weekly": 1,
        "Trend check Monthly": 1,
        "Trend check Quarterly": 1,
      },
    });
    expect(view?.grains).toHaveLength(3);
    expect(view?.grains.every((g) => g.score === 1)).toBe(true);
    expect(view?.consecutive).toBe(true);
  });

  it("walks extracted.result when values omitted grains", () => {
    const view = pickTrendView({
      values: { "Trend check": 1 },
      extracted: {
        result: {
          grains: {
            Weekly: { periods: ["1/6/2026", "1/13/2026"], consecutive: true },
            Monthly: { periods: ["Jan 2026", "Feb 2026"], consecutive: true },
            Quarterly: { periods: ["Q4 2025", "Q1 2026"], consecutive: true },
          },
        },
      },
    });
    expect(view?.grains[1].periods).toEqual(["Jan 2026", "Feb 2026"]);
  });
});

import { describe, it, expect } from "vitest";
import { matchCombination } from "../../supabase/functions/_shared/combination-identity";

const combo = { id: "c1", label: "", filters: { Area: "Total", Team: "Portfolio", Brand: "Nubeqa", Territory: "Total", "Time Bucket": "YTD" } };
const evidence = (sel: Record<string, string | null>) =>
  Object.fromEntries(Object.entries(sel).map(([k, v]) => [k, { ok: true, via: "legacy-selector", selected: v }]));

describe("combination matching with recorded filter evidence", () => {
  it("matches when each recorded filter shows the requested value", () => {
    const fa = evidence({ Area: "Total", Team: "Portfolio", Brand: "Nubeqa", Territory: "Total", "Time Bucket": "YTD" });
    expect(matchCombination([combo], combo, [{ actual: { filter: "combo_1", filters_applied: fa } }])).not.toBeNull();
  });
  it("rejects when a recorded filter shows a different value", () => {
    const fa = evidence({ Area: "Total", Team: "Portfolio", Brand: "Xofigo", Territory: "Total", "Time Bucket": "YTD" });
    expect(matchCombination([combo], combo, [{ actual: { filter: "combo_1", filters_applied: fa } }])).toBeNull();
  });
});

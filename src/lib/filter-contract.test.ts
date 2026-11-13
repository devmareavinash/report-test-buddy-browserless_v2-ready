import { describe, expect, it } from "vitest";
import { filterValuesEqual, verifyFilterEvidence } from "../../supabase/functions/_shared/filter-verification";
import { FILTER_CORE_JS } from "../../supabase/functions/_shared/mstr-filter-core";
describe("fail closed filter evidence", () => {
  it("Brand Alpha does not match Brand Beta", () => { expect(filterValuesEqual("Brand Alpha", "Brand Beta")).toBe(false); });
  it("supports explicit matching code formats", () => { expect(filterValuesEqual("AA52 - Northeast", "AA52: North East")).toBe(true); });
  it("a previous East state cannot satisfy the next West request", () => { expect(verifyFilterEvidence({ Region: "West" }, { Region: "East" }).ok).toBe(false); });
  it("requested values without observed evidence remain unverified", () => { expect(verifyFilterEvidence({ Region: "West" }, null)).toMatchObject({ ok: false, evidence: [{ key: "Region", requested: "West", observed: null }] }); });
  it("failed selection cannot pass despite matching text", () => { expect(verifyFilterEvidence({ Region: "West" }, { Region: { ok: false, verified: "West" } }).ok).toBe(false); });
  it("active filter core stops before extraction on failed selection", async () => {
    const start = FILTER_CORE_JS.indexOf("const applyFiltersVerified");
    const code = FILTER_CORE_JS.slice(start).replace("// @@RTB_FILTER_CORE_END@@", "");
    let reads = 0;
    const apply = new Function("selectByLabel", "__rtbCloseDropdown", "waitForLoadingToFinish", "__rtbCheckErrorDialog", "__rtbReadFilter", "__rtbCode", `${code}; return applyFiltersVerified;`)(async () => ({ ok: false, error: "FILTER_NOT_APPLIED" }), async () => {}, async () => {}, async () => null, async () => { reads++; return "West"; }, (value: any) => value);
    expect(await apply({ Region: "West" })).toMatchObject({ ok: false, failed_on: "Region" });
    expect(reads).toBe(0);
  });
});
import { describe, expect, it } from "vitest";
import {
  buildClonedScriptInsert,
  pickCanonicalScript,
  pickDuplicableScript,
  remapSqlTemplateId,
  scriptHasDuplicableContent,
} from "./canonicalScript";

const stub = { id: "stub", playwright_code: "", assertion_spec: {}, created_at: "2026-09-15T12:00:00Z" };
const withCode = {
  id: "code",
  playwright_code: "await page.goto('https://example');",
  assertion_spec: { kpis: ["Sales"] },
  created_at: "2026-09-15T11:00:00Z",
};
const withRef = {
  id: "ref",
  playwright_code: "  ",
  assertion_spec: { __reference_playwright_code: "await page.click('#show-data');" },
  created_at: "2026-09-15T10:00:00Z",
};

describe("pickCanonicalScript", () => {
  it("prefers a saved playwright_code row over a newer empty stub", () => {
    expect(pickCanonicalScript([stub, withCode])?.id).toBe("code");
  });

  it("among coded rows, prefers newest created_at", () => {
    const older = { ...withCode, id: "old", created_at: "2026-09-14T00:00:00Z" };
    const newer = { ...withCode, id: "new", created_at: "2026-09-15T00:00:00Z" };
    expect(pickCanonicalScript([older, newer])?.id).toBe("new");
  });
});

describe("pickDuplicableScript", () => {
  it("prefers saved playwright_code over an empty stub", () => {
    const picked = pickDuplicableScript([stub, withCode, withRef]);
    expect(picked?.id).toBe("code");
    expect(pickCanonicalScript([stub, withCode])?.id).toBe("code");
  });

  it("falls back to reference Playwright when test code is empty", () => {
    expect(pickDuplicableScript([stub, withRef])?.id).toBe("ref");
    expect(scriptHasDuplicableContent(stub)).toBe(false);
  });

  it("does not copy empty stubs", () => {
    expect(pickDuplicableScript([stub])).toBeNull();
  });
});

describe("buildClonedScriptInsert", () => {
  it("copies canonical fields onto a new scenario_id and omits the old scripts.id", () => {
    const spec = { kpis: ["Sales"], __reference_playwright_code: "await page.click('#x');" };
    const insert = buildClonedScriptInsert(
      {
        id: "old-script-id",
        scenario_id: "old-scenario",
        playwright_code: "await page.goto('/');",
        assertion_spec: spec,
        sql_template_id: "tmpl-1",
        sql_filters: { geo: "US" },
        credential_profile_id: "cred-1",
        reference_credential_profile_id: "cred-2",
        debug_status: "passed",
      },
      "new-scenario",
    );

    expect(insert).not.toHaveProperty("id");
    expect(insert.scenario_id).toBe("new-scenario");
    expect(insert.playwright_code).toBe("await page.goto('/');");
    expect(insert.assertion_spec.__reference_playwright_code).toBe("await page.click('#x');");
    expect(insert.assertion_spec).not.toBe(spec);
    expect(insert.sql_template_id).toBe("tmpl-1");
    expect(insert.credential_profile_id).toBe("cred-1");
    expect(insert.reference_credential_profile_id).toBe("cred-2");
    expect(insert.debug_status).toBe("passed");
    expect(insert.sql_filters).toEqual({ geo: "US" });
  });

  it("remaps report-scoped SQL template ids and keeps global ids", () => {
    const map = new Map([["tmpl-local", "tmpl-copy"]]);
    expect(remapSqlTemplateId("tmpl-local", map)).toBe("tmpl-copy");
    expect(remapSqlTemplateId("tmpl-global", map)).toBe("tmpl-global");
    expect(remapSqlTemplateId(null, map)).toBeNull();

    const insert = buildClonedScriptInsert(
      { playwright_code: "x", sql_template_id: "tmpl-local", assertion_spec: {} },
      "new-scenario",
      { sqlTemplateIdMap: map },
    );
    expect(insert.sql_template_id).toBe("tmpl-copy");
  });
});

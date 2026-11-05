import { describe, expect, it } from "vitest";
import {
  assessConfiguredCompleteness,
  classifyRuntimePayload,
  finalizeTargetOutcome,
  isExtractedKpiValue,
  isTerminalFailStatus,
  statusFromCategory,
} from "../../supabase/functions/_shared/extraction-outcome.ts";

describe("extraction-outcome", () => {
  it("detects reference login-page as auth_failure", () => {
    const c = classifyRuntimePayload({
      extracted: {
        ok: true,
        error: null,
        result: { ok: false, error: "LOGIN_FAILED" },
        url: "https://mstr-qa.example/MicroStrategyLibrarySTD/auth/ui/loginPage",
      },
    }, { target: "reference" });
    expect(c.category).toBe("auth_failure");
    expect(c.auth_failure).toBe(true);
  });

  it("detects BROWSERLESS_TIMEOUT", () => {
    const c = classifyRuntimePayload({
      extracted: { ok: false, error: "BROWSERLESS_TIMEOUT", result: null },
    });
    expect(c.category).toBe("browserless_timeout");
  });

  it("treats 0 and N/A as extracted, null as missing", () => {
    expect(isExtractedKpiValue(0)).toBe(true);
    expect(isExtractedKpiValue("N/A")).toBe(true);
    expect(isExtractedKpiValue(null)).toBe(false);
    expect(isExtractedKpiValue({ error: "grid missing" })).toBe(false);
    expect(isExtractedKpiValue({ columns: ["a"], rows: [["1"]] })).toBe(true);
  });

  it("marks partial when one configured KPI is missing", () => {
    const report = assessConfiguredCompleteness(
      ["Physician Name", "Top 10 Payers - NBRx"],
      { "Physician Name": "Gentzon Hall", "Top 10 Payers - NBRx": null },
    );
    expect(report.category).toBe("partial_extraction");
    expect(report.missing).toEqual(["Top 10 Payers - NBRx"]);
    expect(report.present).toEqual(["Physician Name"]);
    expect(report.balanced).toBe(true);
  });

  it("finalize prefers auth over partial", () => {
    const runtime = classifyRuntimePayload({
      extracted: { ok: true, url: "https://x/auth/ui/loginPage", result: {} },
    });
    const completeness = assessConfiguredCompleteness(["Sales WE"], {});
    const out = finalizeTargetOutcome(runtime, completeness);
    expect(out.category).toBe("auth_failure");
  });

  it("statusFromCategory keeps compare fail separate from pass", () => {
    expect(statusFromCategory("pass", true)).toBe("pass");
    expect(statusFromCategory("pass", false)).toBe("fail");
    expect(statusFromCategory("partial_extraction", false)).toBe("partial_extraction");
    expect(isTerminalFailStatus("auth_failure")).toBe(true);
    expect(isTerminalFailStatus("pass")).toBe(false);
  });

  it("classifies auth reasons without treating partial as auth", () => {
    const partial = classifyRuntimePayload({
      extracted: { ok: true, url: "https://mstr.example/app", result: { "Physician Name": "X" } },
    });
    expect(partial.category).toBe("pass");
    expect(partial.auth_failure).toBe(false);

    const stayed = classifyRuntimePayload({
      extracted: {
        ok: false,
        url: "https://mstr-qa.example/MicroStrategyLibrarySTD/auth/ui/loginPage",
        error: null,
      },
    }, { target: "reference" });
    expect(stayed.category).toBe("auth_failure");
    expect(stayed.error).toBe("stayed_on_login_page");
  });

  it("balances expected = extracted + missing", () => {
    const report = assessConfiguredCompleteness(
      ["A", "B", "C"],
      { A: 0, B: "N/A", C: null },
    );
    expect(report.present).toEqual(["A", "B"]);
    expect(report.missing).toEqual(["C"]);
    expect(report.balanced).toBe(true);
    expect(report.present.length + report.missing.length).toBe(report.expected.length);
  });
});

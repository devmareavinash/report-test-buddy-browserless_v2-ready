// Deno tests for extraction-outcome (corp VDI may lack vitest).
import {
  assessConfiguredCompleteness,
  classifyAuthFailureReason,
  classifyRuntimePayload,
  finalizeTargetOutcome,
  isExtractedKpiValue,
  isTerminalFailStatus,
  statusFromCategory,
} from "./extraction-outcome.ts";

function assert(cond: unknown, msg = "assertion failed"): asserts cond {
  if (!cond) throw new Error(msg);
}
function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (a !== b) throw new Error(msg || `expected ${Deno.inspect(b)}, got ${Deno.inspect(a)}`);
}

Deno.test("login page → auth_failure with stayed_on_login_page", () => {
  const c = classifyRuntimePayload({
    extracted: {
      ok: true,
      error: null,
      result: {},
      url: "https://mstr-qa.example/MicroStrategyLibrarySTD/auth/ui/loginPage",
    },
  }, { target: "reference" });
  assertEquals(c.category, "auth_failure");
  assert(c.auth_failure);
  assertEquals(c.error, "stayed_on_login_page");
});

Deno.test("BROWSERLESS_TIMEOUT classification", () => {
  const c = classifyRuntimePayload({
    extracted: { ok: false, error: "BROWSERLESS_TIMEOUT", result: null },
  });
  assertEquals(c.category, "browserless_timeout");
});

Deno.test("0 and N/A extracted; null missing", () => {
  assert(isExtractedKpiValue(0));
  assert(isExtractedKpiValue("N/A"));
  assert(!isExtractedKpiValue(null));
  assert(!isExtractedKpiValue({ error: "grid missing" }));
});

Deno.test("partial completeness gate", () => {
  const report = assessConfiguredCompleteness(
    ["Physician Name", "Top 10 Payers - NBRx"],
    { "Physician Name": "Gentzon Hall", "Top 10 Payers - NBRx": null },
  );
  assertEquals(report.category, "partial_extraction");
  assertEquals(report.missing.join(","), "Top 10 Payers - NBRx");
  assertEquals(report.present.join(","), "Physician Name");
  assert(report.balanced);
  assertEquals(report.present.length + report.missing.length, report.expected.length);
});

Deno.test("finalize prefers auth over partial", () => {
  const runtime = classifyRuntimePayload({
    extracted: { ok: true, url: "https://x/auth/ui/loginPage", result: {} },
  });
  const completeness = assessConfiguredCompleteness(["Sales WE"], {});
  const out = finalizeTargetOutcome(runtime, completeness);
  assertEquals(out.category, "auth_failure");
});

Deno.test("statusFromCategory + terminal set", () => {
  assertEquals(statusFromCategory("pass", true), "pass");
  assertEquals(statusFromCategory("pass", false), "fail");
  assertEquals(statusFromCategory("partial_extraction", false), "partial_extraction");
  assert(isTerminalFailStatus("auth_failure"));
  assert(!isTerminalFailStatus("pass"));
});

Deno.test("auth reason codes", () => {
  assertEquals(classifyAuthFailureReason("LOGIN_FAILED"), "invalid_credentials");
  assertEquals(
    classifyAuthFailureReason(null, "https://x/MicroStrategyLibrarySTD/auth/ui/loginPage"),
    "stayed_on_login_page",
  );
  assertEquals(classifyAuthFailureReason("account locked"), "account_locked_or_expired");
});

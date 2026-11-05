import { describe, expect, it } from "vitest";
import {
  extractCapturedStorageState,
  extractionLooksUnusable,
  isValidStorageState,
  looksLikeLoginPageUrl,
  pathnameOnly,
  sanitizeProfileId,
  shouldClearAuthSession,
  shouldRetryAuthSessionFresh,
  shouldSaveAuthSession,
  wrapCodeWithAuthSession,
} from "./playwrightAuthSession";

describe("playwrightAuthSession", () => {
  it("sanitizes credential profile ids", () => {
    expect(sanitizeProfileId("a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toBe(
      "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    );
    expect(sanitizeProfileId("../etc/passwd")).toBeNull();
    expect(sanitizeProfileId("short")).toBeNull();
  });

  it("requires cookies or origin localStorage", () => {
    expect(isValidStorageState(null)).toBe(false);
    expect(isValidStorageState({ cookies: [{ name: "JSESSIONID", value: "x", domain: "x.com", path: "/" }] })).toBe(true);
  });

  it("does not clear on missing KPI; does not fresh-retry", () => {
    const payload = { extracted: { ok: true, result: { Default: { "Net Sales": null } } } };
    expect(extractionLooksUnusable(payload)).toBe(true);
    expect(shouldClearAuthSession(payload)).toBe(false);
    expect(shouldRetryAuthSessionFresh(payload)).toBe(false);
  });

  it("does not clear on generic extraction errors", () => {
    expect(shouldRetryAuthSessionFresh({
      ok: false,
      error: "TimeoutError: locator.click",
    })).toBe(false);
  });

  it("clears and fresh-retries on LOGIN_FAILED / AUTH_REQUIRED", () => {
    expect(shouldRetryAuthSessionFresh({
      extracted: { ok: false, error: "LOGIN_FAILED" },
    })).toBe(true);
    expect(shouldRetryAuthSessionFresh({
      extracted: { ok: false, error: "AUTH_REQUIRED" },
    })).toBe(true);
  });

  it("login URL segments clear; dashboard and title-like paths do not", () => {
    expect(looksLikeLoginPageUrl("https://mstr.example/auth/login")).toBe(true);
    expect(looksLikeLoginPageUrl("https://mstr.example/app/Library")).toBe(false);
    expect(looksLikeLoginPageUrl("https://mstr.example/app/AuthenticationReport")).toBe(false);
    expect(pathnameOnly("https://h/app?token=SECRET")).toBe("/app");
  });

  it("saves only when cookies exist and extraction is usable", () => {
    const state = { cookies: [{ name: "s", value: "1", domain: "a.com", path: "/" }] };
    expect(shouldSaveAuthSession({
      ok: true,
      result: { Default: { "Net Sales": 12.5 } },
    }, state)).toBe(true);
    expect(shouldSaveAuthSession({
      ok: true,
      result: { Default: { "Net Sales": null } },
    }, state)).toBe(false);
    expect(shouldSaveAuthSession(
      { ok: true, result: { ok: false, error: "LOGIN_FAILED" } },
      state,
    )).toBe(false);
  });

  it("pulls captured storageState from common payload shapes", () => {
    const state = { cookies: [{ name: "JSESSIONID", value: "abc" }] };
    expect(extractCapturedStorageState({
      extracted: { ok: true, result: { ok: true, __storageState: state } },
    })).toEqual(state);
  });

  it("marks wrapped code for fresh vs reuse sessions", () => {
    expect(wrapCodeWithAuthSession("await page.goto('x')", false)).toContain("auth-session:fresh");
    expect(wrapCodeWithAuthSession("export default async ({ page }) => {}", true)).toContain("auth-session:reuse");
  });
});

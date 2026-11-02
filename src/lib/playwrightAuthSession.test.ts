import { describe, expect, it } from "vitest";
import {
  extractCapturedStorageState,
  isValidStorageState,
  sanitizeProfileId,
  shouldClearAuthSession,
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
    expect(sanitizeProfileId("")).toBeNull();
  });

  it("requires cookies or origin localStorage", () => {
    expect(isValidStorageState(null)).toBe(false);
    expect(isValidStorageState({})).toBe(false);
    expect(isValidStorageState({ cookies: [] })).toBe(false);
    expect(isValidStorageState({ cookies: [{ name: "JSESSIONID", value: "x", domain: "x.com", path: "/" }] })).toBe(true);
    expect(isValidStorageState({
      origins: [{ origin: "https://report.example", localStorage: [{ name: "t", value: "1" }] }],
    })).toBe(true);
  });

  it("clears session on LOGIN_FAILED nested in result", () => {
    expect(shouldClearAuthSession({ ok: true, result: { ok: false, error: "LOGIN_FAILED" } })).toBe(true);
    expect(shouldClearAuthSession({ ok: true, result: { ok: true } })).toBe(false);
    expect(shouldClearAuthSession({ ok: false, error: "timeout" })).toBe(false);
  });

  it("saves when cookies exist unless LOGIN_FAILED", () => {
    const state = { cookies: [{ name: "s", value: "1", domain: "a.com", path: "/" }] };
    expect(shouldSaveAuthSession({ ok: true, result: { ok: true } }, state)).toBe(true);
    // KPI/script failure after login should still keep the session
    expect(shouldSaveAuthSession({ ok: false, error: "boom" }, state)).toBe(true);
    expect(shouldSaveAuthSession(
      { ok: true, result: { ok: false, error: "LOGIN_FAILED" } },
      state,
    )).toBe(false);
    expect(shouldSaveAuthSession({ ok: true }, { cookies: [] })).toBe(false);
  });

  it("pulls captured storageState from playwright-runtime payload shape", () => {
    const state = { cookies: [{ name: "JSESSIONID", value: "abc" }] };
    expect(extractCapturedStorageState({
      extracted: { ok: true, result: { ok: true, __storageState: state } },
    })).toEqual(state);
    expect(extractCapturedStorageState({ extracted: { ok: true, result: { ok: true } } })).toBeNull();
  });

  it("marks wrapped code for fresh vs reuse sessions", () => {
    expect(wrapCodeWithAuthSession("await page.goto('x')", false)).toContain("auth-session:fresh");
    expect(wrapCodeWithAuthSession("export default async ({ page }) => {}", true)).toContain("auth-session:reuse");
  });
});

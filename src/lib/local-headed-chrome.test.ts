import { describe, expect, it } from "vitest";
import {
  headedFallbackHeadless,
  headedUseLocalChrome,
  localHeadedChannel,
} from "../../supabase/functions/_shared/local-headed-chrome-policy.ts";

describe("headedUseLocalChrome", () => {
  it("honours explicit false/true", () => {
    expect(headedUseLocalChrome({ get: (k) => (k === "HEADED_USE_LOCAL_CHROME" ? "false" : undefined) }, () => false)).toBe(false);
    expect(headedUseLocalChrome({ get: (k) => (k === "HEADED_USE_LOCAL_CHROME" ? "true" : undefined) }, () => true)).toBe(true);
  });

  it("defaults on for host backends and off in Docker", () => {
    expect(headedUseLocalChrome({ get: () => undefined }, () => false)).toBe(true);
    expect(headedUseLocalChrome({ get: () => undefined }, () => true)).toBe(false);
  });
});

describe("localHeadedChannel", () => {
  it("defaults to chrome and maps edge aliases", () => {
    expect(localHeadedChannel({ get: () => undefined })).toBe("chrome");
    expect(localHeadedChannel({ get: (k) => (k === "HEADED_LOCAL_CHANNEL" ? "msedge" : undefined) })).toBe("msedge");
    expect(localHeadedChannel({ get: (k) => (k === "HEADED_LOCAL_CHANNEL" ? "edge" : undefined) })).toBe("msedge");
  });
});

describe("headedFallbackHeadless", () => {
  it("defaults off so Solo headed does not hide Chrome launch failures", () => {
    expect(headedFallbackHeadless({ get: () => undefined })).toBe(false);
    expect(headedFallbackHeadless({ get: (k) => (k === "HEADED_FALLBACK_HEADLESS" ? "true" : undefined) })).toBe(true);
  });
});

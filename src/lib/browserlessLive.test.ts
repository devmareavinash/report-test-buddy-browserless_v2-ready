import { describe, expect, it } from "vitest";
import { normalizeDebuggerUrl } from "./browserlessLive";

describe("normalizeDebuggerUrl", () => {
  it("maps bare Browserless root to /debugger/", () => {
    expect(normalizeDebuggerUrl("http://127.0.0.1:3000/")).toBe(
      "http://127.0.0.1:3000/debugger/?token=local-dev-token",
    );
    expect(normalizeDebuggerUrl("http://127.0.0.1:3000")).toBe(
      "http://127.0.0.1:3000/debugger/?token=local-dev-token",
    );
  });

  it("keeps an existing /debugger/ path and token", () => {
    expect(normalizeDebuggerUrl("http://127.0.0.1:3000/debugger/?token=abc")).toBe(
      "http://127.0.0.1:3000/debugger/?token=abc",
    );
  });
});

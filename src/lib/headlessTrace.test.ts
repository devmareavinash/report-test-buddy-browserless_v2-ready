import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), headers: vi.fn() }));
vi.mock("./functions", () => ({ invokeFunction: mocks.invoke, functionAuthHeaders: mocks.headers, functionEndpoint: () => "http://collector", usesSelfHostedFunctions: () => true }));
import { runTracedHeadless } from "./headlessTraceRun";
describe("optional Headless logging", () => {
  beforeEach(() => { vi.resetAllMocks(); });
  it("continues execution when the collector is unavailable", async () => {
    mocks.invoke.mockResolvedValueOnce({ data: null, error: new Error("unavailable") }).mockResolvedValueOnce({ data: { ok: true }, error: null });
    const body = { code: "export default async () => 42" };
    expect((await runTracedHeadless(body, () => {})).data).toMatchObject({ ok: true, __run_timing: { attempts: [expect.objectContaining({ target: "main" })] } });
    expect(mocks.invoke.mock.calls[1][1].code).toContain("RTB_REPORT_PHASE_TIMING");
  });
  it("preserves execution when log auth refresh rejects", async () => {
    mocks.invoke.mockResolvedValueOnce({ data: { id: "trace", callback_url: "http://collector" }, error: null }).mockResolvedValueOnce({ data: { ok: true }, error: null });
    mocks.headers.mockRejectedValue(new Error("secret refresh token"));
    expect((await runTracedHeadless({ code: "export default async () => 42" }, () => {})).data).toMatchObject({ ok: true });
  });
  it("continues execution after rejected collector creation", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("network unavailable")).mockResolvedValueOnce({ data: 42, error: null });
    expect((await runTracedHeadless({ code: "original" }, () => {})).data).toBe(42);
  });
});

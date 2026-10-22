import { beforeEach, describe, expect, it, vi } from "vitest";

const { range, order, included } = vi.hoisted(() => ({
  range: vi.fn(), order: vi.fn(), included: vi.fn(),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({ select: () => ({ in: included }) }),
  },
}));

import { fetchRunTestResults } from "./runTestResults";

describe("fetchRunTestResults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    included.mockReturnValue({ order });
    order.mockReturnValue({ range });
  });

  it("includes older-run passes and failures beyond the 1,000-row API cap", async () => {
    const rows = Array.from({ length: 1205 }, (_, index) => ({
      run_id: index < 1000 ? "recent" : "older",
      scenario_id: `scenario-${index}`,
      status: index === 1204 ? "fail" : "pass",
    }));
    range.mockImplementation(async (start: number, end: number) => ({
      data: rows.slice(start, Math.min(end + 1, start + 1000)), error: null,
    }));

    const result = await fetchRunTestResults(["recent", "older"]);
    const older = result.filter((row) => row.run_id === "older");
    expect(result).toHaveLength(1205);
    expect(older.filter((row) => row.status === "pass")).toHaveLength(204);
    expect(older.filter((row) => row.status === "fail")).toHaveLength(1);
    expect(range.mock.calls).toEqual([[0, 999], [1000, 1999]]);
    expect(order).toHaveBeenCalledWith("id", { ascending: true });
  });

  it("fetches another page when a result set ends exactly at the API cap", async () => {
    range.mockResolvedValueOnce({ data: Array.from({ length: 1000 }, () => ({ status: "pass" })), error: null });
    range.mockResolvedValueOnce({ data: [], error: null });
    expect(await fetchRunTestResults(["run"])).toHaveLength(1000);
    expect(range).toHaveBeenCalledTimes(2);
  });

  it("rejects a failed later page instead of returning misleading partial counts", async () => {
    range.mockResolvedValueOnce({ data: Array.from({ length: 1000 }, () => ({ status: "pass" })), error: null });
    const error = new Error("request failed");
    range.mockResolvedValueOnce({ data: null, error });
    await expect(fetchRunTestResults(["run"])).rejects.toThrow("request failed");
  });

  it("does not query results when there are no visible runs", async () => {
    expect(await fetchRunTestResults([])).toEqual([]);
    expect(included).not.toHaveBeenCalled();
  });
});
export function createManualExecutionTarget(scenarioId: string) {
    let complete: (runId: string | null) => void = () => {};
    const savedRun = new Promise<string | null>(resolve => { complete = resolve; });
    return { scenarioId, savedRun, complete };
  }
  
  export async function requireSavedRun(target: Promise<string | null>): Promise<string> {
    const runId = await target;
    if (!runId) throw new Error("The intended Actual result was not saved. Run Actual again before saving Expected values.");
    return runId;
  }
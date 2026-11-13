import { functionAuthHeaders, functionEndpoint, invokeFunction, usesSelfHostedFunctions } from "./functions";
import { instrumentHeadlessScript, type HeadlessStep } from "./headlessTrace";
import { timeReportScript } from "./reportTimingScript";
import { createTimingCollector } from "../../supabase/functions/_shared/run-timing";

function timedBody(body: any, code: string) {
  try { return { ...body, code: timeReportScript(code) }; }
  catch { return { ...body, code }; }
}

function withRunTiming(result: any, timing: ReturnType<typeof createTimingCollector>, body: any) {
  if (!result || result.error || result.data == null || typeof result.data !== "object") return result;
  const combo = body.filter_combinations?.length === 1 ? (body.filter_combinations[0].label ?? null) : null;
  return { ...result, data: { ...result.data, __run_timing: timing.snapshot(combo) } };
}

/** Poll a caller-owned collector while the original runtime request remains unchanged. */
export async function runTracedHeadless(body: any, onSteps: (steps: HeadlessStep[]) => void) {
  const target = body.target === "reference" ? "reference" as const : "main" as const;
  const combo = body.filter_combinations?.length === 1 ? (body.filter_combinations[0].label ?? null) : null;
  const timing = createTimingCollector();
  const runTimed = async (payload: any) => withRunTiming(
    await timing.time({ target, combo, attempt: 1 }, () => invokeFunction("playwright-runtime", payload)),
    timing,
    body,
  );

  const prepared = timedBody(body, body.code);
  if (!usesSelfHostedFunctions()) return runTimed(prepared);

  let created;
  try { created = await invokeFunction<{ id: string; callback_url: string }>("headless-trace", {}); }
  catch { return runTimed(prepared); }
  if (created.error || !created.data) return runTimed(prepared);

  const { id, callback_url } = created.data;
  let code = prepared.code;
  try { code = instrumentHeadlessScript(prepared.code, callback_url, { scenario_id: body.scenario_id, run_id: body.run_id, combo_id: body.filter_combinations?.length === 1 ? body.filter_combinations[0].id : undefined, script_version: body.script_version }); }
  catch { return runTimed(prepared); }

  let polling: Promise<void> | null = null;
  const poll = async () => {
    if (polling) return polling;
    polling = (async () => { try {
      const response = await fetch(`${functionEndpoint("headless-trace")}?id=${encodeURIComponent(id)}`, { headers: await functionAuthHeaders(), signal: AbortSignal.timeout(5000) });
      if (response.ok) { const data = await response.json(); if (Array.isArray(data.steps)) onSteps(data.steps); }
    } catch { /* Never interrupt the original execution because telemetry failed. */ }
    finally { polling = null; } })();
    return polling;
  };
  const timer = setInterval(() => { void poll(); }, 1500);
  try { return await runTimed({ ...body, code }); }
  finally {
    clearInterval(timer);
    await Promise.race([(async () => { await polling; await poll(); })(), new Promise(resolve => setTimeout(resolve, 5500))]);
  }
}

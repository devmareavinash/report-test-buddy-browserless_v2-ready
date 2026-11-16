import { parse } from "acorn";

export interface HeadlessStep {
  sequence: number;
  timestamp: string;
  step: string;
  state: "start" | "complete" | "error" | "waiting";
  elapsed_ms: number;
}

/** Instrument await boundaries only; never include arguments, selectors or credentials. */
export function instrumentHeadlessScript(source: string, callbackUrl: string, correlation: Record<string, unknown> = {}): string {
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module", allowAwaitOutsideFunction: true, locations: true });
  const inserts: Array<{ at: number; text: string }> = [];
  function walk(node: any) {
    if (!node || typeof node !== "object") return;
    if (node.type === "CallExpression" && node.callee?.type === "MemberExpression" &&
        ["evaluate", "evaluateHandle", "$eval", "$$eval", "waitForFunction", "addInitScript", "evaluateOnNewDocument"].includes(node.callee.computed ? node.callee.property?.value : node.callee.property?.name)) {
      // These callbacks run in the page, where the outer trace helper is absent.
      walk(node.callee);
      return;
    }
    if (node.type === "AwaitExpression") {
      const arg = node.argument;
      // An arrow wrapper cannot preserve generator yield/new.target semantics.
      if (source.slice(arg.start, arg.end).match(/\byield\b|\bnew\.target\b/)) return;
      const callee = arg?.type === "CallExpression" ? arg.callee : null;
      const name = callee?.type === "Identifier" ? callee.name
        : callee?.type === "MemberExpression" && !callee.computed ? callee.property?.name : "await";
      const label = `${String(name || "await").replace(/[^a-zA-Z0-9_$]/g, "").slice(0, 60)} · line ${node.loc.start.line}`;
      inserts.push({ at: arg.start, text: `__headlessStep(${JSON.stringify(label)}, async () => (` });
      inserts.push({ at: arg.end, text: "))" });
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc") continue;
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") walk(value);
    }
  }
  walk(ast);
  const exported = (ast as any).body.find((node: any) => node.type === "ExportDefaultDeclaration");
  const body = exported?.declaration?.body;
  if (exported?.declaration?.async && body?.type === "BlockStatement") {
    inserts.push({ at: body.start + 1, text: "try {" });
    inserts.push({ at: body.end - 1, text: "} finally { await __headlessFlush(); }" });
  } else if (exported?.declaration?.async && body) {
    inserts.push({ at: body.start, text: "{ try { return " });
    inserts.push({ at: body.end, text: "; } finally { await __headlessFlush(); } }" });
  }
  const safeCorrelation = Object.fromEntries(Object.entries(correlation).filter(([key, value]) => ["scenario_id", "run_id", "combo_id", "browser_job_id", "script_version"].includes(key) && /^[a-zA-Z0-9_-]{1,80}$/.test(String(value ?? ""))));
  let hash = 2166136261;
  for (const char of source) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  safeCorrelation.script_hash = (hash >>> 0).toString(16);
  let code = source;
  for (const edit of inserts.sort((a, b) => b.at - a.at || Number(b.text.startsWith("; } finally")) - Number(a.text.startsWith("; } finally")))) code = code.slice(0, edit.at) + edit.text + code.slice(edit.at);
  return `// HEADLESS_STEP_TRACE (execution-only; not saved)
let __headlessSequence = 0;
const __headlessPending = new Set();
const __headlessCorrelation = ${JSON.stringify(safeCorrelation)};
const __headlessFlush = async () => { try { let timer; await Promise.race([Promise.allSettled([...__headlessPending]), new Promise(resolve => { timer = setTimeout(resolve, 2100); })]); clearTimeout(timer); } catch {} };
const __headlessTraceUrl = ${JSON.stringify(callbackUrl)};
const __headlessEmit = (step, state, elapsed_ms) => {
  const event = { ...__headlessCorrelation, sequence: ++__headlessSequence, timestamp: new Date().toISOString(), step, state, elapsed_ms };
  try { console.log('[headless-step] ' + JSON.stringify(event)); } catch {}
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const delivery = fetch(__headlessTraceUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event), signal: controller.signal }).catch(() => {}).finally(() => { clearTimeout(timer); __headlessPending.delete(delivery); });
    __headlessPending.add(delivery);
  } catch {}
};
const __headlessStep = async (step, operation) => {
  const started = Date.now();
  __headlessEmit(step, 'start', 0);
  const heartbeat = setInterval(() => __headlessEmit(step, 'waiting', Date.now() - started), 10000);
  try { const result = await operation(); __headlessEmit(step, 'complete', Date.now() - started); return result; }
  catch (error) { __headlessEmit(step, 'error', Date.now() - started); throw error; }
  finally { clearInterval(heartbeat); }
};
${code}`;
}
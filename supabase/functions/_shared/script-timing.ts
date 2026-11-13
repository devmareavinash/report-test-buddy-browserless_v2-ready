/** Execution-only instrumentation. The parser is supplied by each host. */
export function instrumentReportTiming(source: string, parse: (source: string, options: any) => any): string {
    if (source.includes("RTB_REPORT_PHASE_TIMING")) return source;
    try {
      const ast = parse(source, { ecmaVersion: "latest", sourceType: "module", allowAwaitOutsideFunction: true });
      const exported = ast.body.find((n: any) => n.type === "ExportDefaultDeclaration");
      if (!exported || !["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"].includes(exported.declaration.type)) return source;
      const edits: { at: number; text: string }[] = [];
      function walk(node: any, context: string | null = null) {
        if (!node || typeof node !== "object") return;
        const callee = node.type === "CallExpression" ? node.callee : null;
        const method = callee?.type === "MemberExpression" ? callee.property?.name : null;
        if (["evaluate", "evaluateHandle", "$eval", "$$eval", "waitForFunction", "addInitScript", "evaluateOnNewDocument"].includes(method)) return;
        if (node.type === "IfStatement" && /hasLoginForm|loginRequired|needsLogin/.test(source.slice(node.test.start, node.test.end))) {
          walk(node.consequent, "login");
          walk(node.alternate, context);
          return;
        }
        if (node.type === "AwaitExpression") {
          const arg = node.argument;
          let inner = arg;
          while (inner.type === "CallExpression" && inner.callee?.type === "MemberExpression" && ["catch", "then"].includes(inner.callee.property?.name)) inner = inner.callee.object;
          const call = inner.type === "CallExpression" ? inner.callee : null;
          const name = call?.name || call?.property?.name || "";
          const text = source.slice(arg.start, arg.end);
          if (/\byield\b|\bnew\.target\b/.test(text)) return;
          const phase = context || (/login|signIn|authenticate|detectLoginForm/i.test(name) || (name === "goto" && /loginUrl|login_url/.test(text)) ? "login"
            : /apply.*filter|selectByLabel|applyTimeGrain|applyViewBy|selectFilter/i.test(name) ? "filters"
            : /waitForLoading|waitForDashboard|waitForShowData|waitForData/i.test(name) ? "data_ready"
            : /goto|runNav|waitForDossier|navigate/i.test(name) ? "load"
            : /extract|scrape|readKpi|readValues|openShowData/i.test(name) ? "extract" : null);
          edits.push({ at: arg.start, text: `__rtbMeasure(${JSON.stringify(phase)}, async () => (` });
          edits.push({ at: arg.end, text: "))" });
        }
        for (const [key, value] of Object.entries(node)) {
          if (key === "loc") continue;
          if (Array.isArray(value)) value.forEach(x => walk(x, context));
          else if (value && typeof value === "object") walk(value, context);
        }
      }
      walk(exported.declaration);
      let code = source;
      for (const e of edits.sort((a, b) => b.at - a.at)) code = code.slice(0, e.at) + e.text + code.slice(e.at);
      code = code.slice(0, exported.start) + code.slice(exported.start).replace(/^export\s+default\s+/, "const __rtbOriginal = ");
      return `// RTB_REPORT_PHASE_TIMING: execution copy only
  let __rtbStart = 0, __rtbActive = [], __rtbSegments = [], __rtbLast = 0;
  const __rtbTick = () => {
    const now = Date.now() - __rtbStart;
    const phase = [...__rtbActive].reverse().find(x => x.phase)?.phase;
    if (phase && now > __rtbLast) __rtbSegments.push({ phase, start_ms: __rtbLast, end_ms: now });
    __rtbLast = now;
  };
  const __rtbMeasure = async (phase, fn) => {
    __rtbTick(); const entry = { phase }; __rtbActive.push(entry);
    try { return await fn(); }
    finally { __rtbTick(); __rtbActive = __rtbActive.filter(x => x !== entry); }
  };
  ${code}
  ;
  export default async (...args) => {
    __rtbStart = Date.now(); __rtbLast = 0; __rtbSegments = []; __rtbActive = [];
    const result = await __rtbOriginal(...args);
    __rtbTick();
    if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
    const timings = {};
    for (const s of __rtbSegments) timings[s.phase] = (timings[s.phase] || 0) + s.end_ms - s.start_ms;
    return { ...result, timings, __rtb_timing: { script_started_at: new Date(__rtbStart).toISOString(), script_ms: Date.now() - __rtbStart, segments: __rtbSegments } };
  };`;
    } catch { return source; }
  }
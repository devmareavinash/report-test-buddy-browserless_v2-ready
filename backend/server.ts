// Standalone HTTP server that hosts ALL Supabase edge functions in one
// Deno process. Each function lives in supabase/functions/<name>/index.ts
// and calls Deno.serve(handler) at module top-level. We monkey-patch
// Deno.serve to capture each handler instead of starting its own listener,
// then route /functions/v1/<name>/* to the matching handler.
//
// This is what runs inside the backend Docker image.

const handlers = new Map<string, (req: Request) => Response | Promise<Response>>();
let currentName = "";

// Capture handlers
const originalServe = Deno.serve.bind(Deno);
// @ts-ignore — we intentionally replace the signature
Deno.serve = (handlerOrOpts: any, maybeHandler?: any) => {
  const handler = typeof handlerOrOpts === "function" ? handlerOrOpts : maybeHandler;
  if (!handler || !currentName) return { finished: Promise.resolve(), shutdown: async () => {}, ref: () => {}, unref: () => {} } as any;
  handlers.set(currentName, handler);
  return { finished: Promise.resolve(), shutdown: async () => {}, ref: () => {}, unref: () => {} } as any;
};

const FUNCTIONS = [
  "admin-users",
  "agent-analyze",
  "agent-heal",
  "agent-heal-script",
  "agent-orchestrate",
  "agent-scenarios",
  "agent-scrape",
  "agent-scripts",
  "bootstrap-admin",
  "playwright-runtime",
  "run-warehouse-sql",
  "schedule-tick",
  "test-warehouse-connectivity",
  "trigger-run",
];

async function resolveFunctionsDir(): Promise<URL> {
  const fromEnv = Deno.env.get("FUNCTIONS_DIR");
  if (fromEnv) {
    // A base URL without a trailing slash is treated as a file. Then resolving
    // "agent-orchestrate/index.ts" incorrectly drops the "functions" segment.
    const base = fromEnv.endsWith("/") ? fromEnv : `${fromEnv}/`;
    return new URL(base, import.meta.url);
  }

  const dockerDir = new URL("./functions/", import.meta.url);
  try {
    await Deno.stat(dockerDir);
    return dockerDir;
  } catch { /* */ }

  return new URL("../supabase/functions/", import.meta.url);
}

const functionsDir = await resolveFunctionsDir();

for (const name of FUNCTIONS) {
  currentName = name;
  try {
    await import(new URL(`${name}/index.ts`, functionsDir).href);
    console.log(`[loaded] ${name}`);
  } catch (e) {
    console.error(`[load failed] ${name}:`, e);
  }
}
currentName = "";

if (handlers.size !== FUNCTIONS.length) {
  throw new Error(
    `Backend startup aborted: only ${handlers.size}/${FUNCTIONS.length} functions loaded`,
  );
}

// Restore real Deno.serve and start the gateway
// @ts-ignore
Deno.serve = originalServe;

const PORT = Number(Deno.env.get("PORT") ?? 8000);

Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);

  if (url.pathname === "/healthz") {
    const ready = handlers.size === FUNCTIONS.length;
    return new Response(JSON.stringify({
      ok: ready,
      loaded_functions: handlers.size,
      expected_functions: FUNCTIONS.length,
    }), {
      status: ready ? 200 : 503,
      headers: { "content-type": "application/json" },
    });
  }

  // Match /functions/v1/<name>[/...] (compatible with supabase.functions.invoke)
  const m = url.pathname.match(/^\/functions\/v1\/([^/]+)(\/.*)?$/);
  if (!m) {
    return new Response(JSON.stringify({ error: "not found", path: url.pathname }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  const fn = m[1];
  const handler = handlers.get(fn);
  if (!handler) {
    return new Response(JSON.stringify({ error: "function not found", fn }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  try {
    return await handler(req);
  } catch (e) {
    console.error(`[${fn}] error:`, e);
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
});

console.log(`Backend listening on :${PORT} — ${handlers.size}/${FUNCTIONS.length} functions loaded`);

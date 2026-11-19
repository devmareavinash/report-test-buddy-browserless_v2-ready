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
  "script-agent-chat",
  "bootstrap-admin",
  "playwright-runtime",
  "headless-trace",
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
const { executionHealth } = await import(new URL("_shared/backend-health.ts", functionsDir).href);

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

// Agent chat needs extra npm packages that a corporate proxy may block; it must
// not stop test execution from starting.
const OPTIONAL = new Set(["script-agent-chat", "headless-trace"]);
const missingRequired = FUNCTIONS.filter((n) => !handlers.has(n) && !OPTIONAL.has(n));
if (missingRequired.length) {
  throw new Error(
    `Backend startup aborted: failed to load ${missingRequired.join(", ")} (see [load failed] lines above)`,
  );
}
for (const n of OPTIONAL) {
  if (!handlers.has(n)) console.warn(`[warning] ${n} unavailable — see [load failed] line above`);
}

// Persist MicroStrategy login cookies around playwright-runtime without
// modifying that function — restore/capture happens in this gateway wrapper.
{
  const pw = handlers.get("playwright-runtime");
  if (pw) {
    try {
      const { withPlaywrightAuthSession } = await import(new URL("_shared/auth-session-gateway.ts", functionsDir).href);
      handlers.set("playwright-runtime", withPlaywrightAuthSession(pw));
      console.log("[wrapped] playwright-runtime auth-session reuse");
    } catch (e) {
      console.warn("[warning] auth-session gateway unavailable — playwright-runtime runs without session reuse:", e);
    }
  }
}

// Restore real Deno.serve and start the gateway
// @ts-ignore
Deno.serve = originalServe;

const PORT = Number(Deno.env.get("PORT") ?? 8000);

Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);

  if (url.pathname === "/healthz") {
    const health = executionHealth(FUNCTIONS, new Set(handlers.keys()), OPTIONAL);
    const headed = {
      HEADED_USE_LOCAL_CHROME: Deno.env.get("HEADED_USE_LOCAL_CHROME") || null,
      HEADED_LOCAL_CHANNEL: Deno.env.get("HEADED_LOCAL_CHANNEL") || null,
      HEADED_FALLBACK_HEADLESS: Deno.env.get("HEADED_FALLBACK_HEADLESS") || null,
      allow_run: true,
    };
    return new Response(JSON.stringify({ ...health, headed }), {
      status: health.ok ? 200 : 503,
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

// Schedules are rows in Postgres; nothing external (EventBridge / pg_cron) is
// wired in the ECS task. Drive due schedules from this process so "Add schedule"
// actually fires without a separate cron service.
function startScheduleTicker() {
  const enabled = (Deno.env.get("SCHEDULE_TICK_ENABLED") ?? "true").toLowerCase() !== "false";
  const intervalMs = Math.max(
    15_000,
    Number(Deno.env.get("SCHEDULE_TICK_INTERVAL_MS") ?? 60_000) || 60_000,
  );
  // Prefer explicit scheduler secret / service role. If neither is configured
  // (common in local .env), mint an ephemeral secret so the in-process ticker
  // can still authorize schedule-tick without exposing an unauthenticated route.
  let token =
    Deno.env.get("SCHEDULE_TICK_SECRET") ||
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
    "";
  if (!token) {
    token = crypto.randomUUID();
    Deno.env.set("SCHEDULE_TICK_SECRET", token);
    console.warn("[schedule-tick] minted ephemeral SCHEDULE_TICK_SECRET for in-process ticker only");
  }
  const tickHandler = handlers.get("schedule-tick");
  if (!enabled) {
    console.log("[schedule-tick] ticker disabled (SCHEDULE_TICK_ENABLED=false)");
    return;
  }
  if (!tickHandler) {
    console.warn("[schedule-tick] handler missing — ticker not started");
    return;
  }

  let inFlight = false;
  const tick = async (reason: string) => {
    if (inFlight) return;
    inFlight = true;
    try {
      const req = new Request(`http://127.0.0.1:${PORT}/functions/v1/schedule-tick`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      const res = await tickHandler(req);
      const body = await res.json().catch(() => ({} as Record<string, unknown>));
      const fired = Array.isArray(body.fired) ? body.fired : [];
      const skipped = Array.isArray(body.skipped) ? body.skipped : [];
      console.log(JSON.stringify({
        component: "schedule-ticker",
        event: "tick",
        reason,
        http_status: res.status,
        fired: fired.length,
        skipped: skipped.length,
        fired_scopes: fired.map((f: any) => f.scope).slice(0, 10),
        skipped_sample: skipped.slice(0, 5),
      }));
      // #region agent log
      fetch("http://127.0.0.1:7601/ingest/7fea574a-90a5-4c13-82f0-235afdf7c6c7", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "b772b1" },
        body: JSON.stringify({
          sessionId: "b772b1",
          runId: "schedule-ticker",
          hypothesisId: "TICKER",
          location: "backend/server.ts:startScheduleTicker",
          message: "schedule ticker fired",
          data: {
            reason,
            http_status: res.status,
            fired: fired.length,
            skipped: skipped.length,
            fired_scopes: fired.map((f: any) => f.scope).slice(0, 10),
            skipped_sample: skipped.slice(0, 8),
          },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion
    } catch (e) {
      console.error("[schedule-tick] ticker error:", e);
    } finally {
      inFlight = false;
    }
  };

  console.log(`[schedule-tick] ticker enabled — every ${intervalMs}ms (first catch-up in 5s)`);
  setTimeout(() => void tick("startup"), 5_000);
  setInterval(() => void tick("interval"), intervalMs);
}

startScheduleTicker();

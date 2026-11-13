import { getSupabaseForRequest, requireAuth } from "../_shared/auth.ts";
import { corsHeaders } from "../_shared/cors.ts";

type Step = { sequence: number; timestamp: string; step: string; state: string; elapsed_ms: number };
const sessions = new Map<string, { owner: string; capability: string; expires: number; steps: Step[] }>();
const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
});
async function ownerOf(req: Request) {
  const { data, error } = await getSupabaseForRequest(req).auth.getUser();
  if (error || !data?.user?.id) return null;
  return data.user.id;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  // The collector is process-local: hosted Edge cannot guarantee shared instances.
  if (typeof (globalThis as any).EdgeRuntime !== "undefined") return respond({ error: "Step collection requires the self-hosted backend" }, 409);
  for (const [id, session] of sessions) if (session.expires < Date.now()) sessions.delete(id);
  const url = new URL(req.url);
  const id = url.searchParams.get("id") || "";
  const capability = url.searchParams.get("capability");
  if (req.method === "POST" && capability) {
    const session = sessions.get(id);
    if (!session || session.capability !== capability) return respond({ error: "Trace expired" }, 404);
    const event = await req.json().catch(() => null);
    if (!event || !Number.isSafeInteger(event.sequence) || event.sequence < 1 ||
        typeof event.step !== "string" || !/^[a-zA-Z0-9_$]+ · line [0-9]+$/.test(event.step) ||
        event.step.length > 90 || !["start", "complete", "error", "waiting"].includes(event.state) ||
        typeof event.timestamp !== "string" || !Number.isFinite(Date.parse(event.timestamp)) ||
        typeof event.elapsed_ms !== "number" || !Number.isFinite(event.elapsed_ms) || event.elapsed_ms < 0) {
      return respond({ error: "Invalid step" }, 400);
    }
    if (session.steps.length < 4000) {
      const correlation = Object.fromEntries(["scenario_id", "run_id", "combo_id", "browser_job_id", "script_version", "script_hash"].filter(key => /^[a-zA-Z0-9_-]{1,80}$/.test(String(event[key] || ""))).map(key => [key, event[key]]));
      const step = { ...correlation, sequence: event.sequence, timestamp: event.timestamp, step: event.step, state: event.state, elapsed_ms: event.elapsed_ms };
      session.steps.push(step);
      console.log(JSON.stringify({ component: "headless-step", trace_id: id, ...step }));
    }
    return respond({ ok: true });
  }
  const denied = await requireAuth(req);
  if (denied) return denied;
  const owner = await ownerOf(req);
  if (!owner) return respond({ error: "Trace unavailable" }, 401);
  if (req.method === "POST") {
    if ([...sessions.values()].filter(session => session.owner === owner).length >= 5) return respond({ error: "Trace capacity reached" }, 429);
    if (sessions.size >= 100) return respond({ error: "Trace capacity reached" }, 429);
    const newId = crypto.randomUUID();
    const secret = crypto.randomUUID();
    sessions.set(newId, { owner, capability: secret, expires: Date.now() + 20 * 60 * 1000, steps: [] });
    const port = Deno.env.get("PORT") || "8000";
    const defaultBase = (Deno.env.get("BROWSERLESS_HOST") || "").includes("browserless") ? `http://backend:${port}` : `http://127.0.0.1:${port}`;
    const base = (Deno.env.get("HEADLESS_TRACE_CALLBACK_BASE_URL") || defaultBase).replace(/\/$/, "");
    return respond({ id: newId, callback_url: `${base}/functions/v1/headless-trace?id=${newId}&capability=${secret}` });
  }
  if (req.method === "GET") {
    const session = sessions.get(id);
    if (!session || session.owner !== owner) return respond({ error: "Trace unavailable" }, 404);
    return respond({ steps: [...session.steps].sort((a, b) => a.sequence - b.sequence) });
  }
  return respond({ error: "Method not allowed" }, 405);
});
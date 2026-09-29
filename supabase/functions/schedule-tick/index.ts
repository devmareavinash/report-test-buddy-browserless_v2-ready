import { corsHeaders } from "../_shared/cors.ts";
import { getSupabase } from "../_shared/llm.ts";
import cronParser from "npm:cron-parser@4.9.0";
import { resolveFunctionAuth, resolveFunctionUrl } from "../_shared/internal-functions.ts";

async function fireRun(scope_type: string, scope_id: string, schedule_id: string) {
  const r = await fetch(resolveFunctionUrl("agent-orchestrate"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: resolveFunctionAuth("agent-orchestrate"),
    },
    body: JSON.stringify({ scope_type, scope_id, trigger_source: "schedule", schedule_id }),
  });
  return r.ok;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const sb = getSupabase();
    const now = new Date();
    const { data: schedules } = await sb.from("schedules").select("*").eq("enabled", true);
    const fired: any[] = [];
    const skipped: any[] = [];

    for (const s of schedules || []) {
      try {
        const baseline = s.last_run_at ? new Date(s.last_run_at) : new Date(s.created_at);
        const tz = s.timezone || "UTC";
        const it = tz === "UTC"
          ? cronParser.parseExpression(s.cron, { currentDate: now, utc: true })
          : cronParser.parseExpression(s.cron, { currentDate: now, tz });
        const prev = it.prev().toDate();
        if (prev > baseline) {
          if (!["workstream", "report"].includes(s.scope_type) || !s.scope_id) {
            skipped.push({ id: s.id, reason: "invalid_scope" });
            continue;
          }
          // Atomically CLAIM the schedule BEFORE firing to prevent duplicate runs
          // when schedule-tick is invoked twice (cold-start, retry, parallel cron).
          // The .eq("last_run_at", ...) filter ensures only one claimant succeeds.
          const claimQuery = sb.from("schedules")
            .update({ last_run_at: now.toISOString() })
            .eq("id", s.id);
          const { data: claimed, error: claimErr } = s.last_run_at
            ? await claimQuery.eq("last_run_at", s.last_run_at).select("id")
            : await claimQuery.is("last_run_at", null).select("id");
          if (claimErr || !claimed || claimed.length === 0) {
            skipped.push({ id: s.id, reason: "already_claimed" });
            continue;
          }
          const ok = await fireRun(s.scope_type, s.scope_id, s.id);
          fired.push({ id: s.id, scope: `${s.scope_type}:${s.scope_id}`, cron: s.cron, ok });
        } else {
          skipped.push({ id: s.id, reason: "not_due", prev: prev.toISOString(), baseline: baseline.toISOString() });
        }
      } catch (e) {
        skipped.push({ id: s.id, reason: "error", error: String(e) });
      }
    }

    return new Response(JSON.stringify({ ok: true, now: now.toISOString(), fired, skipped }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

import { corsHeaders } from "../_shared/cors.ts";
import { requireAuth } from "../_shared/auth.ts";
import { callAgent, getSupabase, tryParseJson } from "../_shared/llm.ts";
import { fetchCanonicalScript } from "../_shared/canonical-script.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const unauthorized = await requireAuth(req);
  if (unauthorized) return unauthorized;
  try {
    const { test_result_id } = await req.json();
    const sb = getSupabase();
    const { data: tr } = await sb.from("test_results").select("*, scenarios(*, reports(*))").eq("id", test_result_id).maybeSingle();
    if (!tr) throw new Error("not found");
    const { data: script } = await fetchCanonicalScript(sb, tr.scenario_id);

    const sys = "You are a healing agent for BI test scripts. Propose a minimal patch. Reply JSON {patched_assertion_spec:{...}, patched_playwright_code:'...', rationale:'...'}.";
    const user = `Failure: ${JSON.stringify({ expected: tr.expected, actual: tr.actual, diff: tr.diff, analysis: tr.analysis })}\nCurrent script: ${JSON.stringify(script)}`;
    const raw = await callAgent({ agentKey: "heal", messages: [{ role: "system", content: sys }, { role: "user", content: user }], json: true });
    const parsed = tryParseJson(raw) || {};

    await sb.from("test_results").update({
      healing_proposal: parsed,
      healing_status: "proposed",
    }).eq("id", test_result_id);

    return new Response(JSON.stringify({ proposal: parsed }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});

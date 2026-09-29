import { corsHeaders } from "../_shared/cors.ts";
import { requireAuth } from "../_shared/auth.ts";
import { callAgent, getSupabase, tryParseJson } from "../_shared/llm.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const unauthorized = await requireAuth(req);
  if (unauthorized) return unauthorized;
  try {
    const { test_result_id } = await req.json();
    const sb = getSupabase();
    const { data: tr } = await sb.from("test_results").select("*, scenarios(title, type, report_id)").eq("id", test_result_id).maybeSingle();
    if (!tr) throw new Error("not found");

    // Memory lookup for ranking
    const { data: mem } = await sb.from("note_memory").select("*").eq("scenario_id", tr.scenario_id);
    const ignoreWeight = (mem || []).filter((m) => m.decision === "ignore_future").reduce((a, b) => a + Number(b.weight), 0);

    const sys = "You are a BI failure analyst. Reply JSON {analysis:'...', severity:'low|medium|high|critical'}.";
    const user = `Scenario: ${tr.scenarios?.title}\nExpected: ${JSON.stringify(tr.expected)}\nActual: ${JSON.stringify(tr.actual)}\nDiff: ${JSON.stringify(tr.diff)}\nKnown ignore-weight: ${ignoreWeight}`;
    const raw = await callAgent({ agentKey: "analyze", messages: [{ role: "system", content: sys }, { role: "user", content: user }], json: true });
    const parsed = tryParseJson(raw) || {};
    const sevMap: any = { low: 1, medium: 2, high: 3, critical: 4 };
    const rank = (sevMap[parsed.severity] || 2) - ignoreWeight;

    await sb.from("test_results").update({
      analysis: parsed.analysis || raw,
      severity: parsed.severity || "medium",
      rank_score: Math.max(0, rank),
    }).eq("id", test_result_id);

    return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});

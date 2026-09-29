import { corsHeaders } from "../_shared/cors.ts";
import { getSupabase } from "../_shared/llm.ts";
import { resolveFunctionAuth, resolveFunctionUrl } from "../_shared/internal-functions.ts";

async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const auth = req.headers.get("Authorization") || "";
    const token = auth.replace(/^Bearer\s+/i, "");
    if (!token) return new Response(JSON.stringify({ error: "missing token" }), { status: 401, headers: corsHeaders });
    const sb = getSupabase();
    const hash = await sha256(token);
    const { data: tok } = await sb.from("api_tokens").select("*").eq("token_hash", hash).maybeSingle();
    if (!tok) return new Response(JSON.stringify({ error: "invalid token" }), { status: 401, headers: corsHeaders });
    await sb.from("api_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", tok.id);

    const body = await req.json();
    const { scope_type, scope_id } = body;
    if (!["workstream", "report"].includes(scope_type)) {
      return new Response(JSON.stringify({ error: "scope_type must be workstream|report" }), { status: 400, headers: corsHeaders });
    }

    // Enforce token scope binding if present
    const scopes: any = tok.scopes || {};
    if (scopes.scope_type && (scopes.scope_type !== scope_type || (scopes.scope_id && scopes.scope_id !== scope_id))) {
      return new Response(JSON.stringify({ error: "token not authorized for this scope" }), { status: 403, headers: corsHeaders });
    }

    const r = await fetch(resolveFunctionUrl("agent-orchestrate"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: resolveFunctionAuth("agent-orchestrate"),
      },
      body: JSON.stringify({ scope_type, scope_id, trigger_source: "api" }),
    });
    const data = await r.json();
    return new Response(JSON.stringify(data), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});

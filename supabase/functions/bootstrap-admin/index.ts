import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

// Bootstrap the FIRST admin user. Only succeeds when no users exist yet.
// Two modes:
//   { seed: true }              → creates default admin@admin.com / admin
//   { email, password }         → creates a custom admin (password >= 12)
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const body = await req.json().catch(() => ({}));
    if (body?.seed === true) {
      return new Response(
        JSON.stringify({ error: "seed mode disabled — provide an email and a strong password instead" }),
        { status: 410, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    const explicitProbe = body?.probe === true;
    const hasCreds = Boolean(body?.email || body?.password);
    const isProbe = explicitProbe || !hasCreds;

    // Refuse if any users already exist — bootstrap is a one-shot.
    const { data: list } = await sb.auth.admin.listUsers({ page: 1, perPage: 1 });
    if (list && list.users.length > 0) {
      if (isProbe) {
        return new Response(
          JSON.stringify({ ok: true, status: "already-initialized" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({ ok: false, status: "already-initialized" }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Probe mode: empty body → just report status without erroring.
    if (isProbe) {
      return new Response(
        JSON.stringify({ ok: true, status: "uninitialized" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const email = (body?.email || "").toString().trim().toLowerCase();
    const password = (body?.password || "").toString();

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return new Response(JSON.stringify({ error: "valid email required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (password.length < 12) {
      return new Response(
        JSON.stringify({ error: "password must be at least 12 characters" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data: created, error: createErr } = await sb.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (createErr) throw createErr;
    const userId = created!.user!.id;

    await sb.from("user_roles").insert({ user_id: userId, role: "admin" });

    return new Response(
      JSON.stringify({ ok: true, status: "created", email }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS, DELETE, PATCH",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

async function requireAdmin(req: Request) {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) throw new Error("Missing auth");
  const userClient = createClient(SUPABASE_URL, ANON, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: u, error } = await userClient.auth.getUser();
  if (error || !u?.user) throw new Error("Invalid auth");
  // Check the admin role through the caller's own session (RLS lets users read their roles).
  const { data: roles, error: rolesErr } = await userClient
    .from("user_roles")
    .select("role")
    .eq("user_id", u.user.id);
  if (rolesErr) throw new Error(`Could not read your roles: ${rolesErr.message}`);
  if (!(roles || []).some((r) => r.role === "admin")) throw new Error("Admin required");
  if (!SERVICE_ROLE) {
    throw Object.assign(new Error("User management needs the backend admin key (SUPABASE_SERVICE_ROLE_KEY) on this server"), { status: 503 });
  }
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
  return { admin, currentUserId: u.user.id };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const { admin } = await requireAdmin(req);
    const url = new URL(req.url);
    const action = url.searchParams.get("action") || "list";

    if (req.method === "GET" || action === "list") {
      const { data: list, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
      if (error) throw error;
      const ids = list.users.map((u) => u.id);
      const { data: roles, error: rolesError } = await admin
        .from("user_roles")
        .select("user_id, role")
        .in("user_id", ids);
      if (rolesError) throw rolesError;
      const roleMap = new Map<string, string[]>();
      for (const r of roles || []) {
        const arr = roleMap.get(r.user_id) || [];
        arr.push(r.role);
        roleMap.set(r.user_id, arr);
      }
      const users = list.users.map((u) => ({
        id: u.id,
        email: u.email,
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at,
        roles: roleMap.get(u.id) || [],
      }));
      return new Response(JSON.stringify({ users }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));

    if (action === "create") {
      const { email, password, role } = body;
      if (!email || !password) throw new Error("email + password required");
      if (typeof password !== "string" || password.length < 12) throw new Error("password must be at least 12 characters");
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (error) throw error;
      const userId = data.user.id;
      // Trigger inserts 'user' role automatically; if admin requested, add admin role too.
      if (role === "admin") {
        const { error: roleError } = await admin.from("user_roles").insert({ user_id: userId, role: "admin" });
        if (roleError) throw new Error("Account created, but admin role could not be saved. Retry assigning the role.");
      }
      return new Response(JSON.stringify({ ok: true, user_id: userId }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "set-role") {
      const { user_id, role, enable } = body;
      if (!user_id || !role) throw new Error("user_id + role required");
      if (!["admin", "user"].includes(role) || typeof enable !== "boolean") throw new Error("Invalid role change");
      if (enable) {
        const { error } = await admin.from("user_roles").upsert({ user_id, role }, { onConflict: "user_id,role" });
        if (error) throw error;
      } else {
        const { error } = await admin.from("user_roles").delete().eq("user_id", user_id).eq("role", role);
        if (error) throw error;
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "reset-password") {
      const { user_id, password } = body;
      if (!user_id || !password) throw new Error("user_id + password required");
      if (typeof password !== "string" || password.length < 12) throw new Error("password must be at least 12 characters");
      const { error } = await admin.auth.admin.updateUserById(user_id, { password });
      if (error) throw error;
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "delete") {
      const { user_id } = body;
      if (!user_id) throw new Error("user_id required");
      const { error } = await admin.auth.admin.deleteUser(user_id);
      if (error) throw error;
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    throw new Error(`unknown action: ${action}`);
  } catch (e) {
    const status = (e as any)?.status ?? (`${e}`.toLowerCase().includes("admin required") ? 403 : 400);
    return new Response(JSON.stringify({ error: String(e) }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

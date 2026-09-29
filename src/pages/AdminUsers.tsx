import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { invokeFunction } from "@/lib/functions";
import { AppLayout } from "@/components/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Plus, Trash2, KeyRound } from "lucide-react";

export default function AdminUsers() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["admin-users"],
    queryFn: async () => {
      const { data, error } = await invokeFunction("admin-users", {});
      if (error) throw error;
      return data?.users ?? [];
    },
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["admin-users"] });

  const setRole = async (user_id: string, role: string, enable: boolean) => {
    const { error } = await invokeFunction(`admin-users?action=set-role`, { user_id, role, enable });
    if (error) return toast.error(error.message);
    toast.success("Role updated");
    refresh();
  };

  const del = async (user_id: string, email: string) => {
    if (!confirm(`Delete ${email}?`)) return;
    const { error } = await invokeFunction(`admin-users?action=delete`, { user_id });
    if (error) return toast.error(error.message);
    toast.success("User deleted");
    refresh();
  };

  return (
    <AppLayout>
      <div className="p-8 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Users</h1>
            <p className="text-sm text-muted-foreground">Create accounts, reset passwords, manage admin role.</p>
          </div>
          <CreateUserDialog onCreated={refresh} />
        </div>

        <Card>
          <CardHeader><CardTitle>{(data || []).length} users</CardTitle></CardHeader>
          <CardContent className="space-y-1">
            {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
            {(data || []).map((u: any) => (
              <div key={u.id} className="flex items-center gap-3 p-3 border border-border rounded-md">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{u.email}</div>
                  <div className="text-xs text-muted-foreground mono">
                    last seen {u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleString() : "never"}
                  </div>
                </div>
                <div className="flex flex-wrap gap-1">
                  {(u.roles || []).map((r: string) => (
                    <Badge key={r} variant="outline" className="mono text-[10px] uppercase">{r}</Badge>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <Label htmlFor={`adm-${u.id}`} className="text-xs">Admin</Label>
                  <Switch
                    id={`adm-${u.id}`}
                    checked={(u.roles || []).includes("admin")}
                    onCheckedChange={(v) => setRole(u.id, "admin", v)}
                  />
                </div>
                <ResetPasswordDialog userId={u.id} email={u.email} />
                <Button size="icon" variant="ghost" onClick={() => del(u.id, u.email)}>
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            ))}
            {!isLoading && !data?.length && <div className="text-sm text-muted-foreground">No users.</div>}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}

function CreateUserDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [admin, setAdmin] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!email || !password) return toast.error("Email + password required");
    if (password.length < 12) return toast.error("Password must be at least 12 characters");
    setBusy(true);
    try {
      const { error } = await invokeFunction("admin-users?action=create", { email, password, role: admin ? "admin" : "user" });
      if (error) throw error;
      toast.success("User created");
      setOpen(false); setEmail(""); setPassword(""); setAdmin(false);
      onCreated();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus className="h-4 w-4 mr-1" /> Create user</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>New user</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Input placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <div className="flex items-center gap-2">
            <Switch id="ca" checked={admin} onCheckedChange={setAdmin} />
            <Label htmlFor="ca">Make admin</Label>
          </div>
        </div>
        <DialogFooter><Button onClick={submit} disabled={busy}>{busy ? "Creating…" : "Create"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResetPasswordDialog({ userId, email }: { userId: string; email: string }) {
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (pw.length < 12) return toast.error("Password must be at least 12 characters");
    setBusy(true);
    try {
      const { error } = await invokeFunction("admin-users?action=reset-password", { user_id: userId, password: pw });
      if (error) throw error;
      toast.success("Password reset");
      setOpen(false); setPw("");
    } catch (e: any) {
      toast.error(e.message);
    } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="icon" variant="ghost" title="Reset password"><KeyRound className="h-4 w-4" /></Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Reset password — {email}</DialogTitle></DialogHeader>
        <Input placeholder="New password" type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
        <DialogFooter><Button onClick={submit} disabled={busy}>{busy ? "Saving…" : "Reset"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

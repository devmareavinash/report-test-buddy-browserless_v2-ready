import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useTheme } from "@/contexts/ThemeContext";
import { AppLayout } from "@/components/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Moon, Sun } from "lucide-react";
import { toast } from "sonner";

export default function Profile() {
  const { user, roles, signOut } = useAuth();
  const { theme, setTheme } = useTheme();
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const updatePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pw.length < 12) return toast.error("Password must be at least 12 characters");
    if (pw !== confirm) return toast.error("Passwords don't match");
    setBusy(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: pw });
      if (error) throw error;
      toast.success("Password updated");
      setPw("");
      setConfirm("");
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppLayout>
      <div className="p-8 max-w-2xl space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Profile</h1>
          <p className="text-sm text-muted-foreground">Your account and password.</p>
        </div>

        <Card>
          <CardHeader><CardTitle className="text-base">Account</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div><span className="text-muted-foreground">Email:</span> {user?.email}</div>
            <div><span className="text-muted-foreground">Roles:</span> {roles.join(", ") || "—"}</div>
            <div><span className="text-muted-foreground">User ID:</span> <span className="mono text-xs">{user?.id}</span></div>
            <Button variant="outline" size="sm" onClick={signOut}>Sign out</Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Appearance</CardTitle></CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {theme === "dark" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
                <div>
                  <div className="text-sm font-medium">Dark mode</div>
                  <div className="text-xs text-muted-foreground">Toggle between light and dark themes.</div>
                </div>
              </div>
              <Switch
                checked={theme === "dark"}
                onCheckedChange={(checked) => setTheme(checked ? "dark" : "light")}
                aria-label="Toggle dark mode"
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Change password</CardTitle></CardHeader>
          <CardContent>
            <form onSubmit={updatePassword} className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="pw">New password</Label>
                <Input id="pw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="cp">Confirm</Label>
                <Input id="cp" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
              </div>
              <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Update password"}</Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}

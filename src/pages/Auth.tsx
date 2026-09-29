import { useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { invokeFunction } from "@/lib/functions";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export default function Auth() {
  const { user, loading } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [needsBootstrap, setNeedsBootstrap] = useState(false);
  const [checkingBootstrap, setCheckingBootstrap] = useState(true);

  // Detect whether bootstrap is needed without surfacing bootstrap errors as sign-in failures.
  useEffect(() => {
    (async () => {
      try {
        const { data, error } = await invokeFunction("bootstrap-admin", { probe: true });
        if (error) throw error;
        const dataStatus = (data as any)?.status;
        if (dataStatus === "uninitialized") {
          setNeedsBootstrap(true);
        } else if (dataStatus === "already-initialized") {
          setNeedsBootstrap(false);
        }
      } catch {
        /* ignore */
      } finally {
        setCheckingBootstrap(false);
      }
    })();
  }, []);

  if (!loading && user) return <Navigate to="/" replace />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (needsBootstrap) {
        if (password.length < 12) throw new Error("Password must be at least 12 characters");
        const { error } = await invokeFunction("bootstrap-admin", { email, password });
        if (error) throw error;
        toast.success("Admin created — signing in…");
      }
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      toast.success("Signed in");
      nav("/", { replace: true });
    } catch (err: any) {
      toast.error(err.message || "Sign in failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-xl">
            {needsBootstrap ? "Create initial admin" : "Sign in"}
          </CardTitle>
          {needsBootstrap && (
            <p className="text-xs text-muted-foreground">
              No users exist yet. Choose an admin email and a strong password (min 12 chars).
            </p>
          )}
        </CardHeader>
        <CardContent>
          {checkingBootstrap ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <form onSubmit={submit} className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  minLength={needsBootstrap ? 12 : 1}
                  required
                />
              </div>
              <Button type="submit" disabled={busy} className="w-full">
                {busy ? "Working…" : needsBootstrap ? "Create admin & sign in" : "Sign in"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

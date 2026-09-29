import { Navigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";

export function ProtectedRoute({ children, adminOnly }: { children: React.ReactNode; adminOnly?: boolean }) {
  const { user, isAdmin, loading } = useAuth();
  if (loading) {
    return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;
  }
  if (!user) return <Navigate to="/auth" replace />;
  if (adminOnly && !isAdmin) return <Navigate to="/" replace />;
  return <>{children}</>;
}

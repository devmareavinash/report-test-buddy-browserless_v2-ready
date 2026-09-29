import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

type Ctx = {
  user: User | null;
  session: Session | null;
  roles: string[];
  isAdmin: boolean;
  loading: boolean;
  refreshRoles: () => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthCtx = createContext<Ctx>({
  user: null,
  session: null,
  roles: [],
  isAdmin: false,
  loading: true,
  refreshRoles: async () => {},
  signOut: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const loadRoles = async (uid: string | null) => {
    if (!uid) return setRoles([]);
    const { data } = await supabase.from("user_roles").select("role").eq("user_id", uid);
    setRoles((data || []).map((r: any) => r.role));
  };

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((event, sess) => {
      // TOKEN_REFRESHED can briefly report a null session on this VDI. Keep
      // the current user so ProtectedRoute does not bounce to /auth.
      if (event === "TOKEN_REFRESHED" && !sess) return;
      setSession(sess);
      setUser(sess?.user ?? null);
      setTimeout(() => loadRoles(sess?.user?.id ?? null), 0);
    });
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      loadRoles(session?.user?.id ?? null).finally(() => setLoading(false));
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  return (
    <AuthCtx.Provider
      value={{
        user,
        session,
        roles,
        isAdmin: roles.includes("admin"),
        loading,
        refreshRoles: () => loadRoles(user?.id ?? null),
        signOut: async () => {
          await supabase.auth.signOut();
        },
      }}
    >
      {children}
    </AuthCtx.Provider>
  );
}

export const useAuth = () => useContext(AuthCtx);

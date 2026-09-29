import { ReactNode } from "react";
import logo from "@/assets/logo.png";
import { NavLink } from "@/components/NavLink";
import { useAuth } from "@/contexts/AuthContext";
import { Activity, FileText, Settings, Bug, FlaskConical, Database, Users, UserCircle, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";

export const AppLayout = ({ children }: { children: ReactNode }) => {
  const { user, isAdmin, signOut } = useAuth();
  return (
    <div className="min-h-screen flex bg-background">
      <aside className="dark w-56 border-r border-border bg-sidebar text-sidebar-foreground p-4 flex flex-col gap-1">
        <div className="px-3 py-4 flex items-center gap-2">
          <img src={logo} alt="Agentic Frontend Validations logo" width={32} height={32} className="h-8 w-8" />
          <div>
            <div className="text-sm font-semibold tracking-tight leading-tight">Agentic Frontend<br/>Validations</div>
            <div className="text-[10px] text-muted-foreground mono">agentic report QA</div>
          </div>
        </div>
        <NavLink to="/" icon={<Activity className="h-4 w-4" />}>Dashboard</NavLink>
        <NavLink to="/reports" icon={<FileText className="h-4 w-4" />}>Screens</NavLink>
        <NavLink to="/scenarios" icon={<FlaskConical className="h-4 w-4" />}>Tests execution status</NavLink>
        <NavLink to="/runs" icon={<Bug className="h-4 w-4" />}>Runs</NavLink>
        <NavLink to="/sql-templates" icon={<Database className="h-4 w-4" />}>SQL templates</NavLink>
        <div className="mt-auto space-y-1">
          {user && (
            <div className="px-3 py-2 text-xs text-muted-foreground truncate" title={user.email || ""}>
              {user.email}
            </div>
          )}
          <NavLink to="/profile" icon={<UserCircle className="h-4 w-4" />}>Profile</NavLink>
          {isAdmin && (
            <>
              <NavLink to="/admin/users" icon={<Users className="h-4 w-4" />}>Users</NavLink>
              <NavLink to="/settings" icon={<Settings className="h-4 w-4" />}>Settings</NavLink>
            </>
          )}
          {user && (
            <Button
              onClick={signOut}
              variant="ghost"
              size="sm"
              className="w-full justify-start text-muted-foreground"
            >
              <LogOut className="h-4 w-4 mr-2" /> Sign out
            </Button>
          )}
        </div>
      </aside>
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
};

import { NavLink as RRNavLink } from "react-router-dom";
import { ReactNode } from "react";
import { cn } from "@/lib/utils";

export const NavLink = ({ to, children, icon }: { to: string; children: ReactNode; icon?: ReactNode }) => (
  <RRNavLink
    to={to}
    end={to === "/"}
    className={({ isActive }) =>
      cn(
        "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
        isActive ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
      )
    }
  >
    {icon}
    {children}
  </RRNavLink>
);

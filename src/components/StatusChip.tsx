import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export const StatusChip = ({
  status,
  label,
}: {
  status?: string | null;
  /** Optional display text (keeps color keyed off `status`). */
  label?: string | null;
}) => {
  const map: Record<string, string> = {
    pass: "bg-success/15 text-success border-success/30",
    fail: "bg-destructive/15 text-destructive border-destructive/30",
    pending: "bg-muted text-muted-foreground border-border",
    running: "bg-accent/15 text-accent border-accent/30",
    completed: "bg-success/15 text-success border-success/30",
    failed: "bg-destructive/15 text-destructive border-destructive/30",
    cancelled: "bg-muted text-muted-foreground border-border",
    not_started: "bg-amber-100 text-amber-800 border-amber-400/50 dark:bg-amber-400/15 dark:text-amber-200",
    blocked: "bg-amber-100 text-amber-800 border-amber-400/50 dark:bg-amber-400/15 dark:text-amber-200",
    infrastructure_blocked: "bg-amber-100 text-amber-800 border-amber-400/50 dark:bg-amber-400/15 dark:text-amber-200",
    error: "bg-destructive/15 text-destructive border-destructive/30",
    partial_extraction: "bg-destructive/15 text-destructive border-destructive/30",
    auth_failure: "bg-destructive/15 text-destructive border-destructive/30",
    browserless_timeout: "bg-destructive/15 text-destructive border-destructive/30",
    empty_extraction: "bg-destructive/15 text-destructive border-destructive/30",
  };
  const colorKey = String(status || "pending").toLowerCase();
  const text = label != null && String(label).trim() ? label : (status || "—");
  return (
    <Badge variant="outline" className={cn("mono uppercase text-[10px]", map[colorKey] || map.pending)}>
      {text}
    </Badge>
  );
};

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export const StatusChip = ({ status }: { status?: string | null }) => {
  const map: Record<string, string> = {
    pass: "bg-success/15 text-success border-success/30",
    fail: "bg-destructive/15 text-destructive border-destructive/30",
    pending: "bg-muted text-muted-foreground border-border",
    running: "bg-accent/15 text-accent border-accent/30",
    completed: "bg-success/15 text-success border-success/30",
    error: "bg-destructive/15 text-destructive border-destructive/30",
  };
  return <Badge variant="outline" className={cn("mono uppercase text-[10px]", map[status || "pending"])}>{status || "—"}</Badge>;
};

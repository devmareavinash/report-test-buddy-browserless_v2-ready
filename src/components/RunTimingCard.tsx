import { useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronUp, Eye } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { collectAttempts, formatMs, formatMsLong, summarizeRunTiming, type RunTiming } from "@/lib/runTiming";

type Kpi = { label: string; meaning: string; value: (t: RunTiming) => string };
const ms = (f: (t: RunTiming) => number) => (t: RunTiming) => formatMs(f(t));

const TOOL_KPIS: Kpi[] = [
  { label: "Tool time (total)", meaning: "All time the testing tool spent outside the report. Equals launch + result return + orchestration/queue.", value: ms(t => t.tool_ms) },
  { label: "Browser launch time", meaning: "From the start of each browser call until the report script begins: connecting and launching the browser.", value: ms(t => t.tool_parts.launch) },
  { label: "Result return time", meaning: "From the end of the report script until the browser call returns its results.", value: ms(t => t.tool_parts.return) },
  { label: "Orchestration / queue time", meaning: "Time outside any browser call: queueing, saving results and gaps between attempts.", value: ms(t => t.tool_parts.queue) },
  { label: "Launch attempts", meaning: "Number of browser attempts started (first tries plus retries). A count, not added to time.", value: t => String(t.launch_attempts) },
  { label: "Retry launches", meaning: "Number of attempts that were retries. A count, not added to time.", value: t => String(t.retry_count) },
];
const REPORT_KPIS: Kpi[] = [
  { label: "Report time (total)", meaning: "All time the browser spent inside the report. Equals the sum of the report steps below. Also called browser waiting time.", value: ms(t => t.report_ms) },
  { label: "Login", meaning: "Signing in to the report.", value: ms(t => t.report_parts.login) },
  { label: "Report load", meaning: "Opening and navigating to the report.", value: ms(t => t.report_parts.load) },
  { label: "Apply filters", meaning: "Selecting and applying filters.", value: ms(t => t.report_parts.filters) },
  { label: "Data load", meaning: "Waiting for report data and visuals to be ready.", value: ms(t => t.report_parts.data_ready) },
  { label: "Read values", meaning: "Extracting the values being compared.", value: ms(t => t.report_parts.extract) },
  { label: "Other report waiting", meaning: "Time inside the report between the named steps above.", value: ms(t => t.report_parts.other) },
  { label: "Waiting without step detail", meaning: "Attempts that returned no step timing (for example crashed or timed out early); all of their time is counted here.", value: ms(t => t.report_parts.no_detail) },
  { label: "Attempt waiting time (retries)", meaning: "Part of Report time spent inside retried attempts. Already included above, not added again.", value: ms(t => t.report_retry_wait_ms) },
];

function KpiList({ title, kpis, t }: { title: string; kpis: Kpi[]; t: RunTiming }) {
  return (
    <div className="space-y-1">
      <div className="font-medium text-xs">{title}</div>
      {kpis.map((k, i) => (
        <div key={k.label} className={`flex items-center justify-between gap-2 text-xs ${i === 0 ? "font-medium" : ""}`}>
          <span className="flex items-center gap-1 text-muted-foreground">
            {k.label}
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" aria-label={`What is ${k.label}?`} className="inline-flex text-muted-foreground hover:text-foreground"><Eye className="h-3 w-3" /></button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">{k.meaning}</TooltipContent>
            </Tooltip>
          </span>
          <span>{k.value(t)}</span>
        </div>
      ))}
    </div>
  );
}

export function RunTimingCard({ run, results }: { run: any; results: any[] }) {
  const [open, setOpen] = useState(false);
  const timing = useMemo(() => {
    const attempts = collectAttempts(results || []);
    if (!attempts.length) return null;
    const start = run?.started_at ? Date.parse(run.started_at) : Date.parse(attempts[0].started_at);
    const end = run?.finished_at ? Date.parse(run.finished_at) : Date.now();
    return summarizeRunTiming(attempts, Math.max(0, end - start), start);
  }, [run?.started_at, run?.finished_at, results]);

  if (!timing) {
    return (
      <Card><CardContent className="p-3 text-sm text-muted-foreground">
        {run?.status === "running"
          ? "Timing will appear here once a test result is saved. This run is still in progress."
          : "Timing is unavailable for this run because no timing data was saved."}
      </CardContent></Card>
    );
  }
  const pct = (ms: number) => (timing.wall_ms ? Math.round((ms / timing.wall_ms) * 100) : 0);

  return (
    <Card>
      <CardContent className="p-3 space-y-3 text-sm">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 overflow-x-auto whitespace-nowrap text-xs sm:text-sm flex items-center gap-4">
            <span className="font-medium text-blue-600 dark:text-blue-400">
              Total Execution Time - {formatMsLong(timing.wall_ms)}
            </span>
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm bg-accent" aria-hidden />
              Tool Time - <span className="font-medium text-foreground">{formatMsLong(timing.tool_ms)}</span>
            </span>
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm bg-primary" aria-hidden />
              Report Time - <span className="font-medium text-foreground">{formatMsLong(timing.report_ms)}</span>
            </span>
          </div>
          <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => setOpen(!open)} aria-label={open ? "Hide timing details" : "Show timing details"} aria-expanded={open} title={open ? "Hide timing details" : "Show timing details"}>
            {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </Button>
        </div>
        {open && <>
        <div className="flex h-2 w-full overflow-hidden rounded bg-muted">
          <div className="bg-accent" style={{ width: `${pct(timing.tool_ms)}%` }} title="Tool time" />
          <div className="bg-primary" style={{ width: `${pct(timing.report_ms)}%` }} title="Report time" />
        </div>
        <TooltipProvider delayDuration={100}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <KpiList title={`Tool KPIs (${pct(timing.tool_ms)}%)`} kpis={TOOL_KPIS} t={timing} />
            <KpiList title={`Report KPIs (${pct(timing.report_ms)}%)`} kpis={REPORT_KPIS} t={timing} />
          </div>
        </TooltipProvider>
        </>}
      </CardContent>
    </Card>
  );
}

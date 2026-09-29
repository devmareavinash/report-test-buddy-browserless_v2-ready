import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { AppLayout } from "@/components/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link, useSearchParams } from "react-router-dom";
import { StatusChip } from "@/components/StatusChip";

export default function Checks() {
  const [params, setParams] = useSearchParams();
  const status = params.get("status") || "fail";
  const runId = params.get("run_id");
  const wsId = params.get("workstream_id");

  const { data } = useQuery({
    queryKey: ["checks", status, runId, wsId],
    queryFn: async () => {
      let q = supabase
        .from("test_results")
        .select("id, status, severity, criticality, rank_score, analysis, expected, actual, created_at, run_id, scenarios(id, title, reports(id, name, workstream_id, workstreams(id, name)))")
        .order("created_at", { ascending: false })
        .limit(300);
      if (status && status !== "all") q = q.eq("status", status);
      if (runId) q = q.eq("run_id", runId);
      const { data } = await q;
      let rows = data ?? [];
      if (wsId) rows = rows.filter((r: any) => r.scenarios?.reports?.workstream_id === wsId);
      return rows;
    },
  });

  const setStatus = (s: string) => {
    const next = new URLSearchParams(params);
    next.set("status", s);
    setParams(next);
  };

  const title = status === "pass" ? "Passed checks" : status === "fail" ? "Failed checks" : "All checks";

  return (
    <AppLayout>
      <div className="p-8 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">{title}</h1>
            {(runId || wsId) && (
              <p className="text-xs text-muted-foreground mono mt-1">
                {runId && <>scoped to run {runId.slice(0, 8)} </>}
                {wsId && <>· workstream {wsId.slice(0, 8)}</>}
              </p>
            )}
          </div>
          <div className="flex gap-1 text-xs">
            {[["Failed", "fail"], ["Passed", "pass"], ["All", "all"]].map(([l, v]) => (
              <button
                key={v}
                onClick={() => setStatus(v)}
                className={`px-3 py-1.5 rounded border ${status === v ? "border-accent text-accent" : "border-border text-muted-foreground"}`}
              >
                {l}
              </button>
            ))}
          </div>
        </div>

        <Card>
          <CardHeader><CardTitle>{(data || []).length} checks</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {(data || []).map((r: any) => (
              <Link
                key={r.id}
                to={`/runs/${r.run_id}`}
                className="block border border-border rounded-md p-3 hover:bg-secondary/40"
              >
                <div className="flex items-center gap-2">
                  <StatusChip status={r.criticality || r.severity || r.status} />
                  <span className="text-sm font-medium">{r.scenarios?.title || "(deleted scenario)"}</span>
                  <span className="text-xs text-muted-foreground mono ml-auto">
                    {r.scenarios?.reports?.workstreams?.name} / {r.scenarios?.reports?.name}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  expected <span className="mono">{JSON.stringify(r.expected?.value)}</span> · actual <span className="mono">{JSON.stringify(r.actual?.value)}</span>
                </div>
                {r.analysis && <div className="text-xs mt-1">{r.analysis}</div>}
              </Link>
            ))}
            {!data?.length && <div className="text-sm text-muted-foreground">No checks match.</div>}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}

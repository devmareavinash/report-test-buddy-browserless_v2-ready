import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

type ActiveRun = {
  id: string;
  scope_type: string;
  scope_id: string | null;
};

export function useExecutionLocks() {
  const query = useQuery({
    queryKey: ["active-execution-locks"],
    queryFn: async () => {
      const { data: runs, error: runsError } = await supabase
        .from("runs")
        .select("id, scope_type, scope_id")
        .eq("status", "running")
        .limit(1000);
      if (runsError) throw runsError;

      const activeRuns = (runs || []) as ActiveRun[];
      const scenarioIds = activeRuns
        .filter((run) => run.scope_type === "scenario" && run.scope_id)
        .map((run) => run.scope_id as string);
      const explicitReportIds = activeRuns
        .filter((run) => run.scope_type === "report" && run.scope_id)
        .map((run) => run.scope_id as string);

      const scenarioReport = new Map<string, string>();
      if (scenarioIds.length) {
        const { data, error } = await supabase
          .from("scenarios")
          .select("id, report_id")
          .in("id", scenarioIds);
        if (error) throw error;
        for (const row of data || []) {
          if (row.id && row.report_id) scenarioReport.set(row.id, row.report_id);
        }
      }

      const allReportIds = Array.from(new Set([
        ...explicitReportIds,
        ...scenarioReport.values(),
      ]));
      const reportWorkstream = new Map<string, string>();
      if (allReportIds.length) {
        const { data, error } = await supabase
          .from("reports")
          .select("id, workstream_id")
          .in("id", allReportIds);
        if (error) throw error;
        for (const row of data || []) {
          if (row.id && row.workstream_id) reportWorkstream.set(row.id, row.workstream_id);
        }
      }

      return { activeRuns, scenarioReport, reportWorkstream };
    },
    refetchInterval: 3000,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });

  const data = query.data;
  const activeScenarioIds = new Set(
    (data?.activeRuns || [])
      .filter((run) => run.scope_type === "scenario" && run.scope_id)
      .map((run) => run.scope_id as string),
  );
  const activeReportIds = new Set(
    (data?.activeRuns || [])
      .filter((run) => run.scope_type === "report" && run.scope_id)
      .map((run) => run.scope_id as string),
  );
  const activeWorkstreamIds = new Set(
    (data?.activeRuns || [])
      .filter((run) => run.scope_type === "workstream" && run.scope_id)
      .map((run) => run.scope_id as string),
  );
  const activeScenarioReportIds = new Set(
    data ? Array.from(data.scenarioReport.values()) : [],
  );
  const activeDescendantWorkstreamIds = new Set(
    data ? Array.from(data.reportWorkstream.values()) : [],
  );

  return {
    ...query,
    isScenarioRunning: (scenarioId: string, reportId?: string | null, workstreamId?: string | null) =>
      activeScenarioIds.has(scenarioId) ||
      (!!reportId && activeReportIds.has(reportId)) ||
      (!!workstreamId && activeWorkstreamIds.has(workstreamId)),
    isReportRunning: (reportId: string, workstreamId?: string | null) =>
      activeReportIds.has(reportId) ||
      activeScenarioReportIds.has(reportId) ||
      (!!workstreamId && activeWorkstreamIds.has(workstreamId)),
    isWorkstreamRunning: (workstreamId: string) =>
      activeWorkstreamIds.has(workstreamId) ||
      activeDescendantWorkstreamIds.has(workstreamId),
  };
}

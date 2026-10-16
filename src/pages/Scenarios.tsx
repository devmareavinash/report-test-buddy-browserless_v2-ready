import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { AppLayout } from "@/components/AppLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { ScenarioResultCard } from "@/components/ScenarioResultCard";
import { Download } from "lucide-react";
import * as XLSX from "xlsx";
import { deriveStoredResultStatus, toStoredTableModel, unwrapStoredValues } from "@/lib/kpi-values";
import { pickCanonicalScript } from "@/lib/canonicalScript";
import { toast } from "sonner";
import { fetchLatestRunResultsByScenarioIds, fetchFilterMatrixByScenarioIds, overallStatusFromComboPairs, pairCombosWithResults } from "@/lib/latestTestResults";
import { useExecutionLocks } from "@/hooks/useExecutionLocks";

function excelValue(value: any): string | number | boolean {
  if (value == null) return "";
  if (["string", "number", "boolean"].includes(typeof value)) return value;
  return JSON.stringify(value);
}

function uniqueSheetName(title: string, used: Set<string>) {
  const base = String(title || "Case").replace(/[:\\/?*\[\]]/g, " ").replace(/\s+/g, " ").trim() || "Case";
  let name = base.slice(0, 31);
  let suffix = 2;
  while (used.has(name.toLowerCase()) || name.toLowerCase() === "summary") {
    const ending = ` (${suffix++})`;
    name = `${base.slice(0, 31 - ending.length)}${ending}`;
  }
  used.add(name.toLowerCase());
  return name;
}

function resultDetailRows(row: any): any[][] {
  const s = row.scenario;
  const rows: any[][] = [
    ["Case Name", s.title],
    ["Overall Status", row.overallStatus || "pending"],
    ["Report", s.reports?.workstreams?.name || ""],
    ["Screen", s.reports?.name || ""],
    ["Type", s.type || ""],
    [],
  ];
  for (const pair of row.comboPairs || []) {
    const result = pair.result;
    rows.push(["Filter Combination", pair.label || "Default"], ["Result", result?.status || "pending"]);
    if (!result) {
      rows.push(["Details", "No execution result"], []);
      continue;
    }
    const actual = unwrapStoredValues(result.actual);
    const expected = unwrapStoredValues(result.expected);
    const keys = Array.from(new Set([...Object.keys(actual), ...Object.keys(expected)]))
      .filter((key) => key && !key.startsWith("__") && !/^(filter|source|filters_applied)$/i.test(key));
    rows.push(["KPI", "Actual", "Expected", "Diff", "Status"]);
    for (const key of keys) {
      const actualGrid = toStoredTableModel(actual[key]);
      const expectedGrid = toStoredTableModel(expected[key]);
      if (actualGrid || expectedGrid) {
        rows.push([key, "", "", "", result.status || "pending"]);
        for (const [heading, table] of [["Actual Grid", actualGrid], ["Expected Grid", expectedGrid]] as const) {
          if (!table) continue;
          rows.push([heading], table.columns);
          table.rows.forEach((gridRow) => rows.push(gridRow.map(excelValue)));
        }
      } else {
        const diff = result.diff && typeof result.diff === "object" ? result.diff[key] : null;
        rows.push([key, excelValue(actual[key]), excelValue(expected[key]), excelValue(diff), result.status || "pending"]);
      }
    }
    rows.push([]);
  }
  return rows;
}

export default function Scenarios() {
  const [params] = useSearchParams();
  const deferred = params.get("deferred") === "true";
  const urlStatus = params.get("status") || "all";
  const urlCriticality = params.get("criticality") || "all";
  const urlWs = params.get("workstream_id") || "all";
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState(urlStatus);
  const [criticality, setCriticality] = useState(urlCriticality);
  const [wsId, setWsId] = useState(urlWs);
  const executionLocks = useExecutionLocks();
  const activeRunCount = executionLocks.data?.activeRuns?.length || 0;
  const previousActiveRunCount = useRef(0);

  const { data: workstreams } = useQuery({
    queryKey: ["ws-list"],
    queryFn: async () => (await supabase.from("workstreams").select("id, name")).data ?? [],
  });

  const { data, refetch } = useQuery({
    queryKey: ["scenarios-pivot", deferred],
    queryFn: async () => {
      const scenarios =
        (await supabase
          .from("scenarios")
          .select("id, title, type, criticality, status, deferred, report_id, reports(id, name, workstream_id, workstreams(id, name))")
          .eq("deferred", deferred)
          .order("created_at", { ascending: false })
          .limit(2000)).data ?? [];
      const latestRuns = await fetchLatestRunResultsByScenarioIds(
        scenarios.map((s: any) => s.id),
        "id, scenario_id, run_id, status, criticality, severity, analysis, expected, actual, diff, healing_status, healing_proposal, screenshot_url, created_at",
      );
      // Latest result renders scenario_filter_matrix, so this page must too —
      // otherwise a scenario with 4 combinations shows only the ones that have
      // a stored test_results row.
      const matrix = await fetchFilterMatrixByScenarioIds(scenarios.map((s: any) => s.id));
      const { data: scriptRows } = await supabase
        .from("scripts")
        .select("scenario_id, assertion_spec, playwright_code, created_at")
        .in("scenario_id", scenarios.map((s: any) => s.id))
        .order("created_at", { ascending: false })
        .limit(5000);
      const scriptsByScenario = new Map<string, any[]>();
      for (const script of scriptRows || []) {
        const list = scriptsByScenario.get(script.scenario_id) || [];
        list.push(script);
        scriptsByScenario.set(script.scenario_id, list);
      }
      const mapped = scenarios.map((s: any) => {
        const rows = latestRuns.get(s.id) || [];
        const combos = matrix.get(s.id) || [];
        const comboPairs = pairCombosWithResults(combos, rows);
        const assertionSpec = pickCanonicalScript(scriptsByScenario.get(s.id))?.assertion_spec;
        const statusPairs = comboPairs.map((pair: any) => ({
          result: pair.result
            ? {
                status: deriveStoredResultStatus({
                  actual: pair.result.actual,
                  expected: pair.result.expected,
                  spec: assertionSpec,
                  scenarioType: s.type,
                  diff: pair.result.diff,
                  fallbackStatus: pair.result.status,
                }),
              }
            : null,
        }));
        const overallStatus = overallStatusFromComboPairs(statusPairs, rows[0]?.status || "pending");
        return {
          scenario: s,
          latest: rows[0] || null,
          latestAll: rows,
          comboPairs,
          overallStatus,
        };
      });
      return mapped;
    },
    // agent-analyze writes RCA asynchronously after a failed result is inserted.
    // Poll only while at least one failed/pending combination has no RCA yet.
    refetchInterval: (query) => {
      const activeRuns = executionLocks.data?.activeRuns?.length || 0;
      if (activeRuns > 0) return 3000;
      const rows = (query.state.data as any[] | undefined) || [];
      const waiting = rows.some((row: any) =>
        (row.comboPairs || []).some((pair: any) => {
          const result = pair?.result;
          return result
            && (result.status === "fail" || result.status === "pending")
            && !String(result.analysis || "").trim();
        })
      );
      return waiting ? 5000 : false;
    },
    staleTime: 0,
    refetchOnMount: "always",
  });

  useEffect(() => {
    if (activeRunCount > 0 || previousActiveRunCount.current > activeRunCount) {
      refetch();
    }
    previousActiveRunCount.current = activeRunCount;
  }, [activeRunCount, refetch]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return (data || []).filter((row: any) => {
      const s = row.scenario;
      if (wsId !== "all" && s.reports?.workstream_id !== wsId) return false;
      if (status !== "all") {
        const st = row.overallStatus || "pending";
        if (status === "ran") {
          if (st === "pending") return false;
        } else if (st !== status) {
          return false;
        }
      }
      if (criticality !== "all") {
        const c = (row.latest?.criticality || s.criticality || "medium").toLowerCase();
        if (c !== criticality) return false;
      }
      if (!q) return true;
      return (
        s.title?.toLowerCase().includes(q) ||
        s.reports?.name?.toLowerCase().includes(q) ||
        s.reports?.workstreams?.name?.toLowerCase().includes(q) ||
        row.latest?.analysis?.toLowerCase().includes(q) ||
        String(row.latest?.actual?.error || row.latest?.expected?.error || "").toLowerCase().includes(q)
      );
    });
  }, [data, search, status, wsId, criticality]);

  const restore = async (id: string) => {
    await supabase.from("scenarios").update({ deferred: false }).eq("id", id);
    toast.success("Restored");
    refetch();
  };

  const exportExcel = () => {
    const workbook = XLSX.utils.book_new();
    const usedNames = new Set<string>();
    const details = filtered.map((row: any) => ({ row, name: uniqueSheetName(row.scenario.title, usedNames) }));
    const summary = XLSX.utils.aoa_to_sheet([
      ["Case Name", "Status", "Report", "Screen", "Type", "Result Sheet"],
      ...details.map(({ row, name }) => [
        row.scenario.title, row.overallStatus || "pending",
        row.scenario.reports?.workstreams?.name || "", row.scenario.reports?.name || "",
        row.scenario.type || "", name,
      ]),
    ]);
    details.forEach(({ name }, index) => {
      const cell = summary[XLSX.utils.encode_cell({ r: index + 1, c: 5 })];
      if (cell) cell.l = { Target: `#'${name.replace(/'/g, "''")}'!A1` };
    });
    XLSX.utils.book_append_sheet(workbook, summary, "Summary");
    details.forEach(({ row, name }) => XLSX.utils.book_append_sheet(
      workbook, XLSX.utils.aoa_to_sheet(resultDetailRows(row)), name,
    ));
    XLSX.writeFile(workbook, `test-execution-status-${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  return (
    <AppLayout>
      <div className="p-8 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold italic tracking-tight">
              {deferred ? "Deferred scenarios" : "Tests execution status"}
            </h1>
            <p className="text-sm text-muted-foreground">
              Latest execution per scenario, with RCA and proposed fixes.
            </p>
          </div>
        </div>

        <div className="flex gap-2 flex-wrap items-center">
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs font-semibold text-foreground mono">
            {filtered.length} scenarios
          </div>
          <Input
            placeholder="Search title, report, workstream, analysis…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-sm font-semibold placeholder:font-semibold"
          />
          <Select value={wsId} onValueChange={setWsId}>
            <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All reports</SelectItem>
              {(workstreams || []).map((w: any) => (
                <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="ran">Ran</SelectItem>
              <SelectItem value="pass">Pass</SelectItem>
              <SelectItem value="fail">Fail</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
            </SelectContent>
          </Select>
          <Select value={criticality} onValueChange={setCriticality}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All criticality</SelectItem>
              <SelectItem value="critical">Critical</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="low">Low</SelectItem>
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="outline"
            className="border-green-300 bg-green-100 text-green-800 hover:bg-green-200"
            onClick={exportExcel}
            disabled={!filtered.length}
          >
            <Download className="h-4 w-4 mr-1" />Export Excel
          </Button>
        </div>

        <Card>
          <CardContent className="p-2 space-y-1">
            {filtered.map((row: any) => {
              const s = row.scenario;
              const meta = `${s.reports?.workstreams?.name || "—"} / ${s.reports?.name || "—"} · ${s.type || "—"} · ${s.criticality}`;
              return (
                <ScenarioResultCard
                  key={s.id}
                  scenarioId={s.id}
                  scenarioTitle={s.title}
                  scenarioMeta={meta}
                  scenarioType={s.type}
                  reportId={s.report_id}
                  workstreamId={s.reports?.workstream_id}
                  result={row.latest}
                  results={row.latestAll}
                  comboPairs={row.comboPairs}
                  onChanged={refetch}
                  rightSlot={
                    deferred ? (
                      <Button size="sm" variant="outline" onClick={() => restore(s.id)}>Restore</Button>
                    ) : undefined
                  }
                />
              );
            })}
            {!filtered.length && (
              <div className="text-sm text-muted-foreground p-4 text-center">No scenarios match.</div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}

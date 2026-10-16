import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { AppLayout } from "@/components/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusChip } from "@/components/StatusChip";
import { Link } from "react-router-dom";
import { fetchFilterMatrixByScenarioIds, fetchLatestRunResultsByScenarioIds, overallStatusFromComboPairs, pairCombosWithResults } from "@/lib/latestTestResults";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";
import * as XLSX from "xlsx";
import { toStoredTableModel, unwrapStoredValues } from "@/lib/kpi-values";

function excelValue(value: any): string | number | boolean {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return JSON.stringify(value);
}

function uniqueSheetName(title: string, used: Set<string>) {
  const base = String(title || "Case")
    .replace(/[:\\/?*\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "Case";
  let candidate = base.slice(0, 31);
  let suffix = 2;
  while (used.has(candidate.toLowerCase()) || candidate.toLowerCase() === "summary") {
    const ending = ` (${suffix++})`;
    candidate = `${base.slice(0, 31 - ending.length)}${ending}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function appendGrid(rows: any[][], heading: string, value: any) {
  const table = toStoredTableModel(value);
  if (!table) return false;
  rows.push([heading]);
  rows.push(table.columns);
  for (const row of table.rows) rows.push(row.map(excelValue));
  return true;
}

function resultDetailRows(row: any): any[][] {
  const scenario = row.scenario;
  const rows: any[][] = [
    ["Case Name", scenario.title],
    ["Overall Status", row.overallStatus || "pending"],
    ["Report", scenario.reports?.workstreams?.name || ""],
    ["Screen", scenario.reports?.name || ""],
    ["Type", scenario.type || ""],
    [],
  ];
  for (const pair of row.pairs || []) {
    const result = pair.result;
    rows.push(["Filter Combination", pair.label || "Default"]);
    rows.push(["Result", result?.status || "pending"]);
    rows.push(["Executed At", result?.created_at ? new Date(result.created_at).toISOString() : ""]);
    if (!result) {
      rows.push(["Details", "No execution result"]);
      rows.push([]);
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
        appendGrid(rows, "Actual Grid", actual[key]);
        appendGrid(rows, "Expected Grid", expected[key]);
      } else {
        const diff = result.diff && typeof result.diff === "object" ? result.diff[key] : null;
        rows.push([
          key,
          excelValue(actual[key]),
          excelValue(expected[key]),
          excelValue(diff),
          typeof diff === "object" && diff?.pass != null
            ? (diff.pass ? "pass" : "fail")
            : result.status || "pending",
        ]);
      }
    }
    rows.push([]);
  }
  return rows;
}

export default function Tests() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string>("all");
  const [wsId, setWsId] = useState<string>("all");

  const { data: workstreams } = useQuery({
    queryKey: ["ws"],
    queryFn: async () => (await supabase.from("workstreams").select("id, name")).data ?? [],
  });

  const { data, isLoading } = useQuery({
    queryKey: ["tests-overview"],
    queryFn: async () => {
      const scenarios = (await supabase
        .from("scenarios")
        .select("id, title, status, criticality, type, report_id, reports(id, name, workstream_id, workstreams(id, name))")
        .limit(1000)).data ?? [];
      const ids = scenarios.map((s: any) => s.id);
      const latestByScenario = await fetchLatestRunResultsByScenarioIds(
        ids,
        "id, scenario_id, run_id, status, criticality, severity, actual, expected, diff, analysis, created_at, runs(id, started_at)",
      );
      const matrix = await fetchFilterMatrixByScenarioIds(ids);
      return scenarios.map((s: any) => {
        const results = latestByScenario.get(s.id) || [];
        const pairs = pairCombosWithResults(matrix.get(s.id) || [], results);
        const overallStatus = overallStatusFromComboPairs(
          pairs,
          results[0]?.status || "pending",
        );
        return {
          scenario: s,
          latest: results[0] || null,
          overallStatus,
          pairs,
        };
      });
    },
  });

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return (data || []).filter((row: any) => {
      const s = row.scenario;
      if (wsId !== "all" && s.reports?.workstream_id !== wsId) return false;
      if (status !== "all") {
        const st = row.overallStatus || "pending";
        if (st !== status) return false;
      }
      if (!q) return true;
      return (
        s.title?.toLowerCase().includes(q) ||
        s.reports?.name?.toLowerCase().includes(q) ||
        s.reports?.workstreams?.name?.toLowerCase().includes(q)
      );
    });
  }, [data, search, status, wsId]);

  const exportExcel = () => {
    const workbook = XLSX.utils.book_new();
    const usedNames = new Set<string>();
    const detailSheets = filtered.map((row: any) => ({
      row,
      name: uniqueSheetName(row.scenario.title, usedNames),
    }));
    const summaryRows = [
      ["Case Name", "Status", "Report", "Screen", "Type", "Latest Run", "Result Sheet"],
      ...detailSheets.map(({ row, name }) => [
        row.scenario.title,
        row.overallStatus || "pending",
        row.scenario.reports?.workstreams?.name || "",
        row.scenario.reports?.name || "",
        row.scenario.type || "",
        row.latest?.created_at ? new Date(row.latest.created_at).toISOString() : "",
        name,
      ]),
    ];
    const summary = XLSX.utils.aoa_to_sheet(summaryRows);
    summary["!cols"] = [
      { wch: 55 }, { wch: 12 }, { wch: 28 }, { wch: 30 },
      { wch: 20 }, { wch: 24 }, { wch: 31 },
    ];
    detailSheets.forEach(({ name }, index) => {
      const cell = summary[XLSX.utils.encode_cell({ r: index + 1, c: 6 })];
      if (cell) cell.l = { Target: `#'${name.replace(/'/g, "''")}'!A1` };
    });
    XLSX.utils.book_append_sheet(workbook, summary, "Summary");
    for (const { row, name } of detailSheets) {
      const sheet = XLSX.utils.aoa_to_sheet(resultDetailRows(row));
      sheet["!cols"] = [
        { wch: 36 }, { wch: 32 }, { wch: 32 }, { wch: 34 }, { wch: 14 },
      ];
      XLSX.utils.book_append_sheet(workbook, sheet, name);
    }
    const date = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(workbook, `test-execution-status-${date}.xlsx`);
  };

  return (
    <AppLayout>
      <div className="p-8 space-y-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">All tests</h1>
          <p className="text-sm text-muted-foreground">Latest result per test case across every report and screen.</p>
        </div>

        <div className="flex gap-2 items-center flex-wrap">
          <Input
            placeholder="Search title, report, workstream…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-xs"
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
              <SelectItem value="pass">Pass</SelectItem>
              <SelectItem value="fail">Fail</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
            </SelectContent>
          </Select>
          <div className="text-xs text-muted-foreground mono ml-auto">{filtered.length} tests</div>
          <Button size="sm" variant="outline" onClick={exportExcel} disabled={!filtered.length || isLoading}>
            <Download className="h-4 w-4 mr-1" />Export Excel
          </Button>
        </div>

        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Test</TableHead>
                  <TableHead>Report</TableHead>
                  <TableHead>Screen</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Latest run</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((row: any) => {
                  const s = row.scenario;
                  const l = row.latest;
                  return (
                    <TableRow key={s.id}>
                      <TableCell><StatusChip status={row.overallStatus || "pending"} /></TableCell>
                      <TableCell className="font-medium">
                        <Link to={`/scenarios/${s.id}`} className="hover:text-accent">{s.title}</Link>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{s.reports?.workstreams?.name || "—"}</TableCell>
                      <TableCell className="text-xs">
                        <Link to={`/reports/${s.report_id}`} className="hover:text-accent">{s.reports?.name}</Link>
                      </TableCell>
                      <TableCell className="text-xs mono text-muted-foreground">{s.type || "—"}</TableCell>
                      <TableCell className="text-xs mono text-muted-foreground">
                        {l?.created_at ? new Date(l.created_at).toLocaleString() : "never"}
                      </TableCell>
                      <TableCell className="text-right">
                        {l?.run_id && (
                          <Link to={`/runs/${l.run_id}`} className="text-xs text-accent hover:underline">view run</Link>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {!filtered.length && !isLoading && (
                  <TableRow><TableCell colSpan={7} className="text-center text-sm text-muted-foreground py-8">No tests match.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}

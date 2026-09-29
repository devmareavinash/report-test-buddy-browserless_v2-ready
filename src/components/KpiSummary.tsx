import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Check } from "lucide-react";
import { GridComparePanels, isChartTable } from "@/components/KpiGrid";

type AnyRec = Record<string, any> | null | undefined;

const VALUE_NOISE = new Set([
  "error", "message", "filter", "filters", "filters_applied", "source", "where_clause",
  "sql", "row", "metric", "value", "values", "ok", "note", "screenshot",
  "tableData", "tabledata", "show_data_debug", "show_data_error", "extract_via",
  "first_col0", "selected_grain", "time_grain_click", "grain_retries", "headers",
  "periods", "missing", "unparsed_periods", "consecutive", "trend_error", "time_grain",
  "grains", "navigation",
]);

function formatVal(v: any): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return v.toLocaleString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function pickFilter(side: AnyRec): AnyRec {
  if (!side) return null;
  return side.filter ?? side.filters ?? null;
}

function asNumber(v: any): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function unwrapValues(side: AnyRec): Record<string, any> {
  if (!side || typeof side !== "object") return {};
  const raw = (side.values && typeof side.values === "object" && !Array.isArray(side.values))
    ? side.values
    : side;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!k || k.startsWith("__") || VALUE_NOISE.has(k)) continue;
    out[k] = v;
  }
  return out;
}

function pickNamedOrChart(side: AnyRec, name?: string | null): any {
  if (!side || typeof side !== "object") return null;
  if (side.value !== undefined && side.value !== null && typeof side.value !== "object") return side.value;
  const values = unwrapValues(side);
  if (name && values[name] !== undefined) return values[name];
  const chartName = Object.keys(values).find((k) => isChartTable(values[k]));
  if (chartName) return values[chartName];
  const first = Object.keys(values)[0];
  if (first) return values[first];
  const td = (side.values && (side.values.tableData || side.values.tabledata)) || side.tableData || side.tabledata;
  return td ?? null;
}

export function getKpiInfo(expected: AnyRec, actual: AnyRec, diff: AnyRec) {
  const valuesA = unwrapValues(actual);
  const valuesE = unwrapValues(expected);
  const metric = expected?.metric ?? actual?.metric
    ?? Object.keys(valuesA)[0] ?? Object.keys(valuesE)[0] ?? null;
  const source = expected?.source ?? actual?.source ?? null;
  const filter = pickFilter(expected) ?? pickFilter(actual);
  const refVal = pickNamedOrChart(expected, metric);
  const mainVal = pickNamedOrChart(actual, metric);
  const refNum = asNumber(refVal);
  const mainNum = asNumber(mainVal);
  let deltaAbs: number | null = null;
  let deltaPct: number | null = null;
  if (refNum !== null && mainNum !== null) {
    deltaAbs = mainNum - refNum;
    if (refNum !== 0) deltaPct = (deltaAbs / Math.abs(refNum)) * 100;
  } else if (diff && typeof diff === "object") {
    if (typeof diff.pct === "number") deltaPct = diff.pct;
    if (typeof diff.value === "number") deltaAbs = diff.value;
  }
  return { metric, source, filter, refVal, mainVal, deltaAbs, deltaPct };
}

function FilterChips({ filter }: { filter: AnyRec }) {
  if (!filter || (typeof filter === "object" && Object.keys(filter).length === 0)) {
    return <span className="text-muted-foreground mono text-xs">no filters</span>;
  }
  if (typeof filter !== "object") {
    return <Badge variant="outline" className="mono text-[10px]">{String(filter)}</Badge>;
  }
  const entries = Object.entries(filter as Record<string, any>);
  return (
    <div className="flex flex-wrap gap-1">
      {entries.map(([k, v]) => (
        <Badge key={k} variant="outline" className="mono text-[10px] font-normal">
          <span className="text-muted-foreground mr-1">{k}:</span>
          <span>{Array.isArray(v) ? v.join(", ") : formatVal(v)}</span>
        </Badge>
      ))}
    </div>
  );
}

export function KpiSummary({
  expected,
  actual,
  diff,
  status,
  tolerance,
}: {
  expected: AnyRec;
  actual: AnyRec;
  diff: AnyRec;
  status?: string | null;
  tolerance?: number | null;
}) {
  const info = getKpiInfo(expected, actual, diff);
  const breached = status === "fail";
  const tolPct = typeof tolerance === "number" ? tolerance * 100 : null;
  const showGrid = isChartTable(info.mainVal) || isChartTable(info.refVal);

  return (
    <div className="border border-border rounded-md p-3 bg-background/40 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground mono">KPI</span>
          <span className="text-sm font-semibold">{info.metric || "—"}</span>
          {info.source && (
            <Badge variant="outline" className="mono text-[10px] font-normal">
              source: {info.source}
            </Badge>
          )}
        </div>
        {breached ? (
          <Badge variant="destructive" className="mono text-[10px]">
            <AlertTriangle className="h-3 w-3 mr-1" /> threshold breached
          </Badge>
        ) : status === "pass" ? (
          <Badge variant="outline" className="mono text-[10px] border-success/40 text-success">
            <Check className="h-3 w-3 mr-1" /> within threshold
          </Badge>
        ) : null}
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground mono mb-1">
          Filters / dropdowns
        </div>
        <FilterChips filter={info.filter} />
      </div>

      {showGrid ? (
        <GridComparePanels
          actual={info.mainVal}
          expected={info.refVal}
          leftLabel="Main dashboard"
          rightLabel="Reference dashboard"
        />
      ) : (
      <div className="grid grid-cols-3 gap-2">
        <div className="border border-border rounded-md p-2">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mono">
            Main dashboard
          </div>
          <div className="text-base font-semibold mono mt-0.5">{formatVal(info.mainVal)}</div>
        </div>
        <div className="border border-border rounded-md p-2">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mono">
            Reference dashboard
          </div>
          <div className="text-base font-semibold mono mt-0.5">{formatVal(info.refVal)}</div>
        </div>
        <div
          className={`border rounded-md p-2 ${
            breached ? "border-destructive/50 bg-destructive/5" : "border-border"
          }`}
        >
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mono">
            Difference {tolPct !== null && <span className="normal-case">(tol ±{tolPct}%)</span>}
          </div>
          <div
            className={`text-base font-semibold mono mt-0.5 ${
              breached ? "text-destructive" : ""
            }`}
          >
            {info.deltaAbs !== null ? (info.deltaAbs > 0 ? "+" : "") + formatVal(info.deltaAbs) : "—"}
            {info.deltaPct !== null && (
              <span className="text-xs ml-2 text-muted-foreground">
                ({info.deltaPct > 0 ? "+" : ""}
                {info.deltaPct.toFixed(2)}%)
              </span>
            )}
          </div>
        </div>
      </div>
      )}
    </div>
  );
}

export function KpiInlineDelta({
  expected,
  actual,
  diff,
  status,
}: {
  expected: AnyRec;
  actual: AnyRec;
  diff: AnyRec;
  status?: string | null;
}) {
  const info = getKpiInfo(expected, actual, diff);
  if (info.mainVal === null && info.refVal === null) return null;
  if (isChartTable(info.mainVal) || isChartTable(info.refVal)) {
    const n = (info.mainVal?.rows || info.refVal?.rows || []).length;
    return (
      <div className="hidden md:flex items-center gap-1.5 text-xs mono whitespace-nowrap">
        {info.metric && <span className="text-muted-foreground">{info.metric}:</span>}
        <span className="font-medium">{n ? `${n} rows` : "grid"}</span>
      </div>
    );
  }
  const breached = status === "fail";
  return (
    <div className="hidden md:flex items-center gap-1.5 text-xs mono whitespace-nowrap">
      {info.metric && <span className="text-muted-foreground">{info.metric}:</span>}
      <span className="font-medium">{formatVal(info.mainVal)}</span>
      <span className="text-muted-foreground">vs</span>
      <span>{formatVal(info.refVal)}</span>
      {info.deltaPct !== null && (
        <span className={breached ? "text-destructive font-semibold" : "text-muted-foreground"}>
          ({info.deltaPct > 0 ? "+" : ""}
          {info.deltaPct.toFixed(1)}%)
        </span>
      )}
      {breached && <AlertTriangle className="h-3 w-3 text-destructive" />}
    </div>
  );
}

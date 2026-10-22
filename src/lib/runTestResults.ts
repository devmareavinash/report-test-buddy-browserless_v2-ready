import { supabase } from "@/integrations/supabase/client";
import { pickCanonicalScript } from "./canonicalScript";

export const runResultColumns = "id, run_id, scenario_id, status, actual, expected, diff, criticality, severity, analysis, healing_status, healing_proposal, screenshot_url, created_at, scenarios(id, title, type, criticality, report_id, reports(id, name, workstream_id, workstreams(id, name)))";

/** Fetch every result for the visible runs, respecting the Data API row cap. */
export async function fetchRunTestResults(runIds: string[]) {
  if (runIds.length > 10) {
    const chunks = Array.from({ length: Math.ceil(runIds.length / 10) }, (_, i) => runIds.slice(i * 10, i * 10 + 10));
    return (await Promise.all(chunks.map(fetchRunTestResults))).flat();
  }
  const rows: any[] = [];
  if (!runIds.length) return rows;

  const pageSize = 1000;
  for (let start = 0; start < runIds.length; start += 10) {
   for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase
      .from("test_results")
      .select(runResultColumns)
      .in("run_id", runIds.slice(start, start + 10))
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
   }
  }
  return rows;
}

/** Resolve the same canonical configuration for both run views without a single-request row cap. */
export async function fetchRunAssertionSpecs(scenarioIds: string[]) {
  const specs: Record<string, any> = {};
  const ids = [...new Set(scenarioIds.filter(Boolean))];
  if (ids.length > 10) {
    const chunks = Array.from({ length: Math.ceil(ids.length / 10) }, (_, i) => ids.slice(i * 10, i * 10 + 10));
    return Object.assign(specs, ...(await Promise.all(chunks.map(fetchRunAssertionSpecs))));
  }
  for (let start = 0; start < ids.length; start += 10) {
    const rows: any[] = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await supabase.from("scripts")
        .select("scenario_id, assertion_spec, playwright_code, created_at")
        .in("scenario_id", ids.slice(start, start + 10))
        .order("id", { ascending: true }).range(offset, offset + 999);
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    const groups = new Map<string, any[]>();
    for (const row of rows) groups.set(row.scenario_id, [...(groups.get(row.scenario_id) || []), row]);
    for (const [id, group] of groups) specs[id] = pickCanonicalScript(group)?.assertion_spec;
  }
  return specs;
}
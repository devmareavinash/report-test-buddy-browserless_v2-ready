import { corsHeaders } from "../_shared/cors.ts";
import { requireAuth } from "../_shared/auth.ts";
import { callAgent, getSupabase, tryParseJson } from "../_shared/llm.ts";

const VALID_OPS = new Set(["eq", "lte", "gte", "gt", "lt"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const unauthorized = await requireAuth(req);
  if (unauthorized) return unauthorized;
  try {
    const { report_id, context } = await req.json();
    const ctx = String(context || "").trim();
    if (!ctx) {
      return new Response(
        JSON.stringify({ error: "context is required to generate scenarios" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const sb = getSupabase();
    const { data: report } = await sb.from("reports").select("*").eq("id", report_id).maybeSingle();
    if (!report) throw new Error("report not found");

    const { data: existing } = await sb
      .from("scenarios")
      .select("title,description,type")
      .eq("report_id", report_id);

    const existingBlock = (existing || []).length
      ? `\n\nExisting scenarios (DO NOT duplicate — skip anything overlapping in intent):\n${(existing || [])
          .map((s: any, i: number) => `${i + 1}. [${s.type}] ${s.title} — ${s.description || ""}`)
          .join("\n")}`
      : "";

    const sys = [
      "You generate BI report test scenarios.",
      "The user's context is the PRIMARY signal: infer from it which scenario types are actually needed and ONLY generate those types. Do not add extra types the user didn't ask for or imply.",
      "Allowed types: warehouse_match | reference_match | trend | range_check.",
      "TYPE RULES (STRICT):",
      "- warehouse_match = any Frontend/UI value compared against Backend/Warehouse/DB/SQL data. This applies REGARDLESS of whether the UI source is the main report URL or the reference URL. Phrases like 'reference URL frontend vs backend', 'reference UI vs warehouse', 'main report frontend vs backend', 'UI vs BE', 'frontend vs backend' → ALWAYS warehouse_match.",
      "- reference_match = UI value on one screen/URL compared against UI value on ANOTHER screen/URL (UI-to-UI comparison across two frontends, e.g. prod vs preprod, or Overview screen vs Performance screen). Never use reference_match when one side is backend/warehouse/SQL.",
      "- trend = time-series/period-over-period checks. range_check = value within expected bounds.",
      "Do NOT duplicate an existing scenario only when it has the SAME type and the SAME explicit target (same quoted tab/widget/KPI set and same comparison intent).",
      "A broad scenario such as 'All sub-tabs' is NOT a duplicate of a newly requested single-tab scenario. If the user explicitly requests a quoted tab, generate that specific case unless an existing scenario already targets that same tab.",
      "If the context implies only one type, return only that type. If nothing new is warranted, return an empty array.",
      "",
      "KPI EXTRACTION (mandatory):",
      "For every scenario, populate a `kpis` array listing the KPI/metric names the scenario checks. Extract KPI names verbatim from the user context (e.g. 'NBRx Total', 'TRx Total'). If the context does not name specific KPIs, fall back to the KPIs in the report's KPI config. Never invent KPI names that are not in the context or KPI config.",
      "ROW-COUNT RULE: when the user asks for a row count / record count for a quoted tab, the KPI name is exactly `Row Count - <quoted tab>`. For multiple quoted tabs, include one such KPI per tab. Row-count comparisons between main and reference are reference_match.",
      "",
      "KPI GROUPING RULE (STRICT):",
      "- For type = warehouse_match: emit ONE scenario PER KPI. Each warehouse_match scenario's `kpis` array must contain exactly one KPI name. If the user mentions N KPIs to check against the warehouse, produce N warehouse_match scenarios (one per KPI). This is because each KPI has its own SQL template attached at run time.",
      "- For type = reference_match, trend, range_check: you MAY group multiple related KPIs into a single scenario when they share the same comparison intent, filters, and op.",
      "",
      "Each KPI item MUST be an object: { name: string, tolerance: number, unit: 'pct' | 'abs', op: 'eq' | 'lte' | 'gte' | 'gt' | 'lt' }.",
      "- `op` is the pass/fail comparison of ACTUAL (main) vs EXPECTED (reference/warehouse):",
      "    eq  = actual equals expected within tolerance",
      "    gt  = actual strictly greater than expected",
      "    gte = actual greater than or equal to expected",
      "    lt  = actual strictly less than expected",
      "    lte = actual less than or equal to expected",
      "- Read the user's condition carefully to pick the op. Examples:",
      "    'main should be greater than reference'         → gt",
      "    'preprod (reference) should be greater than prod (main)' → main < reference → lt",
      "    'values should match within 5%'                 → eq, tolerance 5 pct",
      "    'actual within ±100 of expected'                → eq, tolerance 100 abs",
      "- Default when no explicit condition: { tolerance: 0, unit: 'pct', op: 'eq' }.",
      "- Use the SAME op for every KPI within one scenario (the UI applies one global comparison per scenario).",
      "",
      "Reply ONLY with JSON: {scenarios:[{title,description,type,kpis:[{name,tolerance,unit,op}]}]}.",
    ].join(" ");

    const user =
      `Report: ${report.name}\nURL: ${report.url}\nKPIs: ${JSON.stringify(report.kpi_config)}` +
      `\n\nUser context (authoritative — drives scenario selection, types, KPI names, and pass/fail condition):\n${ctx}` +
      existingBlock +
      `\n\nGenerate only the scenarios the user context calls for (0-6). No filler.`;

    const raw = await callAgent({
      agentKey: "scenarios",
      messages: [{ role: "system", content: sys }, { role: "user", content: user }],
      json: true,
    });
    const parsed = tryParseJson(raw) || { scenarios: [] };
    const scenarios = (parsed.scenarios || []).slice(0, 8);

    let inserted = 0;
    const skipped: { title: string; error: string }[] = [];
    for (const s of scenarios) {
      const { data: scenarioRow, error: scErr } = await sb
        .from("scenarios")
        .insert({
          report_id,
          title: s.title,
          description: s.description,
          type: s.type || "warehouse_match",
        })
        .select("id")
        .single();
      if (scErr || !scenarioRow) {
        skipped.push({ title: String(s?.title || "Untitled scenario"), error: scErr?.message || "insert failed" });
        continue;
      }
      inserted += 1;

      // Build KPI tolerance map + names for the scripts.assertion_spec.
      const kpisRaw = Array.isArray(s.kpis) ? s.kpis : [];
      const kpiNames: string[] = [];
      const kpiTolerances: Record<string, { value: number; unit: "pct" | "abs"; op: string }> = {};
      for (const k of kpisRaw) {
        const name = String(k?.name || "").trim();
        if (!name) continue;
        kpiNames.push(name);
        const op = VALID_OPS.has(k?.op) ? k.op : "eq";
        const unit = k?.unit === "abs" ? "abs" : "pct";
        const value = Number.isFinite(Number(k?.tolerance)) ? Number(k.tolerance) : 0;
        kpiTolerances[name] = { value, unit, op };
      }

      if (kpiNames.length) {
        const assertion_spec: any = {
          kpis: kpiNames,
          kpi_tolerances: kpiTolerances,
        };
        await sb.from("scripts").insert({
          scenario_id: scenarioRow.id,
          assertion_spec,
          debug_status: "draft",
        });
      }
    }

    return new Response(
      JSON.stringify({
        inserted,
        generated: scenarios.length,
        skipped,
        generated_titles: scenarios.map((s: any) => String(s?.title || "")).filter(Boolean),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});

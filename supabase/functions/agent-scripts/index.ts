import { corsHeaders } from "../_shared/cors.ts";
import { getSupabaseForRequest, requireAuth } from "../_shared/auth.ts";
import { callAgent, tryParseJson } from "../_shared/llm.ts";
import {
  assembleKpiScript,
  isKpiScenario,
  normalizeReportUrl,
  parseKpiLabels,
  parseKpiNavSteps,
} from "../_shared/mstr-overview-template.ts";
import {
  assembleGridScript,
  isGridScenario,
  isRecordCountScenario,
  parseGridColumns,
  parseGridNavSteps,
  parseGridTimeGrain,
  parseGridTitle,
  parseSubTabs,
} from "../_shared/mstr-grid-template.ts";
import {
  assembleRecordCountScript,
  sanitizeRecordCountNavSteps,
} from "../_shared/mstr-record-count-template.ts";
import {
  assembleChartScript,
  isChartScenario,
  parseChartNavSteps,
  parseChartTimeGrain,
  parseChartTitle,
  validateAssembledScript,
} from "../_shared/mstr-chart-template.ts";
import {
  assembleDateScript,
  isDateScenario,
  parseDateLabels,
  parseDateNavSteps,
} from "../_shared/mstr-date-template.ts";
import {
  TREND_CHECK_KPI,
  assembleTrendCheckScript,
  isTrendCheckScenario,
  parseTrendChartTitle,
  parseTrendNavSteps,
  parseTrendTimeGrain,
} from "../_shared/mstr-trend-check-template.ts";
import {
  SCRIPT_GEN_SKILL_ID,
  SCRIPT_GEN_SKILL_LLM_BLOCK,
  SCRIPT_GEN_SKILL_VERSION,
  skillGeneratedBy,
} from "../_shared/script-gen-skill.ts";
import { runGenerateValidationLoop } from "../_shared/script-gen-validate-loop.ts";
import { ScriptAgentSessionLog } from "../_shared/script-agent-log.ts";
import { fetchCanonicalScript, insertScriptRow, updateScriptRow } from "../_shared/canonical-script.ts";

async function persistGeneratedScript(
  sb: ReturnType<typeof getSupabaseForRequest>,
  opts: {
    scenario_id: string;
    playwright_code: string;
    isReferenceTarget: boolean;
    mainShouldUseReferenceSource: boolean;
    credId: string | null;
    generatedBy: string;
  },
) {
  const { scenario_id, playwright_code, isReferenceTarget, mainShouldUseReferenceSource, credId, generatedBy } = opts;
  const { data: existing, error: existingErr } = await fetchCanonicalScript(
    sb,
    scenario_id,
    "id, assertion_spec, playwright_code, credential_profile_id",
  );
  if (existingErr) throw new Error(`Failed to look up existing script: ${existingErr.message}`);
  if (isReferenceTarget) {
    const prevSpec: any = (existing as any)?.assertion_spec || {};
    const nextSpec = {
      ...prevSpec,
      __reference_playwright_code: playwright_code,
      __reference_generated_by: generatedBy,
      __reference_generated_at: new Date().toISOString(),
    };
    if (existing) {
      const { data, error } = await updateScriptRow(sb, existing.id, { assertion_spec: nextSpec });
      if (error) throw new Error(`Failed to save reference script: ${error.message}`);
      return data;
    }
    const { data, error } = await insertScriptRow(sb, {
      scenario_id, playwright_code: "", assertion_spec: nextSpec, debug_status: "draft",
    });
    if (error) throw new Error(`Failed to insert reference script: ${error.message}`);
    return data;
  }
  if (existing) {
    const prevSpec: any = (existing as any).assertion_spec || {};
    const nextSpec = {
      ...prevSpec,
      __main_uses_reference_source: mainShouldUseReferenceSource || undefined,
      __generated_by: generatedBy,
      __generated_at: new Date().toISOString(),
      ...(String(generatedBy).includes("trend_check")
        ? {
          kpis: Array.isArray(prevSpec.kpis) && prevSpec.kpis.length ? prevSpec.kpis : [
            `${TREND_CHECK_KPI} Weekly`, `${TREND_CHECK_KPI} Monthly`, `${TREND_CHECK_KPI} Quarterly`,
          ],
          kpi_tolerances: prevSpec.kpi_tolerances && Object.keys(prevSpec.kpi_tolerances).length
            ? prevSpec.kpi_tolerances
            : {
              [`${TREND_CHECK_KPI} Weekly`]: { value: 0, unit: "pct", op: "eq" },
              [`${TREND_CHECK_KPI} Monthly`]: { value: 0, unit: "pct", op: "eq" },
              [`${TREND_CHECK_KPI} Quarterly`]: { value: 0, unit: "pct", op: "eq" },
            },
        }
        : {}),
    };
    const update: any = { playwright_code, debug_status: "draft", assertion_spec: nextSpec };
    if (mainShouldUseReferenceSource && credId) update.credential_profile_id = credId;
    const { data, error } = await updateScriptRow(sb, existing.id, update);
    if (error) throw new Error(`Failed to save generated script: ${error.message}`);
    if (!data?.playwright_code) throw new Error("Script save returned empty playwright_code");
    return data;
  }
  const insertRow: any = {
    scenario_id,
    playwright_code,
    debug_status: "draft",
    assertion_spec: {
      __generated_by: generatedBy,
      ...(mainShouldUseReferenceSource ? { __main_uses_reference_source: true } : {}),
      ...(String(generatedBy).includes("trend_check")
        ? {
          kpis: [`${TREND_CHECK_KPI} Weekly`, `${TREND_CHECK_KPI} Monthly`, `${TREND_CHECK_KPI} Quarterly`],
          kpi_tolerances: {
            [`${TREND_CHECK_KPI} Weekly`]: { value: 0, unit: "pct", op: "eq" },
            [`${TREND_CHECK_KPI} Monthly`]: { value: 0, unit: "pct", op: "eq" },
            [`${TREND_CHECK_KPI} Quarterly`]: { value: 0, unit: "pct", op: "eq" },
          },
        }
        : {}),
    },
  };
  if (mainShouldUseReferenceSource && credId) insertRow.credential_profile_id = credId;
  const { data, error } = await insertScriptRow(sb, insertRow);
  if (error) throw new Error(`Failed to insert generated script: ${error.message}`);
  if (!data?.playwright_code) throw new Error("Script insert returned empty playwright_code");
  return data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const unauthorized = await requireAuth(req);
  if (unauthorized) return unauthorized;
  let agentLog: ScriptAgentSessionLog | null = null;
  try {
    const body = await req.json();
    const scenario_id: string = body.scenario_id;
    const target: "main" | "reference" = body.target === "reference" ? "reference" : "main";
    const isReferenceTarget = target === "reference";
    // Campaign bulk: skip_validate / validate_max_attempts for faster gen + Cursor Debug.
    const forceSkipValidate = body.skip_validate === true;
    const forceMaxAttempts = Number.isFinite(Number(body.validate_max_attempts))
      ? Number(body.validate_max_attempts)
      : undefined;
    if (!scenario_id || typeof scenario_id !== "string") {
      return new Response(JSON.stringify({ error: "scenario_id is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    // Use the caller's JWT (same project/RLS as the UI). Avoid broken service-role placeholders.
    const sb = getSupabaseForRequest(req);
    const { data: scenario, error: scenarioErr } = await sb
      .from("scenarios")
      .select("*, reports(*)")
      .eq("id", scenario_id)
      .maybeSingle();
    if (scenarioErr) {
      throw new Error(`scenario lookup failed: ${scenarioErr.message}`);
    }
    if (!scenario) throw new Error(`scenario not found: ${scenario_id}`);

    const log = await ScriptAgentSessionLog.create({
      scenario_id,
      target,
      title: String(scenario.title || ""),
    });
    agentLog = log;

    const { data: templates } = await sb.from("sql_templates").select("id,name,sql_text,parameters");
    const { data: filterCombos } = await sb
      .from("scenario_filter_matrix")
      .select("id,label,filters")
      .eq("scenario_id", scenario_id)
      .order("created_at", { ascending: true });

    // Prefer the per-scenario script override; fall back to the report's profile.
    // For the reference target, prefer the reference credential profile.
    const { data: existingScript } = await fetchCanonicalScript(
      sb,
      scenario_id,
      "credential_profile_id, reference_credential_profile_id, assertion_spec",
    );

    // Heuristic: for warehouse_match scenarios where the description explicitly
    // says the FRONTEND source is the reference URL (e.g. "reference URL frontend
    // vs backend", "reference UI vs warehouse"), the MAIN test script should
    // scrape the reference URL with reference credentials instead of the main
    // report URL. Detect from the scenario title + description.
    const descBlob = `${scenario.title || ""}\n${scenario.description || ""}`.toLowerCase();
    const mentionsReferenceFrontend = /\breference\b[^.\n]*\b(url|frontend|ui|screen|link)\b/.test(descBlob)
      || /\bref(?:erence)?\s*(?:url|ui|frontend)\s*(?:vs|versus|against|→|->)\s*(?:backend|warehouse|be\b|db|sql)/.test(descBlob);
    const mainShouldUseReferenceSource = !isReferenceTarget
      && scenario.type === "warehouse_match"
      && mentionsReferenceFrontend;

    const useReferenceSource = isReferenceTarget || mainShouldUseReferenceSource;

    const credId = useReferenceSource
      ? ((existingScript as any)?.reference_credential_profile_id
          || scenario.reports?.reference_credential_profile_id
          || (existingScript as any)?.credential_profile_id
          || scenario.reports?.credential_profile_id
          || null)
      : (existingScript?.credential_profile_id || scenario.reports?.credential_profile_id || null);
    let cred: any = null;
    if (credId) {
      const { data } = await sb.from("credential_profiles").select("name,username,login_url").eq("id", credId).maybeSingle();
      cred = data;
    }
    // URL the script should target. For reference target (or main scripts whose
    // description points at the reference URL as the frontend source), prefer
    // the report's reference_url; if not set, fall back to the primary URL.
    const primaryUrl: string = scenario.reports?.url || "";
    const referenceUrl: string = (scenario.reports as any)?.reference_url || "";
    const targetUrl: string = useReferenceSource ? (referenceUrl || primaryUrl) : primaryUrl;

    // ── Skill-first: description picks KPI | chart | grid | date template.
    // Fixed: login, nav mechanics, filter application. Filled from UI/description:
    // URL, NAV_STEPS, KPI/chart/grid/date labels, TIME_GRAIN. Filter values = __filterCombinations.
    // Order: trend_check → geography_grid → kpi (when page says KPI) → chart_show_data → date_refresh → LLM
    type TemplateHit = {
      playwright_code: string;
      generatedBy: string;
      meta?: Record<string, unknown>;
    };

    const tryWorkingTemplates = async (): Promise<TemplateHit | null> => {
      await log.log("script-gen", "classify", "Matching working template from scenario description", {
        report_name: scenario.reports?.name || null,
        filter_combo_count: (filterCombos || []).length,
      });

      if (isTrendCheckScenario(scenario, existingScript)) {
        await log.log("script-gen", "template_try", "Trying trend_check template");
        try {
          const chartTitle = parseTrendChartTitle(scenario);
          const timeGrain = parseTrendTimeGrain(scenario, isReferenceTarget ? "reference" : "main");
          const navSteps = parseTrendNavSteps(scenario);
          const playwright_code = await assembleTrendCheckScript({
            reportUrl: normalizeReportUrl(targetUrl),
            chartTitle,
            timeGrain,
            navSteps,
          });
          const v = validateAssembledScript(playwright_code);
          if (v.ok) {
            await log.log("script-gen", "template_hit", "Assembled trend_check", {
              chart_title: chartTitle,
              time_grain: timeGrain,
              nav_steps: navSteps,
              code_bytes: playwright_code.length,
            });
            return {
              playwright_code,
              generatedBy: skillGeneratedBy("trend_check"),
              meta: {
                chart_title: chartTitle,
                time_grain: timeGrain,
                nav_steps: navSteps,
                kpi_labels: [`${TREND_CHECK_KPI} Weekly`, `${TREND_CHECK_KPI} Monthly`, `${TREND_CHECK_KPI} Quarterly`],
                skill: SCRIPT_GEN_SKILL_ID,
                skill_version: SCRIPT_GEN_SKILL_VERSION,
              },
            };
          }
          await log.log("script-gen", "template_reject", "trend_check assemble invalid", { reason: v.reason }, "warn");
        } catch (e) {
          await log.log(
            "script-gen",
            "template_error",
            "trend_check assemble failed",
            { error: String((e as Error)?.message || e) },
            "error",
          );
        }
      }

      if (isRecordCountScenario(scenario)) {
        await log.log("script-gen", "template_try", "Trying record_count template");
        const parsedNavSteps = parseGridNavSteps(scenario);
        const subTabs = parseSubTabs(scenario);
        if (subTabs.length > 0) {
          const navSteps = sanitizeRecordCountNavSteps(parsedNavSteps, subTabs);
          const playwright_code = await assembleRecordCountScript({
            reportUrl: normalizeReportUrl(targetUrl),
            navSteps,
            subTabs,
          });
          const v = validateAssembledScript(playwright_code);
          if (v.ok) {
            await log.log("script-gen", "template_hit", "Assembled record_count", {
              nav_steps: navSteps,
              sub_tabs: subTabs,
              code_bytes: playwright_code.length,
            });
            return {
              playwright_code,
              generatedBy: skillGeneratedBy("record_count"),
              meta: {
                nav_steps: navSteps,
                sub_tabs: subTabs,
                kpi_labels: subTabs.map((t: string) => `Row Count - ${t}`),
                skill: SCRIPT_GEN_SKILL_ID,
                skill_version: SCRIPT_GEN_SKILL_VERSION,
              },
            };
          }
          await log.log("script-gen", "template_reject", "record_count assemble invalid", { reason: v.reason }, "warn");
        } else {
          await log.log("script-gen", "template_reject", "record_count: no sub-tabs found in description", {}, "warn");
        }
      }

      if (isGridScenario(scenario, existingScript)) {
        await log.log("script-gen", "template_try", "Trying geography_grid template");
        const gridTitle = parseGridTitle(scenario);
        const timeGrain = parseGridTimeGrain(scenario, isReferenceTarget ? "reference" : "main");
        const tolKeys = Object.keys(existingScript?.assertion_spec?.kpi_tolerances || {}).filter(Boolean);
        const kpiFromSpec = Array.isArray(existingScript?.assertion_spec?.kpis)
          ? existingScript.assertion_spec.kpis.map((k: any) => String(k?.label || k?.name || k || "").trim()).find(Boolean)
          : "";
        // KPI container label from UI config / title — never invent a screen-specific default.
        const fromTitle = String(scenario?.title || "").replace(/\s+[–—-].*$/, "").trim();
        const kpiLabel = tolKeys[0] || kpiFromSpec || fromTitle || gridTitle || "Grid";
        const navSteps = parseGridNavSteps(scenario);
        const playwright_code = assembleGridScript({
          reportUrl: normalizeReportUrl(targetUrl),
          gridTitle,
          navSteps,
          expectedColumns: parseGridColumns(scenario, existingScript, gridTitle),
          timeGrain,
          kpiLabel,
        });
        const v = validateAssembledScript(playwright_code);
        if (v.ok) {
          await log.log("script-gen", "template_hit", "Assembled geography_grid", {
            grid_title: gridTitle,
            time_grain: timeGrain,
            nav_steps: navSteps,
            code_bytes: playwright_code.length,
          });
          return {
            playwright_code,
            generatedBy: skillGeneratedBy("geography_grid"),
            meta: {
              grid_title: gridTitle,
              time_grain: timeGrain,
              nav_steps: navSteps,
              skill: SCRIPT_GEN_SKILL_ID,
              skill_version: SCRIPT_GEN_SKILL_VERSION,
            },
          };
        }
        await log.log("script-gen", "template_reject", "geography_grid assemble invalid", { reason: v.reason }, "warn");
      }

      if (isKpiScenario(scenario, existingScript, isReferenceTarget)) {
        await log.log("script-gen", "template_try", "Trying kpi template");
        const kpiLabels = parseKpiLabels(scenario, existingScript, false);
        const navSteps = parseKpiNavSteps(scenario, []);
        const playwright_code = assembleKpiScript({
          reportUrl: normalizeReportUrl(targetUrl),
          kpiLabels,
          navSteps,
        });
        const v = validateAssembledScript(playwright_code);
        if (v.ok) {
          await log.log("script-gen", "template_hit", "Assembled kpi", {
            kpi_labels: kpiLabels,
            nav_steps: navSteps,
            code_bytes: playwright_code.length,
          });
          return {
            playwright_code,
            generatedBy: skillGeneratedBy("kpi"),
            // Explicit nav_steps from scenario (Overview often [], Activity ["Activity"]).
            meta: {
              kpi_labels: kpiLabels,
              nav_steps: navSteps,
              skill: SCRIPT_GEN_SKILL_ID,
              skill_version: SCRIPT_GEN_SKILL_VERSION,
            },
          };
        }
        await log.log("script-gen", "template_reject", "kpi assemble invalid", { reason: v.reason }, "warn");
      }

      if (isChartScenario(scenario, existingScript)) {
        await log.log("script-gen", "template_try", "Trying chart_show_data template");
        try {
          const chartTitle = parseChartTitle(scenario);
          const timeGrain = parseChartTimeGrain(scenario, isReferenceTarget ? "reference" : "main");
          const navSteps = parseChartNavSteps(scenario);
          const playwright_code = await assembleChartScript({
            reportUrl: normalizeReportUrl(targetUrl),
            chartTitle,
            timeGrain,
            navSteps,
          });
          const v = validateAssembledScript(playwright_code);
          if (v.ok) {
            await log.log("script-gen", "template_hit", "Assembled chart_show_data", {
              chart_title: chartTitle,
              time_grain: timeGrain,
              nav_steps: navSteps,
              code_bytes: playwright_code.length,
            });
            return {
              playwright_code,
              generatedBy: skillGeneratedBy("chart_show_data"),
              meta: {
                chart_title: chartTitle,
                time_grain: timeGrain,
                nav_steps: navSteps,
                skill: SCRIPT_GEN_SKILL_ID,
                skill_version: SCRIPT_GEN_SKILL_VERSION,
              },
            };
          }
          await log.log("script-gen", "template_reject", "chart_show_data assemble invalid", { reason: v.reason }, "warn");
        } catch (e) {
          await log.log(
            "script-gen",
            "template_error",
            "chart_show_data assemble failed",
            { error: String((e as Error)?.message || e) },
            "error",
          );
        }
      }

      if (isDateScenario(scenario, existingScript)) {
        await log.log("script-gen", "template_try", "Trying date_refresh template");
        const dateLabels = parseDateLabels(scenario, existingScript);
        const navSteps = parseDateNavSteps(scenario, []);
        const playwright_code = assembleDateScript({
          reportUrl: normalizeReportUrl(targetUrl),
          dateLabels,
          navSteps,
        });
        const v = validateAssembledScript(playwright_code);
        if (v.ok) {
          await log.log("script-gen", "template_hit", "Assembled date_refresh", {
            date_labels: dateLabels,
            nav_steps: navSteps,
            code_bytes: playwright_code.length,
          });
          return {
            playwright_code,
            generatedBy: skillGeneratedBy("date_refresh"),
            meta: {
              date_labels: dateLabels,
              kpi_labels: dateLabels,
              nav_steps: navSteps,
              skill: SCRIPT_GEN_SKILL_ID,
              skill_version: SCRIPT_GEN_SKILL_VERSION,
            },
          };
        }
        await log.log("script-gen", "template_reject", "date_refresh assemble invalid", { reason: v.reason }, "warn");
      }

      await log.log("script-gen", "template_miss", "No working template matched — falling back to LLM");
      return null;
    };

    const templated = await tryWorkingTemplates();
    if (templated) {
      const isTrendSkill = String(templated.generatedBy || "").includes("trend_check");
      const validated = await runGenerateValidationLoop({
        req,
        scenarioId: scenario_id,
        scenario,
        target,
        reportUrl: normalizeReportUrl(targetUrl),
        initialCode: templated.playwright_code,
        generatedBy: templated.generatedBy,
        meta: templated.meta,
        filterCombos: (filterCombos || []).map((c: any) => ({
          label: c.label,
          filters: c.filters || {},
        })),
        log,
        // Trend template is deterministic (all three grains). Skip Browserless
        // validate + Magentic repair so Generate returns the script immediately.
        forceSkip: forceSkipValidate || isTrendSkill,
        forceMaxAttempts,
      });
      const inserted = await persistGeneratedScript(sb, {
        scenario_id,
        playwright_code: validated.playwright_code,
        isReferenceTarget,
        mainShouldUseReferenceSource,
        credId,
        generatedBy: validated.generatedBy,
      });
      await log.finish(validated.validation.passed || !validated.validation.enabled ? "ok" : "failed", {
        path: "template",
        generated_by: validated.generatedBy,
        validation: {
          enabled: validated.validation.enabled,
          passed: validated.validation.passed,
          attempts: validated.validation.attempts,
          skipped_reason: validated.validation.skipped_reason || null,
        },
        log_file: log.getLogFile(),
        json_log_file: log.getJsonLogFile(),
      });
      return new Response(
        JSON.stringify({
          script: inserted,
          target,
          generated_by: validated.generatedBy,
          report_url: normalizeReportUrl(targetUrl),
          validation: validated.validation,
          log_file: log.getLogFile(),
          json_log_file: log.getJsonLogFile(),
          ...(validated.meta || templated.meta || {}),
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const sys = `You generate Playwright scripts for Browserless.io /function endpoint that scrape BI report KPIs.

${SCRIPT_GEN_SKILL_LLM_BLOCK}

═══════════════════════════════════════════════════════
CRITICAL RULES — NEVER VIOLATE THESE
═══════════════════════════════════════════════════════
1. JavaScript ONLY. No Python syntax (no import/from/def/async def).
2. Exact function signature: export default async ({ page }) => { ... };
3. NEVER use page.waitForTimeout() — use: const sleep = ms => new Promise(r => setTimeout(r, ms));
4. NEVER use .locator(), .first(), .nth(), .all(), .filter() — Browserless does not support locator chaining.
5. ALL DOM interaction must go through page.evaluate(), page.click(), page.type(), page.waitForSelector(), page.waitForFunction().
6. NEVER use { waitUntil: 'networkidle' } — use 'domcontentloaded' only.
7. Do NOT hardcode credentials — always use __creds.username / __creds.password.
8. Do NOT hardcode filter values — always read from __filterCombinations at runtime.

═══════════════════════════════════════════════════════
TEMPLATE-FIRST TRAINING (when you must generate — no matching working template)
═══════════════════════════════════════════════════════
You are the FALLBACK after proven templates (Overview KPI, Activity KPI, Geography grid,
chart Show Data). Mimic those working scripts — do NOT invent new filter cadence or waits.

MUST KEEP IDENTICAL TO WORKING SCRIPTS:
1. Geography filter cadence — apply in this order only:
     GEO_ORDER = ['Area', 'Region', 'Territory', 'Time Bucket']
   (or omit Time Bucket only when the Overview KPI template style is clearly required:
     ['Area', 'Region', 'Territory']). Never invent a different geo order.
2. After EVERY successful filter pick AND before extraction:
     await waitForLoadingToFinish();
     await waitForDashboard();
3. KPI pass-value extraction: use extractKPI(label) that prefers the LARGEST font-size
   numeric leaf under the label (headline pass value), NOT the small "vs. Previous" delta.
4. Charts / trends: NEVER scrape canvas/SVG. Use Show Data popup only:
     clickChartTimeGrain(grain, chartTitle) → openShowData → waitForShowDataPopup →
     extractShowDataTable → closeShowDataPopup.
   Weekly/Monthly/Quarterly are chart radios — NEVER put them in NAV_STEPS.
5. Filters come ONLY from __filterCombinations at runtime — never hardcode Area/Region values.

═══════════════════════════════════════════════════════
CRITICAL RULES — NEVER VIOLATE THESE
═══════════════════════════════════════════════════════
1. JavaScript ONLY. No Python syntax (no import/from/def/async def).
2. Exact function signature: export default async ({ page }) => { ... };
3. NEVER use page.waitForTimeout() — use: const sleep = ms => new Promise(r => setTimeout(r, ms));
4. NEVER use .locator(), .first(), .nth(), .all(), .filter() — Browserless does not support locator chaining.
5. ALL DOM interaction must go through page.evaluate(), page.click(), page.type(), page.waitForSelector(), page.waitForFunction().
6. NEVER use { waitUntil: 'networkidle' } — use 'domcontentloaded' only.
7. Do NOT hardcode credentials — always use __creds.username / __creds.password.
8. Do NOT hardcode filter values — always read from __filterCombinations at runtime.

═══════════════════════════════════════════════════════
VIEWPORT + PAGE ZOOM (mandatory — set BEFORE anything else)
═══════════════════════════════════════════════════════
page.setViewport works in this sandbox. Set it before navigation, then
ALWAYS set Chrome-style page zoom to 100% (full size, not 67%). Try both
setViewport and setViewportSize since Browserless exposes one or the other:

  const tryWidenViewport = async () => {
    try { if (typeof page.setViewport === 'function') await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 }); } catch (_) {}
    try { if (typeof page.setViewportSize === 'function') await page.setViewportSize({ width: 1920, height: 1080 }); } catch (_) {}
    try {
      await page.evaluate(() => {
        document.documentElement.style.zoom = '100%';
        if (document.body) document.body.style.zoom = '100%';
      });
    } catch (_) {}
  };
  await tryWidenViewport();

Call tryWidenViewport() again right after each successful login and after
each report re-navigation (Browserless sometimes resets the viewport across
context boundaries).

═══════════════════════════════════════════════════════
AUTH PATTERN (mandatory — supports BOTH login UIs)
═══════════════════════════════════════════════════════
There are TWO login UIs you must handle. Do NOT hardcode either one:

  Legacy MicroStrategy login:
    • username field: #Uid (also input[type="text"])
    • password field: #Pwd (also input[type="password"])
    • submit: input[value="Login"] / input[value="LogIn"] / button[type="submit"]

  New MicroStrategy Library "Log in with Credentials" login:
    • NO #Uid / #Pwd ids exist
    • username field: input[placeholder*="User name" i] / input[name*="user" i] / input[id*="user" i]
    • password field: input[type="password"] / input[placeholder*="password" i]
    • submit: a <button>/<div role="button">/<a> whose visible text (normalized,
      case-insensitive) is exactly "Log in with Credentials", OR matches /log ?in/
      as a fallback. There is NO <input type="submit"> — you MUST match by text.

Detection MUST accept either shape (presence of a password input or a user-name
placeholder or a visible "Log in" button = login form present). Submission MUST
prefer clicking the "Log in with Credentials" button by text; if not found,
fall back to form.requestSubmit()/submit() on the enclosing <form>.

Copy this pattern:

  const detectLoginForm = () => page.evaluate(() => {
    const norm = s => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const hasUserField = !!document.querySelector(
      'input[placeholder*="user name" i], input[name*="user" i], input[id*="user" i], #Uid'
    );
    const hasPwdField = !!document.querySelector('input[type="password"], #Pwd');
    const hasLoginBtn = Array.from(document.querySelectorAll('button, input[type="submit"], div[role="button"], a'))
      .some(el => /log ?in/.test(norm(el.innerText || el.value || '')));
    return hasUserField || hasPwdField || hasLoginBtn;
  }).catch(() => false);

  const fillAndSubmitLogin = async (username, password) => {
    const userSel = '#Uid, input[placeholder*="user name" i], input[name*="user" i], input[id*="user" i], input[type="text"]';
    const pwdSel  = '#Pwd, input[type="password"], input[placeholder*="password" i]';
    await page.type(userSel, username).catch(() => {});
    await page.type(pwdSel, password).catch(() => {});
    const clicked = await page.evaluate((pSel) => {
      const norm = s => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const cands = Array.from(document.querySelectorAll('button, input[type="submit"], div[role="button"], a'));
      let btn = cands.find(el => norm(el.innerText || el.value || '') === 'log in with credentials');
      if (!btn) btn = cands.find(el => /log ?in/.test(norm(el.innerText || el.value || '')));
      if (btn) { btn.click(); return true; }
      const pwd = document.querySelector(pSel);
      const form = pwd && pwd.closest('form');
      if (form) { (form.requestSubmit ? form.requestSubmit() : form.submit()); return true; }
      return false;
    }, pwdSel).catch(() => false);
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null),
      sleep(3000),
    ]);
    return clicked;
  };

  await page.goto(reportUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await sleep(2000);
  let hasLoginForm = await detectLoginForm();
  if (hasLoginForm && typeof __creds !== 'undefined' && __creds?.username) {
    const onLoginPage = await page.evaluate(() => /\\/auth\\/ui\\/loginPage/i.test(location.href)).catch(() => false);
    if (!onLoginPage && __creds.loginUrl) {
      await page.goto(__creds.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(1000);
    }
    await fillAndSubmitLogin(__creds.username, __creds.password);
    await sleep(1500);
    const loginFailed = await page.evaluate(() =>
      /login\\s*failure|error\\s*in\\s*login|invalid (user|credentials|password)|incorrect (user|password)/i.test(document.body.innerText || '')
    ).catch(() => false);
    if (loginFailed) return { ok: false, error: 'LOGIN_FAILED', message: 'Credentials rejected by the login page' };
    await page.goto(reportUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(2000);
    hasLoginForm = await detectLoginForm();
    if (hasLoginForm) return { ok: false, error: 'LOGIN_FAILED', message: 'Still on login page after submitting credentials' };
  } else if (hasLoginForm) {
    return { ok: false, error: 'AUTH_REQUIRED', message: 'Login form present but no credentials provided' };
  }
  await tryWidenViewport();
  // If no login form: existing session is active, proceed.


═══════════════════════════════════════════════════════
WAITING FOR REPORT TO RENDER (mandatory pattern)
═══════════════════════════════════════════════════════
Never use fixed sleeps to wait for report content. The report shows a "Loading Data..."
modal (with a Cancel button) whenever a filter is applied, the page is reloaded, or
cascaded filters refresh. You MUST always wait for that overlay to disappear before
reading any KPI value or applying the next filter — otherwise you will scrape stale
numbers from the previous filter state.

  // Returns when the "Loading Data..." overlay (and any MicroStrategy WaitBox) is gone
  // and has stayed gone for ~800ms (to absorb cascaded refreshes that fire in bursts).
  const waitForLoadingToFinish = async (maxMs = 45000) => {
    const start = Date.now();
    await sleep(400); // give the spinner a chance to appear after a click
    const isLoading = () => page.evaluate(() => {
      const bodyText = document.body ? document.body.innerText : '';
      if (/Loading\\s*Data/i.test(bodyText)) {
        for (const el of Array.from(document.querySelectorAll('*'))) {
          let direct = '';
          for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) direct += n.textContent;
          if (!/Loading\\s*Data/i.test(direct)) continue;
          const r = el.getBoundingClientRect();
          const st = window.getComputedStyle(el);
          if (r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none')
            return true;
        }
      }
      const spin = document.querySelector(
        '.mstrmojo-WaitBox, .mstrmojo-Wait, .mstrWaitBox, [class*="WaitBox" i], [class*="loading" i][class*="overlay" i]'
      );
      if (spin) {
        const r = spin.getBoundingClientRect();
        const st = window.getComputedStyle(spin);
        if (r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none')
          return true;
      }
      return false;
    }).catch(() => false);
    while (Date.now() - start < maxMs) {
      const loading = await isLoading();
      if (!loading) {
        await sleep(800);
        if (!(await isLoading())) return;
      }
      await sleep(400);
    }
  };

  const waitForDashboard = async (maxMs = 20000) => {
    await waitForLoadingToFinish(maxMs);
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const found = await page.evaluate(() => {
        function getDirectText(el) {
          let text = '';
          for (const node of el.childNodes)
            if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
          return text.trim();
        }
        return Array.from(document.querySelectorAll('*'))
          .some(el => /YOUR_STABLE_LABEL/i.test(getDirectText(el)));
      }).catch(() => false);
      if (found) break;
      await sleep(500);
    }
    // Final guard — a cascaded refresh can re-trigger the spinner.
    await waitForLoadingToFinish(maxMs);
  };
Replace YOUR_STABLE_LABEL with a label that exists on the TARGET tab AFTER NAV_STEPS
(e.g. the first KPI on that screen, or the grid/chart title). Do NOT use "NBRx Total"
if that tile only exists on Overview and you are going to Performance / Geography / Activity.
Call waitForDashboard AFTER tab navigation, never before. Before nav, only
waitForLoadingToFinish (and/or wait until the filter bar / Area / footer tabs are visible).

═══════════════════════════════════════════════════════
FILTER APPLICATION (MicroStrategy classic + new Library / Athena UI)
═══════════════════════════════════════════════════════
BI report filters come in THREE flavours and your selectByLabel MUST try
each in order, because the new MicroStrategy Library ("Athena") UI does
NOT use .mstrmojo-DocSelector widgets at all — it renders custom
React/Angular dropdowns. If you only look for .mstrmojo-DocSelector you
will fail on the new UI with "No selector found near: <Label>".

Try, in order, for each filter label:
  1) A native <select> visually near the label (dispatch input+change)
  2) The legacy .mstrmojo-DocSelector widget (classic MicroStrategy)
  3) Click the visible "current value" element directly under/right of
     the label to open a custom dropdown, then click the option in the
     newly-visible list/menu/listbox.

You MUST also force-close any stray open dropdown between filters (dispatch
Escape + click a neutral corner) — the new UI's overlays don't self-dismiss
and will cover the next filter control.

STEP 1 — Extract code from filter value (e.g. "AB34 - St. Louis" → "AB34"):
  const extractCode = val => (val || '').trim().split(/\\s+/)[0].trim();

STEP 2 — closeAnyOpenDropdown helper (call before each selectByLabel and
after every successful pick):

  const closeAnyOpenDropdown = async () => {
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Escape', code: 'Escape', bubbles: true }));
      const x = 5, y = Math.max(5, window.innerHeight - 5);
      const opts = { bubbles: true, clientX: x, clientY: y };
      document.body.dispatchEvent(new MouseEvent('mousedown', opts));
      document.body.dispatchEvent(new MouseEvent('mouseup',   opts));
      document.body.dispatchEvent(new MouseEvent('click',     opts));
    }).catch(() => {});
    await sleep(300);
  };

STEP 3 — selectByLabel with 3-strategy fallback (COPY THIS EXACTLY, do not
strip the native-<select> or click-current-value branches — the new UI
depends on them):

  const selectByLabel = async (labelText, optionText) => {
    await closeAnyOpenDropdown();
    const result = await page.evaluate((label, opt) => {
      function getDirectText(el) {
        let t = '';
        for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) t += n.textContent;
        return t.trim();
      }
      const norm = s => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const extractCode = v => norm(v).split(/\\s+/)[0].trim();
      const optCode = extractCode(opt);
      const normOpt = norm(opt);
      const isVisible = el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const st = getComputedStyle(el);
        return st.visibility !== 'hidden' && st.display !== 'none';
      };
      // find label (smallest visible exact match)
      let labelEl = null, labelArea = Infinity;
      for (const el of Array.from(document.querySelectorAll('*'))) {
        if (!isVisible(el)) continue;
        if (norm(getDirectText(el)) !== norm(label)) continue;
        const r = el.getBoundingClientRect();
        const area = r.width * r.height;
        if (area < labelArea) { labelEl = el; labelArea = area; }
      }
      if (!labelEl) return { error: 'Label not found: ' + label };
      const lr = labelEl.getBoundingClientRect();

      // 1) native <select> near the label
      let bestSelect = null, bestDist = Infinity;
      for (const s of Array.from(document.querySelectorAll('select'))) {
        if (!isVisible(s)) continue;
        const r = s.getBoundingClientRect();
        const dist = Math.abs(r.top - lr.top) + Math.abs(r.left - lr.left);
        if (dist < 200 && dist < bestDist) { bestSelect = s; bestDist = dist; }
      }
      if (bestSelect) {
        const options = Array.from(bestSelect.options);
        let m = options.find(o => extractCode(o.textContent) === optCode)
             || options.find(o => norm(o.textContent) === normOpt)
             || options.find(o => norm(o.textContent).startsWith(normOpt) || normOpt.startsWith(norm(o.textContent)));
        if (m) {
          bestSelect.value = m.value;
          bestSelect.dispatchEvent(new Event('input',  { bubbles: true }));
          bestSelect.dispatchEvent(new Event('change', { bubbles: true }));
          return { clicked: true, via: 'native-select', option: m.textContent.trim() };
        }
      }

      // 2) legacy .mstrmojo-DocSelector widget
      const legacy = Array.from(document.querySelectorAll('.mstrmojo-DocSelector'));
      if (legacy.length) {
        const withCode = [], withoutCode = [];
        for (const sel of legacy) {
          const r = sel.getBoundingClientRect();
          if (Math.abs(r.top - lr.top) > 40) continue;
          if (r.left < lr.left - 10) continue;
          const dist = Math.abs(r.left - lr.left);
          let hasCode = false;
          for (const c of Array.from(sel.querySelectorAll('*')))
            if (extractCode(getDirectText(c)) === optCode) { hasCode = true; break; }
          (hasCode ? withCode : withoutCode).push({ sel, dist });
        }
        withCode.sort((a, b) => a.dist - b.dist);
        withoutCode.sort((a, b) => a.dist - b.dist);
        const best = withCode[0]?.sel || withoutCode[0]?.sel;
        if (best) {
          for (const c of Array.from(best.querySelectorAll('*'))) {
            const d = getDirectText(c);
            if (!d || d.length < 2) continue;
            if (extractCode(d) === optCode) { c.click(); return { clicked: true, via: 'legacy-selector', option: d }; }
          }
        }
      }

      // 3) click the visible "current value" element under/right of the label
      let valueEl = null, valueDist = Infinity;
      for (const el of Array.from(document.querySelectorAll('*'))) {
        if (!isVisible(el)) continue;
        const d = getDirectText(el);
        if (!d || norm(d) === norm(label)) continue;
        const r = el.getBoundingClientRect();
        if (r.top < lr.top - 2) continue;
        if (r.top - lr.top > 60) continue;
        const dx = Math.abs(r.left - lr.left);
        if (dx > 250) continue;
        const dist = (r.top - lr.top) + dx;
        if (dist < valueDist) { valueDist = dist; valueEl = el; }
      }
      if (valueEl) { valueEl.click(); return { opened: true, via: 'click-current-value', clickedText: getDirectText(valueEl) }; }

      // debug snapshot
      const nearby = [];
      for (const el of Array.from(document.querySelectorAll('*'))) {
        if (!isVisible(el)) continue;
        const r = el.getBoundingClientRect();
        if (Math.abs(r.top - lr.top) > 80 || Math.abs(r.left - lr.left) > 300) continue;
        const t = getDirectText(el);
        if (!t) continue;
        nearby.push({ tag: el.tagName, cls: (el.className || '').toString().substring(0, 60), text: t.substring(0, 40) });
        if (nearby.length >= 8) break;
      }
      return { error: 'No selector or clickable value found near: ' + label, nearby };
    }, labelText, optionText).catch(() => ({ error: 'evaluate failed for ' + labelText }));

    if (result.clicked) {
      await closeAnyOpenDropdown();
      await waitForLoadingToFinish();
      await waitForDashboard();
      return { ok: true, ...result };
    }

    if (result.opened) {
      // A custom dropdown/menu should now be visible — pick the option.
      await sleep(400);
      const picked = await page.evaluate((opt) => {
        const norm = s => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
        const optCode = norm(opt).split(/\\s+/)[0];
        const normOpt = norm(opt);
        const isVisible = el => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          const st = getComputedStyle(el);
          return st.visibility !== 'hidden' && st.display !== 'none';
        };
        const cands = Array.from(document.querySelectorAll(
          'li, [role="option"], [role="menuitem"], [role="listbox"] *, ul *, div, span, td'
        ));
        let exact = null, codeMatch = null, contains = null;
        for (const el of cands) {
          if (!isVisible(el)) continue;
          const t = norm(el.innerText || el.textContent || '');
          if (!t || t.length > 60) continue;
          if (t === normOpt && !exact) exact = el;
          else if (t.split(/\\s+/)[0] === optCode && !codeMatch) codeMatch = el;
          else if (t.includes(normOpt) && !contains) contains = el;
        }
        const best = exact || codeMatch || contains;
        if (best) { best.click(); return { clicked: true, text: (best.innerText || best.textContent || '').trim().substring(0, 60) }; }
        return null;
      }, optionText).catch(() => null);
      if (picked && picked.clicked) {
        await closeAnyOpenDropdown();
        await waitForLoadingToFinish();
        await waitForDashboard();
        return { ok: true, via: 'opened-then-picked', ...picked };
      }
      return { ok: false, error: 'Opened dropdown for ' + labelText + ' but option not found: ' + optionText, clickedTo: result.clickedText };
    }

    return { ok: false, ...result };
  };

STEP 4 — Apply filters FULLY DYNAMICALLY. The generated code MUST iterate over
Object.keys(filters) at runtime and call selectByLabel(key, filters[key]) for
each one. You are STRICTLY FORBIDDEN from writing per-label if-blocks like
\`if (filters['Area']) { ... } if (filters['Time Bucket']) { ... }\`. Hardcoding
any specific label name (Area, Region, Territory, Time Bucket, Specialty,
Territory Type, etc.) in an if-condition or as a string literal lookup against
\`filters\` is a critical bug — when the user later adds a new filter to the
combination, that filter must be applied automatically without regenerating
the script's filter section.

selectByLabel already waits for the dashboard to finish reloading after each
pick, which covers cascading dependencies (Region options depend on chosen
Area, etc.). Do NOT re-implement waitForSelectorContent — it assumes the
legacy widget and breaks on the new UI.

Use EXACTLY this pattern (do not specialize, do not unroll, do not add named
checks). The only hardcoded list allowed is the geo cascade order, used purely
to decide ordering — every key in \`filters\` (geo or not) is still applied via
the same generic loop:

  const GEO_ORDER = ['Area', 'Region', 'Territory'];
  const allKeys = Object.keys(filters);
  const geoKeys = GEO_ORDER.filter(k => allKeys.includes(k));
  const otherKeys = allKeys.filter(k => !GEO_ORDER.includes(k));
  for (const key of geoKeys) {
    debug[key] = await selectByLabel(key, filters[key]);
  }
  for (const key of otherKeys) {
    debug[key] = await selectByLabel(key, filters[key]);
  }
  await closeAnyOpenDropdown();

═══════════════════════════════════════════════════════
IN-REPORT NAVIGATION (tabs / screens / sub-tabs / radios)
═══════════════════════════════════════════════════════
The scenario title/description may instruct the script to navigate WITHIN the
report after it loads — e.g. "go to Performance screen, then Performance Trend
tab, then select Monthly in Overall Performance". You MUST parse these steps
from the natural-language description and execute them, IN ORDER, AFTER auth
+ initial dashboard load, BEFORE applying filters / extracting KPIs.

Recognise navigation cues such as:
  • "go to <X> screen / page / view / section"
  • "open <X> tab / sub-tab"
  • "click on <X>"
  • "select <X>" (radio buttons, toggle pills like Weekly / Monthly / Quarterly)
  • "switch to <X>"
  • bottom-nav items shown as icon+label (Overview, Performance, HCP Customer, …)

Use these generic helpers — do NOT hardcode any specific tab name in an
if-block; drive the click sequence purely from the parsed step list.

  // Click any visible element matching \`text\`. Search order: exact direct
  // text → aria-label/title/alt/data-tooltip → contains-match on innerText
  // (smallest clickable element wins). Searches the top document AND every
  // same-origin iframe (MicroStrategy often renders into nested frames).
  // Prefers smallest bounding rect so we pick the actual tab/label cell.
  // Falls back to input[type=radio] + adjacent <label> for radio pills.
  //
  // If \`openers\` is provided (e.g. ['Menu', 'Navigation']), and the target
  // is not found, the helper clicks each opener once (to expand a hamburger
  // / nav drawer) and retries. The generated script SHOULD pass common
  // openers like ['Menu','Navigation','More','☰'] so icon-only nav buttons
  // are tried automatically when a tab name is missing on the visible page.
  const clickByText = async (text, { scope, openers } = {}) => {
    const tryClick = () => page.evaluate((label, scopeSel) => {
      function getDirectText(el) {
        let t = '';
        for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) t += n.textContent;
        return t.trim();
      }
      const norm = s => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const target = norm(label);
      const isVisible = el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const st = el.ownerDocument.defaultView.getComputedStyle(el);
        return st.visibility !== 'hidden' && st.display !== 'none';
      };
      const roots = [];
      const pushRoot = (root) => {
        if (!root) return;
        if (scopeSel) { const s = root.querySelector(scopeSel); if (s) roots.push(s); }
        else roots.push(root);
      };
      pushRoot(document);
      for (const f of Array.from(document.querySelectorAll('iframe, frame'))) {
        try { pushRoot(f.contentDocument); } catch (_) { /* cross-origin */ }
      }
      const exact = [], attr = [], contains = [];
      for (const root of roots) {
        for (const el of Array.from(root.querySelectorAll('*'))) {
          if (!isVisible(el)) continue;
          const direct = getDirectText(el);
          if (direct && norm(direct) === target) {
            const r = el.getBoundingClientRect();
            exact.push({ el, area: r.width * r.height });
            continue;
          }
          const al = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('data-tooltip'));
          if (al && norm(al) === target) {
            const r = el.getBoundingClientRect();
            attr.push({ el, area: r.width * r.height });
          }
        }
        for (const el of Array.from(root.querySelectorAll('a, button, li, div, span, td, [role="tab"], [role="menuitem"], [role="button"]'))) {
          if (!isVisible(el)) continue;
          const it = norm(el.innerText || el.textContent || '');
          if (!it || !it.includes(target)) continue;
          const r = el.getBoundingClientRect();
          if (r.width * r.height > 200000) continue;
          contains.push({ el, area: r.width * r.height, len: it.length });
        }
      }
      exact.sort((a, b) => a.area - b.area);
      attr.sort((a, b) => a.area - b.area);
      contains.sort((a, b) => (a.len - b.len) || (a.area - b.area));
      const best = exact[0] || attr[0] || contains[0];
      if (best) {
        const el = best.el;
        const forId = el.getAttribute && el.getAttribute('for');
        if (forId) {
          const inp = el.ownerDocument.getElementById(forId);
          if (inp) { inp.click(); return { clicked: true, via: 'label-for', text: label }; }
        }
        const innerRadio = el.querySelector && el.querySelector('input[type="radio"], input[type="checkbox"]');
        if (innerRadio) { innerRadio.click(); return { clicked: true, via: 'inner-radio', text: label }; }
        el.click();
        return { clicked: true, via: exact[0] ? 'text' : attr[0] ? 'attr' : 'contains', text: label };
      }
      for (const inp of Array.from(document.querySelectorAll('input[type="radio"], input[type="checkbox"]'))) {
        const id = inp.id;
        if (id) {
          const lab = document.querySelector('label[for="' + id + '"]');
          if (lab && norm(lab.innerText || '') === target) { inp.click(); return { clicked: true, via: 'radio-label', text: label }; }
        }
        const parent = inp.parentElement;
        if (parent && norm(parent.innerText || '') === target) { inp.click(); return { clicked: true, via: 'radio-parent', text: label }; }
      }
      return { error: 'navigation target not found: ' + label };
    }, text, scope || null).catch(() => ({ error: 'evaluate failed: ' + text }));

    let res = await tryClick();
    if (res && res.error && Array.isArray(openers) && openers.length) {
      for (const op of openers) {
        const opened = await page.evaluate((opLabel) => {
          const norm = s => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
          const target = norm(opLabel);
          for (const el of Array.from(document.querySelectorAll('*'))) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            const al = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt'));
            const t = norm(el.innerText || '');
            if ((al && norm(al) === target) || (t && t === target)) { el.click(); return true; }
          }
          return false;
        }, op).catch(() => false);
        if (opened) {
          await sleep(600);
          res = await tryClick();
          if (res && !res.error) break;
        }
      }
    }
    await waitForLoadingToFinish();
    return res;
  };

  // Apply the parsed navigation steps in order. Stop on the first failure
  // and record it in the result so the run shows what step broke. Always
  // pass common menu/drawer openers so icon-only nav (hamburger, ☰, "More")
  // is tried automatically when a tab name is not visible on the page.
  const NAV_STEPS = [ /* e.g. 'Performance', 'Performance Trend', 'Monthly' */ ];
  const NAV_OPENERS = ['Menu', 'Navigation', 'More', 'Open menu', 'Main menu', '☰'];
  const navDebug = [];
  for (const step of NAV_STEPS) {
    const r = await clickByText(step, { openers: NAV_OPENERS });
    navDebug.push({ step, ...r });
    if (r && r.error) break;
  }
  await waitForDashboard();

The generated script MUST include a NAV_STEPS array built from the
description (in order) and execute the loop above immediately AFTER
waitForLoadingToFinish (page load / dossier chrome), BEFORE waitForDashboard
(target-tab KPI/grid/chart labels) and BEFORE the filter-combinations loop.
Do not wait for expected columns or KPI labels until the required tab is open.
Include \`navigation\` (= navDebug) in the returned result object alongside the KPI
values so the run can show which tab clicks succeeded.

═══════════════════════════════════════════════════════
KPI EXTRACTION
═══════════════════════════════════════════════════════
KPI tiles render the headline value in a LARGE font and the "vs. Previous"
delta in a much smaller font directly beneath it. Both numbers sit under the
same label and are vertically close, so a pure distance-based score will
incorrectly pick the smaller delta (e.g. NBRx Total returning "3" instead of
"36.0"). The extractor MUST prefer the visually largest numeric element under
the label, scoped tightly to the label's tile.

Rules:
  1. Find ALL visible elements whose direct text is an EXACT match
     (case-insensitive, whitespace-collapsed) for the label. Sort by smallest
     bounding rect (most specific element first) so you anchor to the actual
     label cell, not a parent wrapper.
  2. For each label anchor (in order), search for numeric candidates. Return
     the first anchor that yields at least one candidate — this makes the
     extractor robust when the DOM has duplicate label nodes.
  3. Consider ANY element whose direct text is a pure number (optional $,
     commas, decimals, %). Restrict to leaf-like elements (no element children
     with text) so you don't double-count container nodes.
  4. Keep only candidates whose horizontal center is within
     max(80, label.width/2 + 40) of the label center AND whose top is at or
     below the label and within 120px (NOT 250px). The tighter vertical window
     is critical: it prevents values from unrelated sections that happen to
     sit below the label (e.g. "NBRx New Writers = 5" ~200px below "NBRx Total")
     from being mistakenly returned.
  5. Among surviving candidates, pick the one with the LARGEST computed
     font-size. The headline KPI is always the biggest number in the tile.
     Tie-break by smallest |Δcenter-x|, then smallest Δy.

  const extractKPI = async (labelText) => {
    return await page.evaluate((label) => {
      function getDirectText(el) {
        let text = '';
        for (const node of el.childNodes)
          if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
        return text.trim();
      }
      function hasElementChildren(el) {
        for (const node of el.childNodes)
          if (node.nodeType === Node.ELEMENT_NODE) return true;
        return false;
      }
      const norm = s => s.replace(/\\s+/g, ' ').trim().toLowerCase();
      const target = norm(label);
      // Step 1: collect ALL exact-match label elements, smallest area first
      const labelMatches = [];
      for (const el of Array.from(document.querySelectorAll('*'))) {
        const direct = getDirectText(el);
        if (!direct || norm(direct) !== target) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        labelMatches.push({ el, r, area: r.width * r.height });
      }
      if (!labelMatches.length) return { error: 'Label not found: ' + label };
      labelMatches.sort((a, b) => a.area - b.area);
      const numRe = /^\\s*[$]?\\s*-?[\\d,]+(\\.[\\d]+)?\\s*%?\\s*$/;
      // Step 2: try each label anchor until one yields a numeric candidate
      for (const { r: lr } of labelMatches) {
        const labelCx = lr.left + lr.width / 2;
        const maxDx = Math.max(80, lr.width / 2 + 40);
        const candidates = [];
        for (const el of Array.from(document.querySelectorAll('*'))) {
          if (hasElementChildren(el)) continue;
          const direct = getDirectText(el);
          if (!numRe.test(direct)) continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (r.top < lr.top + lr.height - 2) continue;
          if (r.top > lr.top + 120) continue;   // tight window — excludes unrelated sections
          const cx = r.left + r.width / 2;
          if (Math.abs(cx - labelCx) > maxDx) continue;
          const fs = parseFloat(getComputedStyle(el).fontSize) || 0;
          candidates.push({ text: direct.trim(), fs, dx: Math.abs(cx - labelCx), dy: r.top - lr.top });
        }
        if (!candidates.length) continue; // try next label anchor
        // Largest font = headline KPI value; tie-break by proximity
        candidates.sort((a, b) => (b.fs - a.fs) || (a.dx - b.dx) || (a.dy - b.dy));
        return { value: candidates[0].text };
      }
      return { error: 'No value found near label: ' + label };
    }, labelText).catch(() => ({ error: 'evaluate failed' }));
  };



═══════════════════════════════════════════════════════
RESULT KEY NAMING (mandatory — do NOT use "KPI_value")
═══════════════════════════════════════════════════════
You MUST return each KPI under a key that matches its EXACT label as given
in the KPI config (e.g. "NBRx Total", "TRx Total"). Do NOT use a generic
"KPI_value" key, do NOT invent abbreviations, do NOT change case, and do
NOT drop spaces or symbols. If multiple KPI labels are listed in the
config, scrape ALL of them and emit one key per label.

Per filter combination, the value MUST be an object of the form:
  {
    "<Exact KPI Label 1>": <number|null>,
    "<Exact KPI Label 2>": <number|null>,
    ...,
    "filters_applied": { ...debug map from selectByLabel... }
  }

═══════════════════════════════════════════════════════
FILTER COMBINATIONS LOOP (mandatory structure)
═══════════════════════════════════════════════════════
  // Hard-code the exact KPI labels from the provided KPI config — verbatim.
  const KPI_LABELS = [ /* e.g. "NBRx Total", "TRx Total" */ ];
  const toNum = v => (v == null ? null : parseFloat(String(v).replace(/[^0-9.\\-]/g, '')));

  const filterCombinations = (typeof __filterCombinations !== 'undefined' && Array.isArray(__filterCombinations) && __filterCombinations.length > 0)
    ? __filterCombinations : [];
  // NAV_STEPS already ran above. waitForDashboard (target labels) is AFTER nav.
  if (filterCombinations.length === 0) {
    await waitForDashboard();
    const out = {};
    for (const k of KPI_LABELS) {
      const raw = await extractKPI(k);
      out[k] = toNum(raw && raw.value);
    }
    return out;
  }
  const results = {};
  for (let i = 0; i < filterCombinations.length; i++) {
    const { label = String(i), filters = {} } = filterCombinations[i];
    if (i > 0) {
      await page.goto(reportUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await waitForLoadingToFinish();
      for (const step of NAV_STEPS) {
        await clickByText(step, { openers: NAV_OPENERS });
      }
      await waitForDashboard();
    }
    const debug = {};
    // apply filters using cascade pattern above (writes into debug)
    const row = { filters_applied: debug };
    for (const k of KPI_LABELS) {
      const raw = await extractKPI(k);
      row[k] = toNum(raw && raw.value);
    }
    results[label] = row;
  }
  return results;



═══════════════════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════════════════
Reply ONLY with valid JSON (no markdown, no backticks):
{
  "playwright_code": "<complete JS script as a single string>"
}`;
    // Extract ONLY UI-related context from the scenario title/description.
    // The script generator must not be influenced by data-validation logic,
    // SQL expectations, expected numeric values, tolerance rules, or
    // warehouse-comparison wording — those belong to the SQL/analyze agents.
    // Only navigation, clicks, filter interactions, and KPI labels to scrape
    // from the UI should drive script generation.
    const uiContextNoteMain = `IMPORTANT — SCOPE OF TITLE/DESCRIPTION:
The Scenario title and description below may contain mixed information
(UI steps, SQL/warehouse expectations, tolerances, business rules, expected
numeric values, data-quality assertions, etc.). For the purpose of generating
this Playwright script you MUST consider ONLY the UI-related context:
  • which page/report to open
  • IN-REPORT NAVIGATION steps to execute after the report loads — tabs,
    screens, sub-tabs, bottom-nav items, radio/toggle pills (e.g. Weekly /
    Monthly / Quarterly). Parse these in order from phrases like "go to X
    screen", "open X tab", "select X", "switch to X", "click on X" and emit
    them as the NAV_STEPS array described in the IN-REPORT NAVIGATION
    section. Each step is clicked AFTER auth + initial dashboard load and
    BEFORE filters / KPI extraction, with the loading overlay waited out
    between steps.
  • which filters/dropdowns to interact with
  • which on-screen KPI labels or tiles to scrape

TWO-SCREEN REFERENCE_MATCH SCENARIOS:
When the description compares a KPI between TWO different screens/views of
the same report (e.g. "compare NBRx Total on Overview Screen vs Performance
Screen"), this TEST SCRIPT must scrape ONLY the FIRST screen mentioned (the
"main"/"test" side). A separate reference script will handle the second
screen. Do NOT navigate to BOTH screens in one script and do NOT emit both
sets of KPI keys. Use only the first-screen navigation cues in NAV_STEPS.

Ignore everything else (SQL queries, expected values, thresholds, comparison
logic, data lineage, "should equal X", warehouse column names, etc.).
Those are handled by other agents — do not let them shape selectors, waits,
or returned KPI keys.`;

    const uiContextNoteReference = `IMPORTANT — SCOPE OF TITLE/DESCRIPTION (REFERENCE SCRIPT):
You are generating the REFERENCE Playwright script for a reference_match
scenario. A separate main/test script already scrapes the FIRST screen. Your
job is to scrape ONLY the SECOND screen mentioned in the description (the
"reference" side of the comparison).

Consider ONLY the UI-related context and, within it, ONLY the second-screen
side:
  • Same report URL (already pre-navigated). If a reference URL is provided
    below, use that; otherwise use the primary report URL — either way the
    auto-injected preamble handles auth + navigation.
  • IN-REPORT NAVIGATION steps for the SECOND screen only. Parse phrases
    like "vs <X> screen", "compare with <Y> tab", "reference: <Z>",
    "against <X>", "and <Y> screen", the SECOND item in an "A vs B" pattern,
    or explicit "second/reference screen: ..." wording. Emit those (and
    only those) as NAV_STEPS.
  • The same KPI labels as the main script (so values line up for
    comparison) — use the KPI labels listed below verbatim.

Do NOT navigate to the first/test screen. Do NOT emit steps for both
screens. Do NOT re-scrape the main-side value here.

Ignore SQL / warehouse / expected value / tolerance wording entirely.`;

    const uiContextNote = isReferenceTarget ? uiContextNoteReference : uiContextNoteMain;

    const frontendSourceNote = mainShouldUseReferenceSource
      ? `\nFRONTEND SOURCE: The description states the frontend UI values come from the REFERENCE URL (not the primary report URL). Open and scrape the Report URL provided below — it is already the reference URL, and __creds are the reference credentials. Do not attempt to switch URLs.\n`
      : "";

    const user = `${uiContextNote}${frontendSourceNote}

Scenario: ${scenario.title}
Description: ${scenario.description}
Target: ${isReferenceTarget ? "REFERENCE script (second screen)" : "MAIN script (first screen)"}
Report URL to open: ${targetUrl}
KPI labels to scrape from the UI: ${JSON.stringify(scenario.reports.kpi_config)}
Credentials available: ${cred ? `yes (profile "${cred.name}", username "${cred.username}", loginUrl "${cred.login_url || "(none — use report URL)"}") — use __creds in the script` : "no — skip login block"}
Filter combinations (${(filterCombos || []).length}): ${JSON.stringify(filterCombos || [])}`;

    await log.log("script-gen", "llm_start", "Calling scripts LLM agent", {
      target,
      report_url: targetUrl,
    });
    const raw = await callAgent({ agentKey: "scripts", messages: [{ role: "system", content: sys }, { role: "user", content: user }], json: true });
    const parsed = tryParseJson(raw) || {};
    await log.log("script-gen", "llm_response", "LLM agent returned", {
      raw_bytes: String(raw || "").length,
      has_playwright_code: !!(parsed as any)?.playwright_code,
    });

    // Fallback recovery: when the JSON envelope is truncated or the model
    // wrapped the script in markdown / prose, pull the Playwright code out by
    // hand so a single bad response does not block Run Suite.
    function recoverPlaywrightCode(text: string): string | null {
      if (!text) return null;
      // 1) "playwright_code": "..."  (may be unterminated)
      const keyIdx = text.search(/"playwright_code"\s*:\s*"/);
      if (keyIdx >= 0) {
        const start = text.indexOf('"', text.indexOf(":", keyIdx)) + 1;
        let out = "";
        for (let i = start; i < text.length; i++) {
          const ch = text[i];
          if (ch === "\\" && i + 1 < text.length) {
            const n = text[i + 1];
            const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f" };
            out += map[n] ?? n;
            i++;
            continue;
          }
          if (ch === '"') break;
          out += ch;
        }
        if (/export\s+default\s+async\s*\(/.test(out)) return out;
      }
      // 2) ```js ... ``` or raw `export default async ({ page }) => { ... }`
      const fence = text.match(/```(?:js|javascript|ts|typescript)?\s*([\s\S]*?)```/);
      if (fence && /export\s+default\s+async\s*\(/.test(fence[1])) return fence[1].trim();
      const exp = text.indexOf("export default async");
      if (exp >= 0) return text.slice(exp).trim();
      return null;
    }

    if (!parsed.playwright_code) {
      const recovered = recoverPlaywrightCode(String(raw));
      if (recovered) {
        parsed.playwright_code = recovered;
      } else {
        console.error("agent-scripts: no playwright_code in LLM response. raw (first 4000 chars):", String(raw).slice(0, 4000));
        return new Response(
          JSON.stringify({
            error: "LLM_NO_CODE",
            message: "Agent did not return playwright_code. The response was likely truncated or not valid JSON. Check edge function logs for the raw response.",
            raw_preview: String(raw).slice(0, 2000),
          }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    let playwright_code = parsed.playwright_code;



    // Force-inject the auth/login block at the top of the script body so the
    // model can never skip it. We rewrite the first `export default async ({ page }) => {`
    // to include a guaranteed login preamble (no-op when __creds is null at runtime).
    if (cred) {
      const reportUrl = targetUrl;
      const loginPreamble = `
  // === AUTO-INJECTED SESSION-AWARE AUTH CHECK (do not remove) ===
  const __sleep = ms => new Promise(r => setTimeout(r, ms));
  const __reportUrl = ${JSON.stringify(reportUrl)};
  const __tryWidenViewport = async () => {
    try { if (typeof page.setViewport === 'function') await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 }); } catch (_) {}
    try { if (typeof page.setViewportSize === 'function') await page.setViewportSize({ width: 1920, height: 1080 }); } catch (_) {}
    try {
      await page.evaluate(() => {
        document.documentElement.style.zoom = '100%';
        if (document.body) document.body.style.zoom = '100%';
      });
    } catch (_) {}
  };
  await __tryWidenViewport();
  const __detectLoginForm = () => page.evaluate(() => {
    const norm = s => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const hasUserField = !!document.querySelector(
      'input[placeholder*="user name" i], input[name*="user" i], input[id*="user" i], #Uid'
    );
    const hasPwdField = !!document.querySelector('input[type="password"], #Pwd');
    const hasLoginBtn = Array.from(document.querySelectorAll('button, input[type="submit"], div[role="button"], a'))
      .some(el => /log ?in/.test(norm(el.innerText || el.value || '')));
    return hasUserField || hasPwdField || hasLoginBtn;
  }).catch(() => false);
  await page.goto(__reportUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await __sleep(2000);
  let __hasLoginForm = await __detectLoginForm();
  if (__hasLoginForm && typeof __creds !== 'undefined' && __creds && __creds.username) {
    const __onLoginPage = await page.evaluate(() => /\\/auth\\/ui\\/loginPage/i.test(location.href)).catch(() => false);
    if (!__onLoginPage && __creds.loginUrl) {
      await page.goto(__creds.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await __sleep(1000);
    }
    const __userSel = '#Uid, input[placeholder*="user name" i], input[name*="user" i], input[id*="user" i], input[type="text"]';
    const __pwdSel  = '#Pwd, input[type="password"], input[placeholder*="password" i]';
    await page.type(__userSel, __creds.username).catch(() => {});
    await page.type(__pwdSel, __creds.password).catch(() => {});
    await page.evaluate((pSel) => {
      const norm = s => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const cands = Array.from(document.querySelectorAll('button, input[type="submit"], div[role="button"], a'));
      let btn = cands.find(el => norm(el.innerText || el.value || '') === 'log in with credentials');
      if (!btn) btn = cands.find(el => /log ?in/.test(norm(el.innerText || el.value || '')));
      if (btn) { btn.click(); return true; }
      const pwd = document.querySelector(pSel);
      const form = pwd && pwd.closest('form');
      if (form) { (form.requestSubmit ? form.requestSubmit() : form.submit()); return true; }
      return false;
    }, __pwdSel).catch(() => {});
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null),
      __sleep(3000),
    ]);
    await __sleep(1500);
    const __loginFailed = await page.evaluate(() =>
      /login\\s*failure|error\\s*in\\s*login|invalid (user|credentials|password)|incorrect (user|password)/i.test(document.body.innerText || '')
    ).catch(() => false);
    if (__loginFailed) {
      return { ok: false, error: 'LOGIN_FAILED', message: 'Credentials rejected by the report login page' };
    }
    await page.goto(__reportUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await __sleep(2000);
    __hasLoginForm = await __detectLoginForm();
    if (__hasLoginForm) {
      return { ok: false, error: 'LOGIN_FAILED', message: 'Still on login page after submitting credentials' };
    }
    await __tryWidenViewport();
  } else if (__hasLoginForm) {
    return { ok: false, error: 'AUTH_REQUIRED', message: 'Login form present but no credentials provided' };
  }
  // === END AUTO-INJECTED AUTH CHECK ===
`;

      // Inject after the first arrow-function opening brace.
      const m = playwright_code.match(/(export\s+default\s+async\s*\(\s*\{\s*page[^}]*\}\s*\)\s*=>\s*\{)/);
      if (m) {
        playwright_code = playwright_code.replace(m[1], `${m[1]}\n${loginPreamble}`);
      } else {
        // No matching signature — wrap the whole script.
        playwright_code = `export default async ({ page }) => {\n${loginPreamble}\n${playwright_code}\n};`;
      }
    }

    const validated = await runGenerateValidationLoop({
      req,
      scenarioId: scenario_id,
      scenario,
      target,
      reportUrl: normalizeReportUrl(targetUrl),
      initialCode: playwright_code,
      generatedBy: "skill:llm",
      meta: { skill: SCRIPT_GEN_SKILL_ID, skill_version: SCRIPT_GEN_SKILL_VERSION },
      filterCombos: (filterCombos || []).map((c: any) => ({
        label: c.label,
        filters: c.filters || {},
      })),
      log,
      forceSkip: forceSkipValidate,
      forceMaxAttempts,
    });

    const inserted = await persistGeneratedScript(sb, {
      scenario_id,
      playwright_code: validated.playwright_code,
      isReferenceTarget,
      mainShouldUseReferenceSource,
      credId,
      generatedBy: validated.generatedBy,
    });

    await log.finish(validated.validation.passed || !validated.validation.enabled ? "ok" : "failed", {
      path: "llm",
      generated_by: validated.generatedBy,
      validation: {
        enabled: validated.validation.enabled,
        passed: validated.validation.passed,
        attempts: validated.validation.attempts,
        skipped_reason: validated.validation.skipped_reason || null,
      },
      log_file: log.getLogFile(),
      json_log_file: log.getJsonLogFile(),
    });

    return new Response(JSON.stringify({
      script: inserted,
      target,
      generated_by: validated.generatedBy,
      skill: SCRIPT_GEN_SKILL_ID,
      skill_version: SCRIPT_GEN_SKILL_VERSION,
      validation: validated.validation,
      log_file: log.getLogFile(),
      json_log_file: log.getJsonLogFile(),
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    try {
      await agentLog?.log(
        "script-gen",
        "error",
        String((e as Error)?.message || e),
        { error: String(e) },
        "error",
      );
      await agentLog?.finish("failed", {
        error: String(e),
        log_file: agentLog?.getLogFile() ?? null,
        json_log_file: agentLog?.getJsonLogFile() ?? null,
      });
    } catch (_) {
      /* ignore logging failures */
    }
    return new Response(JSON.stringify({
      error: String(e),
      log_file: agentLog?.getLogFile() || null,
      json_log_file: agentLog?.getJsonLogFile() || null,
    }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});

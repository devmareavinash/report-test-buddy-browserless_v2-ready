# RTB Script Agents — Working Document

**Status:** current as of 2026-09-08  
**Skill:** `mstr-rtb-script-gen` v1.0.0  
**Audience:** anyone generating, repairing, or debugging MicroStrategy Playwright scripts in Report Test Buddy

This is the single working reference. It consolidates the Cursor skill, the runtime skill copy, template detectors, generate/validate loop, Browserless contract, and how Latest result reads KPI / chart / grid output.

---

## 1. Purpose

Report Test Buddy (RTB) generates Playwright scripts that:

1. Open a MicroStrategy report URL
2. Log in if needed
3. Navigate to the right tab
4. Apply scenario filter combinations
5. Extract **KPI tiles**, **chart Show Data**, or **on-page / Show Data grids**
6. Compare main vs reference (or vs warehouse SQL) in **Latest result**

**Policy:** assemble a proven template. Only URL, filters, and labels change. Call Claude only when the case is novel or template validation fails.

---

## 2. Source files (keep these aligned)

| Role | Path |
|------|------|
| Human skill (this policy) | `.cursor/skills/mstr-rtb-script-gen/SKILL.md` |
| Runtime skill + LLM block | `supabase/functions/_shared/script-gen-skill.ts` |
| Generate / persist / detect | `supabase/functions/agent-scripts/index.ts` |
| KPI / Activity template | `supabase/functions/_shared/mstr-overview-template.ts` |
| Chart Show Data template | `supabase/functions/_shared/mstr-chart-template.ts` |
| Trend check (consecutive periods) | `supabase/functions/_shared/mstr-trend-check-template.ts` |
| Geography / Trend Grid template | `supabase/functions/_shared/mstr-grid-template.ts` |
| Generate-time validate + repair | `supabase/functions/_shared/script-gen-validate-loop.ts` |
| Nav / filter / extract checks | `supabase/functions/_shared/script-validation.ts` |
| Browserless execute | `supabase/functions/playwright-runtime/index.ts` |
| Orchestrate runs | `supabase/functions/agent-orchestrate/index.ts` |
| Latest result mapping / tables | `src/pages/ScenarioDetail.tsx` |
| Local function routing | `src/lib/functions.ts` |
| Chart Show Data reference | `supabase/functions/_shared/references/browserless-chart-showdata.js` |
| Overview KPI reference | `supabase/functions/_shared/references/browserless-overview-kpi.js` |

Standalone Desktop CLI (not what RTB Generate uses): `C:\Users\EASXP\OneDrive - Bayer\Desktop\mstr-playwright-agent`.

---

## 3. Local vs cloud generate

Generate / Regenerate **must** hit the **local Deno backend** (`http://127.0.0.1:8000`), not Supabase Cloud.

Default local functions in `src/lib/functions.ts`:

- `agent-scripts`
- `playwright-runtime`
- `agent-orchestrate`
- `agent-heal`
- `run-warehouse-sql`
- `test-warehouse-connectivity`

Vite proxies `/functions/v1/*` to `:8000`. If Generate goes to Cloud, you get LLM scripts instead of skill templates.

Local stack:

| Process | Port |
|---------|------|
| Vite UI | 8080 |
| Deno backend | 8000 |
| Snowflake SSO sidecar | 8002 |
| Browserless Chromium OSS `v2.55.4` | 3000 |

If `:8000` is down, the UI shows `Edge function returned 500`.

---

## 4. Generation policy (mandatory)

User description picks **KPI | chart | grid**. That selects the template.  
**Fixed:** URL open, login, page-nav mechanics, filter application, waits, extract helper bodies.  
**Filled from description / UI only:** page/tab names (`NAV_STEPS`), KPI labels, chart/grid title, time grain, filter names. Filter **values** = `__filterCombinations` (never hardcode).

1. Read this document / the skill first.
2. Detect kind from description → assemble matching skeleton.
3. Do not invent screens (Performance vs Activity vs Trend).
4. **LLM only** when no detector matches or assembled-template validation fails.

`generated_by` on save:

- Template hit: `skill:<kind>` (`skill:kpi`, `skill:chart_show_data`, `skill:geography_grid`, `skill:date_refresh`)
- Repair after a failed validate run: `skill:repair:<attempt>`
- Novel Claude path: LLM / untagged

---

## 5. Canonical run flow (all working scripts)

```
1. Open URL (domcontentloaded)
2. Authenticate (__creds) if login form
3. Wait until page load          → waitForLoadingToFinish
4. Navigate required tab         → clickByText / NAV_STEPS
5. Wait data / filter bar ready  → waitForDashboard / waitForFilterBar
6. Apply filters (KPI Overview selectByLabel gold standard)
7. Wait data load after each filter
8. Extract: KPI tiles | Graph Show Data | Grid (Show Data or on-page)
```

Pipeline constants (`script-gen-skill.ts`):

`open_url → authenticate → wait_page_load → navigate_tab_if_needed → wait_data_or_filter_bar → apply_filters_kpi_style → wait_data_after_filters → extract_kpi_or_graph_or_grid`

---

## 6. Filter gold standard

**Only the KPI Overview filter path is proven reliable.**

- Order: `GEO_ORDER = ['Area', 'Region', 'Territory']` then other keys
- Geography Details may also apply **Time Bucket** after geo (`GRID_GEO_ORDER`)
- Weekly / Monthly / Quarterly are **chart radios**, not geography filters and not footer tabs
- Helper: `selectByLabel` from the **RTB filter core**
  (`supabase/functions/_shared/mstr-filter-core.ts`, embedded in every template
  between `// @@RTB_FILTER_CORE_START@@` and `// @@RTB_FILTER_CORE_END@@`).
  Legacy `.mstrmojo-DocSelector` is still supported, but a label binds only to a
  selector **between that label and the next filter label on the same row**, and
  every pick is read back before it counts. Fix the core file — never a copy
  inside a template, a reference script, or a healed script.
- After each successful pick: `waitForLoadingToFinish` only (spinner)
- One `waitForDashboard` after nav and again before scrape — **not** after every filter
- Do **not** invent a different Region path for charts/grids until verified
- Filters always come from `__filterCombinations` at runtime

---

## 7. Template kinds and detectors

`agent-scripts` tries templates in this order:

**`trend_check → grid → chart → date_refresh → kpi → LLM`**

### 7.1 `geography_grid` (`skill:geography_grid`)

**When** (`isGridScenario`):

- “Geography Details” + “grid”
- “Performance Trend(s) Grid” / “Performance Trend” + “grid”
- “grid data”, “crosstab”, “xtab grid”, “on-page grid”, “all grid columns”
- “grid” + employee/area/columns, and not Overview
- Existing script already has `extractOnPageGrid` / `row.grid =` plus Geography / Employee / Trend

**Extract:** Menu → **Show Data / Export Data** first; on-page horizontal scroll only as fallback.

**Nav:**

| Scenario text | `NAV_STEPS` | Default title |
|---------------|-------------|---------------|
| Performance Trend Grid | `Performance` → `Performance Trend` | Performance Trend |
| Geography Details | `Performance` (add Geography if named) | Geography Details |

Time = **Time Bucket** filter, not Weekly/Monthly radios.

**Reject:** scrapes that look like Overview Performance KPI tiles or chart “Line copy” legends.

### 7.2 `chart_show_data` (`skill:chart_show_data`)

**When** (`isChartScenario`) — after grid is ruled out:

- Show Data / chart data / graph data / line or bar chart / Performance Trend / Overall Performance
- “chart|graph|plot” without Overview/KPI
- Performance + weekly/monthly/quarterly/trend (not Activity)
- Existing script has `openShowData` / `extractShowDataTable` / `clickChartTimeGrain`

**Extract:** **only** Show Data popup → **multi-column** table (`openShowData` + `extractShowDataTable`).

**Do not:** `extractKPI`, canvas/SVG, single-metric “tables”.

A result with **one header** (e.g. `NBRx New Writers`) and **one value** is a **failed KPI scrape**, not chart data. Real Overall Performance / Segment Summary Show Data has **≥2 columns** and multiple period/metric rows.

**Nav / grain:**

- Footer tab **Performance** in `NAV_STEPS`
- Weekly / Monthly / Quarterly = grain radios (`clickChartTimeGrain` / proven `clickByText('Monthly')`)
- Titles e.g. `Segment Summary`, `Overall Performance` (default title if unspecified: Overall Performance)
- For reference_match, “for Quarterly toggle” vs “Monthly Toggle” can differ main vs reference

### 7.3 `kpi` (`skill:kpi`)

**When** (`isKpiScenario`) — after grid / chart / date are ruled out:

- Overview, Activity, or any numeric KPI tiles (not a graph / grid / refresh date)
- User-configured labels (`assertion_spec.kpis`, `kpi_tolerances`, report `kpi_config`) or labels mentioned in title/description
- **Not** Show Data / Geography / grid / chart / date

**Extract:** `extractKPI` — largest font under the **exact** user-configured label. Do not inject the 18 default Overview KPIs.

`NAV_STEPS` from the scenario (Overview often `[]`, Activity `["Activity"]` or Performance → Activity).

### 7.4 `llm`

Novel only. Same Browserless rules and pipeline. Do not invent new extract shapes or filter cadence.

---

## 8. Extraction decision (hard rule)

```
KPI tiles / pass values     → kpi                          → extractKPI
Graph / chart / toggle data → chart_show_data              → openShowData + multi-col table
Trend type / consecutive periods → trend_check             → Show Data + no missing W/M/Q
Geography Details / Trend Grid → geography_grid            → Show Data, then on-page grid
Refresh / as-of dates       → date_refresh                 → extractRefreshDate
```

Do **not** mix extractors across kinds.

---

## 9. What not to change when filling a template

- Auth preamble shape (`__creds`, no hardcoded passwords)
- Viewport / zoom
- Wait helpers (`sleep`, `waitForLoadingToFinish`, `waitForDashboard`)
- Geo filter cadence (unless kind is geography and Time Bucket is required)
- Bodies of `extractKPI` / `openShowData` / `extractShowDataTable` / `extractOnPageGrid` — copy from working references
- Mixing extractors (no KPI scrape inside `chart_show_data`)

---

## 10. Browserless / Playwright runtime contract

Target: Browserless OSS `/function` (Playwright-compatible `page`).

| Rule | Detail |
|------|--------|
| Signature | `export default async ({ page }) => { ... }` — no imports |
| Injected | `__creds`, `__filterCombinations`, report URL from runtime |
| URL | `context.reportUrl` / `REPORT_URL` / `__reportUrl` |
| Filters | runtime combos only — never hardcode values |
| Goto | `waitUntil: 'domcontentloaded'` — never `networkidle` |
| Sleep | `const sleep = ms => new Promise(r => setTimeout(r, ms))` — never `page.waitForTimeout` |
| DOM | `page.evaluate`, `page.click`, `page.type`, `page.waitForSelector`, `page.waitForFunction` |
| Forbidden | `page.getByText`, `getByRole`, locator chaining (`.locator().first()`), `import from 'playwright'` |

**Viewport (current runtime):** 1920×1080. Runtime applies zoom after goto and before screenshot (`applyZoom100` in `playwright-runtime`).

**Combos:** playwright-runtime injects all requested filter combinations. Generate-time validation uses **only the first combo** to keep latency bounded.

**Concurrency (orchestrate):** UI 1/2/3/5/8 “parallel screens”; server cap 10. Main + reference scrapes can run in parallel. Filter combos **inside one scenario** stay sequential (one browser). Browserless `CONCURRENT=10`. On Fargate 2 vCPU prefer 2–3; locally 3 is typical.

---

## 11. Generate / Regenerate validation loop

Dedicated working doc: `docs/VALIDATION_AGENT.md`. Cursor skill: `.cursor/skills/mstr-rtb-validate/SKILL.md`. This section stays a short summary; change those files when the loop changes.

Runs on **Generate / Regenerate only** (not manual Run headless).

1. Assemble template or LLM-generate
2. Execute once via `playwright-runtime` (first filter combo)
3. Check **navigation**, **filters**, and **extraction** (`script-validation.ts`)
4. On failure, send validation report + prior script to the scripts repair agent
5. Retry up to **5** attempts (`SCRIPT_VALIDATE_MAX_ATTEMPTS`, default 5)
6. Stop early when validation passes (does not always use all 5)

Disable with `SCRIPT_VALIDATE_ON_GENERATE=false`.  
Skipped if `BROWSERLESS_TOKEN` is unset (template is still persisted).

### Validation expectations by kind

| Kind | `extract` | Pass when |
|------|-----------|-----------|
| overview / activity | `kpi` | At least one configured / detected KPI has a numeric (or numeric-looking) value |
| chart_show_data | `chart_table` | `tableData` / chart title object has **≥2 headers** and **≥1 row** |
| geography_grid | `grid` | `grid` / `tableData` / titled object has **≥2 columns** and **≥1 row**, and does **not** look like KPI chrome / Line-copy legend |

Nav: each `NAV_STEPS` item must appear in `navigation` as clicked. Time grain must be applied if expected.

Filters: each key in the first combo must have `filters_applied[key].ok` or `.clicked`.

Runtime fail: `ok === false`, `BROWSERLESS_TIMEOUT`, or missing payload → repair hints for hangs / login / NAV_STEPS.

---

## 12. Credentials and URL targeting

- Main script: report `url` + main credential profile
- Reference script: `reference_url` (fallback primary URL) + reference credential profile
- **Exception:** `warehouse_match` whose title/description says the **frontend** is the reference URL (“reference URL frontend vs backend”) → **main** script scrapes the reference URL with reference creds

Persisted fields:

- Main: `scripts.playwright_code`, `assertion_spec.__generated_by`, `__generated_at`
- Reference: `assertion_spec.__reference_playwright_code`, `__reference_generated_by`, `__reference_generated_at`

---

## 13. Latest result — how output is stored and shown

Execution **does** store chart/grid payloads (history `actual.values.grid` / `data` / `tableData`). Latest result used to look up the **configured KPI name** only (e.g. `Segment Summary`). Script keys are `grid`, `data`, `tableData` — so Actual showed **—** and PENDING.

**Current mapping (`ScenarioDetail.tsx`):**

1. Extract KPI map from the combo block; skip locator junk (`via`, `role`, `nth`, `aria-*`, `metric`/`time_bucket` as filter bookkeeping).
2. Keep structured objects/arrays (grid, graph, data, table, series, rows).
3. If the configured name is missing, alias names like **Segment Summary / grid / graph / table** onto `grid` / `data` / chart table.
4. Persist both the raw keys **and** the configured name (`aliasConfiguredKpis`).
5. Compare structures with number canonicalization (`14,655.3` ≡ `14655.3`).
6. **Render** grid/graph as a real HTML table (headers + rows), not a JSON blob.

Locator strings (`via`, `aria-row-grid`) are **not** KPIs. A configured KPI that is still missing stays **pending** with `—` (no fake pass).

---

## 14. Working script shapes (what a good extract looks like)

### KPI tile

```json
{ "Overall Performance": 58.2, "filters_applied": { "Area": { "ok": true } } }
```

Exact label keys. Value = largest font under that label.

### Chart / Segment Summary / Overall Performance

```json
{
  "tableData": {
    "headers": ["Segment", "Previous Time Period", "Current Time Period"],
    "rows": [
      ["A_HP_W", "14,655.3", "11,819.5"]
    ]
  },
  "via": "show-data"
}
```

Or `data: [{ "Segment": "...", "Previous Time Period": "...", "Current Time Period": "..." }]`.  
**≥2 columns**, multiple rows. Not one KPI header + one number.

### Geography / Performance Trend Grid

```json
{
  "grid": {
    "columns": ["Area", "Employee Name", "NBRx Total", "..."],
    "rows": [ { "Area": "AA - East", "NBRx Total": "14855.3" } ]
  }
}
```

Default Geography columns live in `DEFAULT_GEOGRAPHY_COLUMNS` in `mstr-grid-template.ts`.

---

## 15. LLM fallback rules (if no template)

JavaScript only. Signature `export default async ({ page }) => { ... }`.

Must follow the same pipeline as working scripts. Only substitute from the UI:

- report URL
- `KPI_LABELS` / `CHART_TITLE` / grid title + columns
- filters from `__filterCombinations`

Do not change wait helpers, geo cadence, or extract helper bodies. Do not mix KPI scrape into chart templates.

Repair agent uses the same skill block plus the validation report (`formatValidationForAgent`).

---

## 16. Common failures and the correct fix

| Symptom | Cause | Fix |
|---------|--------|-----|
| Generate writes a custom LLM script | `agent-scripts` hit Cloud, or no detector match | Local Deno + check title/description keywords |
| Chart shows one KPI number | Used `extractKPI` on a graph | `chart_show_data` + Show Data multi-col |
| Geography scrape is Overview KPIs | Wrong tab / KPI extractor | `NAV_STEPS` Performance (+ Geography); grid Show Data |
| Trend Grid opens Geography Details | Empty / default `NAV_STEPS` | `Performance` → `Performance Trend` |
| Latest result `—` / PENDING on Segment Summary | Looked up name, payload is `grid`/`data` | Alias + table render (already in UI) |
| Page reloads every ~5 min locally | Vite HMR websocket dropped by VDI proxy | `vite.config.ts` `hmr: false` |
| `Edge function returned 500` | Deno `:8000` down (often disk full) | Restart `scripts/dev-backend.ps1` |
| Validation skipped | `SCRIPT_VALIDATE_ON_GENERATE=false` or no `BROWSERLESS_TOKEN` | Set token; leave validate on |

---

## 17. Env knobs

| Variable | Meaning |
|----------|---------|
| `SCRIPT_VALIDATE_ON_GENERATE` | `false` skips the post-generate Browserless run |
| `SCRIPT_VALIDATE_MAX_ATTEMPTS` | 1–10, default 5 |
| `BROWSERLESS_HOST` | Local OSS: `http://127.0.0.1:3000` |
| `BROWSERLESS_OSS` | `true` for OSS `/chromium/function` |
| `BROWSERLESS_TOKEN` | Required for validate + runs |
| `LOCAL_FUNCTIONS_URL` | Backend self-call, default `http://127.0.0.1:8000/functions/v1` |
| `VITE_LOCAL_FUNCTIONS` | Comma list of functions the UI sends to Vite → Deno |
| `ORCHESTRATE_CONCURRENCY` | Server cap (UI also stores `rtb.orchestrateConcurrency`) |

---

## 18. Quick checklist before changing a template

- [ ] Detector still matches the intended scenarios only
- [ ] URL / labels / `NAV_STEPS` / time grain are the only substitutions
- [ ] Filter order is still Area → Region → Territory (+ Time Bucket for geo)
- [ ] Extract helper body matches the working reference
- [ ] Chart still rejects 1-column / 1-value “tables”
- [ ] Grid still rejects Overview KPI chrome
- [ ] `validateAssembledScript` still passes
- [ ] Generate-time validation still checks nav + filters + extract
- [ ] Latest result still aliases `grid`/`data` onto the configured KPI name
- [ ] Generate still hits local `agent-scripts`

# RTB Validation Agent

**Audience:** anyone turning on, debugging, or changing generate-time script checks  
**Cursor skill:** `.cursor/skills/mstr-rtb-validate/SKILL.md`  
**Related:** script generation is documented in `docs/SCRIPT_AGENTS_WORKING.md` and `.cursor/skills/mstr-rtb-script-gen/SKILL.md`

This is the post-**Generate / Regenerate** Browserless check + repair loop. It is not a scrape-how-to and it is not Latest result compare.

---

## What it is

After `agent-scripts` assembles a template (or falls back to the LLM), the validation agent:

1. Runs that script **once** on Browserless through `playwright-runtime`
2. Inspects the JSON payload for **navigation**, **filters**, and **extraction**
3. If a check fails, sends the report + prior script to the **scripts repair LLM**
4. Retries until a pass or the attempt cap is reached
5. **Always persists** the last script (`agent-scripts` saves after the loop, pass or fail)

It answers: “Did this generated script actually click the tabs, apply the first filter combo, and extract the right *shape* of data?”

## What it is not

| Not this | That job belongs to |
|----------|---------------------|
| Manual **Run headless** / workstream orchestrate | `playwright-runtime` + `agent-orchestrate` — all requested combos, no repair loop |
| Latest result pass/fail (main vs reference / warehouse numbers) | `ScenarioDetail.tsx` compare + aliasing |
| How to scrape KPI / chart / grid | Script-gen skill + `mstr-*-template.ts` |
| Static assemble lint | `validateAssembledScript` inside template assembly (before this loop) |

The validation execute uses `mode: "headless"` internally. That does **not** mean it is the same as the UI **Run headless** button.

---

## When it runs

**Only** on Scenario **Generate** / **Regenerate** (main or reference). Those buttons call `agent-scripts`.

It does **not** run when you click Run headless, run a workstream, or re-open Latest result.

`agent-scripts` calls `runGenerateValidationLoop` twice in the file: after a template hit, and after the LLM fallback. Then it persists and returns `validation` on the JSON response.

---

## Flow

```
Generate / Regenerate
        │
        ▼
assemble template  (grid → chart → date_refresh → kpi)
   or LLM if no detector match
        │
        ▼
SCRIPT_VALIDATE_ON_GENERATE === "false"?  ──yes──► persist assembled code, skip
BROWSERLESS_TOKEN unset?                  ──yes──► persist assembled code, skip
        │ no
        ▼
build expectations from generated_by + template meta
(+ parseNavStepsFromScenario only if nav_steps omitted; explicit [] = Overview stay on page)
        │
        ▼
loop attempt 1 … max
   1. playwright-runtime, first filter combo only
   2. analyzeScriptRun (runtime / nav / filters / extract)
   3. PASS → persist that code, stop
   4. FAIL Browserless 500 / Chromium launch crash → retry same code once (no LLM). Still crash → persist assembled, stop
   5. FAIL (script/nav/extract) and attempts remain → repair LLM → next attempt
   6. FAIL and no attempts left → persist last code anyway
```

**One combo:** `executeScriptValidation` sends only `filterCombinations[0]` so Generate stays bounded. Full combo lists are for Run headless / orchestrate.

**Repair:** `callAgent({ agentKey: "scripts" })` with `SCRIPT_GEN_SKILL_LLM_BLOCK` plus `formatValidationForAgent` (hints + previous script). Expects JSON `{ "playwright_code": "..." }`. Empty / no `export default` keeps the previous code.

**Magentic fetch:** `_shared/llm.ts` uses a **240s** timeout (override `ANTHROPIC_FETCH_TIMEOUT_MS`, min 30s) and retries **twice** on timeout / fetch failed with backoff. Deno honors `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` from `scripts/dev-backend.ps1` (corp Skyhigh + `DENO_TLS_CA_STORE=system` + `--unsafely-ignore-certificate-errors`). `load-env.ps1` puts Magentic (`chat.int.bayer.com`) in `NO_PROXY` so the repair POST matches Python hello (direct to the internal gateway). Assembled skill templates still call repair on extract/nav/filter fail — they are not skipped. The repair prompt sends a head+tail script excerpt (~16k chars), not the full ~60k file.

**Tags after a successful repair:** `generated_by` becomes `skill:repair:<failedAttempt>` (for example attempt 1 fails, repair writes `skill:repair:1`).

**Cap:** default **5** attempts (`SCRIPT_VALIDATE_MAX_ATTEMPTS` constant). Env override is clamped **1–10**. The loop stops early on pass, and also stops if the repair LLM throws (network `fetch failed`, missing `ANTHROPIC_API_KEY`, gateway timeout) so Generate does not re-run the same unfixed script on Browserless.

**Launch crash is not a script bug.** If `analyzeScriptRun` reports `browserless 500` / `Chromium failed to launch` / WS-endpoint timeout, the loop retries Browserless **once** with the same assembled code and **does not** call Magentic/Claude. A second launch crash persists the template and ends. Repair cannot fix a crashed or stuck container.

---

## Pass vs fail (by template kind)

`buildExpectations` maps `generated_by` / `skill:<kind>`:

| Kind | `extract` | Pass |
|------|-----------|------|
| `kpi` / other | `kpi` | At least one configured KPI label (or, if none, a non-bookkeeping key) is a finite number or a numeric-looking string (`12`, `14,655.3`, `58.2%`) |
| `chart_show_data` (kind contains `chart`) | `chart_table` | `tableData`, or the chart title object, or `Overall Performance`, has **≥2 headers/columns** and **≥1 row**, and no `error` |
| `geography_grid` (kind contains `grid`) | `grid` | `grid` / `tableData` / titled object has **≥2 columns** and **≥1 row**, no `error`, and does **not** look like Performance KPI chrome / “Line copy” legend |

Shared checks (all kinds):

| Check | Pass when |
|-------|-----------|
| **runtime** | Payload is present, `ok !== false`, and `error` is not `BROWSERLESS_TIMEOUT` / other runtime error. Runtime fail skips nav/filter/extract and goes straight to repair hints (hangs, login, `NAV_STEPS`). |
| **navigation** | Each expected `NAV_STEPS` item appears in `navigation` as clicked (`clicked === true`, or no `error` plus `via`/`clicked`). If a time grain is expected, it must be clicked in `navigation` **or** `time_grain.clicked` / `time_grain.grain` is set. Explicit `meta.nav_steps: []` (KPI landing page / Overview) → pass (“No nav steps required”). Parse from the scenario description only when `nav_steps` is omitted. Chart/grid scripts return `{ navigation, results: { combo } }` — `pickResultRoot` keeps that parent so `navigation` is not dropped when reading the first combo. |
| **filters** | Each key from the **first** combo has `filters_applied[key].ok` or `.clicked`. Empty keys → pass. |

Overall pass = every check in the report passes.

This is a **shape / telemetry** check. It does not compare numbers to a reference dossier or warehouse.

---

## Env flags

Read by Deno at process start (`scripts/dev-backend.ps1` → `load-env.ps1`). Changing them does nothing until you **restart Deno**.

| Variable | Code behavior |
|----------|----------------|
| `SCRIPT_VALIDATE_ON_GENERATE` | Loop is **on** unless this equals the string `false`. Unset = on. |
| `SCRIPT_VALIDATE_MAX_ATTEMPTS` | Integer, clamped 1–10. If unset/invalid, constant **5**. |
| `BROWSERLESS_TOKEN` | If unset, loop is skipped (`skipped_reason` says so). Assembled script is still saved. |
| `LOCAL_FUNCTIONS_URL` | Where the loop POSTs `/playwright-runtime`. Default `http://127.0.0.1:8000/functions/v1`. |

`.env.example` currently ships:

```
SCRIPT_VALIDATE_ON_GENERATE=true
SCRIPT_VALIDATE_MAX_ATTEMPTS=5
```

So a copy of the example file has validation **on**. To skip the Browserless round-trip on local Generate, set `SCRIPT_VALIDATE_ON_GENERATE=false` and restart Deno.

Also required for the run itself: Browserless up (`BROWSERLESS_HOST`, typically `http://127.0.0.1:3000`) and Generate hitting **local** `agent-scripts` (not Cloud).

---

## How to turn it on

1. In the repo `.env` (same file Deno loads):
   - `SCRIPT_VALIDATE_ON_GENERATE=true` (or delete the line — unset is on)
   - `SCRIPT_VALIDATE_MAX_ATTEMPTS=5` (optional; raise up to 10)
   - `BROWSERLESS_TOKEN` set (example uses `local-dev-token`)
2. Browserless OSS running on `:3000`.
3. **Restart Deno** (`scripts/dev-backend.ps1`). Vite HMR does not reload backend env.
4. On a scenario, click **Generate** / **Regenerate**. The `agent-scripts` response includes `validation: { enabled, passed, attempts, max_attempts, reports, skipped_reason? }`. Session logs go to `logs/script-agents/` when `SCRIPT_AGENT_LOG=true`.

To turn it **off**: `SCRIPT_VALIDATE_ON_GENERATE=false`, restart Deno. Generate then saves the assembled/LLM script immediately.

---

## vs Latest result / Run headless

| | Validation agent | Run headless / Latest result |
|--|------------------|------------------------------|
| Trigger | Generate / Regenerate (`agent-scripts`) | Run button / orchestrate |
| Combos | First combo only | All requested combos |
| Repair LLM | Yes, on fail | No |
| Pass means | Nav clicked, filters applied, extract shape OK | Values compared (main vs reference or warehouse) |
| Persist | Always writes last `playwright_code` | Stores run history / actuals |

Do not debug a Latest result `—` / PENDING by changing this loop. That mapping lives in `ScenarioDetail.tsx`.

---

## File map

| File | Role |
|------|------|
| `supabase/functions/_shared/script-gen-validate-loop.ts` | Enable/skip, attempt loop, `executeScriptValidation`, `repairScriptFromValidation` |
| `supabase/functions/_shared/script-validation.ts` | `buildExpectations`, `analyzeScriptRun`, `formatValidationForAgent` |
| `supabase/functions/agent-scripts/index.ts` | Calls the loop after assemble or LLM, then `persistGeneratedScript` |
| `supabase/functions/_shared/llm.ts` | `callAgent` / `tryParseJson` used by repair |
| `supabase/functions/_shared/script-gen-skill.ts` | `SCRIPT_GEN_SKILL_LLM_BLOCK` injected into the repair system prompt |
| `supabase/functions/playwright-runtime/index.ts` | Browserless execute (validation POSTs `mode: "headless"`, one combo) |
| `supabase/functions/_shared/mstr-nav-parse.ts` | Fills empty `navSteps` from the scenario description |
| `supabase/functions/_shared/script-agent-log.ts` | `script-validate` start / attempt / repair / skip lines |

Keep this doc aligned with those files. If the code and this doc disagree, the code wins — update the doc.

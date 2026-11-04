# Report Test Buddy: Project Diagnosis

**Date:** 2026-11-03
**Code examined:** the working tree at `0fed02d` plus 10 uncommitted files (`ScenarioDetail.tsx`, `RunScenarioCard.tsx`, `ScenarioResultCard.tsx`, `latestTestResults.*`, `playwrightAuthSession.*`, `auth-session-gateway.ts`, `auth-session-store.ts`, `mstr-filter-core.ts`)
**How:** read-only static review of the whole repository, plus the existing automated checks. No source file was changed.

**Verification labels used in §8:**
- **Verified** means the finding was re-read and confirmed in the code while this report was being prepared.
- **Confirmed** means a reviewer read and confirmed it in the code but it was not independently re-checked.
- **Plausible** means the code allows it, but it depends on runtime configuration that could not be checked from the repository (for example Supabase sign-up settings, or Browserless timeout precedence).

**Limitation:** the C: drive ran out of space during the review. ESLint, `npm audit` and `deno check` therefore did not finish (§7). Re-run them once space is available.

---

## 1. Project overview

Report Test Buddy (RTB, also called "Agentic Frontend Validations") checks that the numbers shown in MicroStrategy (MSTR) dashboards are correct.

**What users define:**
- **Workstreams**, which contain **brands**, which contain **reports** (also called "screens").
- **Scenarios** (test cases) under each report, each with KPI definitions, tolerances and **filter combinations**.
- For each scenario, a saved **Playwright script** that opens the dashboard, logs in, navigates, applies filters and extracts values.

**What a run does:**
1. Executes the saved script headlessly in **Browserless Chromium**.
2. Gets the *expected* values from either:
   - a **reference** scrape of a second UI (`reference_match`), or
   - **Snowflake SQL** run through a Python sidecar.
3. Compares KPI, date, text and table values using the configured tolerances.
4. Stores results in Supabase and shows them on the dashboard, run and scenario pages.

**AI features (an Anthropic-compatible gateway at `chat.int.bayer.com/anthropic`):**
- Script **generation**: template-first, with an LLM fallback and a live validate/repair loop.
- **Auto-heal** of failing scripts.
- **Root-cause analysis** of failures.
- An interactive **script chat agent** that proposes edits to the saved script.

**Scale:** about 45k lines in total.

| Area | Approx. lines |
|---|---|
| React frontend | 25k |
| Deno functions | 19k |
| SQL migrations | 0.8k |
| Python | 0.9k |
| PowerShell scripts | 1.7k |

---

## 2. Project structure

```
report-test-buddy-browserless_v2-ready/
├── src/                          React SPA
│   ├── pages/                    13 routed pages (ScenarioDetail.tsx = 5,491 lines)
│   ├── components/               app components + ui/ (generated shadcn) + ai-elements/ (chat UI)
│   ├── lib/                      domain helpers (KPI eval, result pairing, table compare, SQL filter,
│   │                             canonical script, delete/duplicate, Excel export, function routing)
│   ├── contexts/                 AuthContext (session + roles), ThemeContext
│   ├── hooks/useExecutionLocks   3-second polling of active runs → disables Run buttons
│   ├── integrations/supabase/    client + generated DB types (stale, see §8)
│   ├── shims/                    lightweight stand-ins for streamdown/shiki (VDI disk limits)
│   └── drizzle/                  unused; one "snapshot" file actually contains SQL
├── supabase/
│   ├── functions/<name>/index.ts 15 Deno functions (see §6.1)
│   ├── functions/_shared/        ~8.8k lines: auth, LLM client, MSTR script templates,
│   │                             filter core, validation loop, auth-session cookie store
│   ├── functions/_shared/references/*.js   proven Browserless reference scripts
│   └── migrations/               24 SQL migrations (schema, RLS, triggers, RPCs)
├── backend/
│   ├── server.ts                 Deno gateway that hosts all functions in one process
│   ├── Dockerfile, docker-entrypoint.sh
│   └── snowflake-sso/app.py      FastAPI Snowflake sidecar (+ Dockerfile, requirements.txt)
├── runtime/                      legacy Express + Playwright runner; NOT used anywhere
├── demo-recorder/                Python screen recorder for demo videos (local tool)
├── infra/                        ECS task definition; README describes an AWS design that does not exist
├── scripts/                      PowerShell dev launchers, env loader, scratch JS
├── docs/                         architecture, deployment, script-agent and validation-agent docs
├── Dockerfile, nginx*.conf       web image (nginx serves SPA, proxies /functions/v1)
├── docker-compose.yml            web + backend + browserless (+ snowflake-sso profile)
├── buildspec.yml, build-images.ps1   AWS CodeBuild / image build
└── run-rtb-local.ps1             one-shot local stack launcher
```

Present on disk but gitignored: `.env`, `.auth-sessions/` (MSTR session cookies), `logs/`, `backend/logs/`, `dist/`, `.venv/`, `ecs-image-archives/`.

---

## 3. Technology stack

### 3.1 Languages

| Language | Where |
|---|---|
| TypeScript (TSX) | Frontend (`src/`), Deno functions (`supabase/functions/`), gateway (`backend/server.ts`) |
| JavaScript | Browserless reference scripts, generated Playwright scripts, `runtime/server.js` |
| SQL (PostgreSQL / PL/pgSQL) | Supabase migrations, RPCs, triggers |
| SQL (Snowflake dialect) | User-defined `sql_templates`, run through the sidecar |
| Python 3.12 | Snowflake sidecar, demo recorder, `scripts/test_anthropic_hello.py` |
| PowerShell | Local launchers (`run-rtb-local.ps1`, `scripts/*.ps1`, `build-images.ps1`) |
| Shell / YAML / nginx conf | Docker entrypoint, compose, CodeBuild, nginx |

### 3.2 Frontend

| Concern | Library |
|---|---|
| Framework | React 18.3, React Router 6.30, Vite 5.4 (SWC plugin) |
| UI | Tailwind 3.4, shadcn/ui on Radix UI, lucide-react, sonner toasts |
| Data | `@supabase/supabase-js` 2.105, TanStack Query 5 |
| AI chat UI | `ai` 6.0.315 + `@ai-sdk/react` (streaming chat), `use-stick-to-bottom` |
| Export | `xlsx` 0.18.5 (write-only use) |
| Tests | Vitest 3.2 + jsdom + Testing Library |
| Lint / types | ESLint 9 + typescript-eslint; TypeScript 5.8 with **`strict: false`** |

**Installed but unused** (no imports from `src/`):
- `motion`, `@ai-sdk/anthropic`, `@ai-sdk/openai`, `zod`, `date-fns`, `@hookform/resolvers`, `cron-parser`, `drizzle-orm`, `drizzle-kit`, `postgres`, `lovable-tagger`.
- `streamdown`, `@streamdown/*` and `shiki` are aliased to local shims.
- `recharts`, `embla-carousel-react`, `input-otp`, `vaul`, `react-resizable-panels`, `react-day-picker` and `react-hook-form` are reached only through unused `ui/*` files.

### 3.3 Backend

| Concern | Technology |
|---|---|
| Runtime | Deno. The image uses **1.46.3** (end-of-life 1.x line); the local machine has 2.9.7 |
| Hosting model | One Deno process that loads every Supabase Edge Function (`backend/server.ts`) |
| DB/Auth client | `esm.sh/@supabase/supabase-js@2.45.0` (server side) |
| LLM | Raw `fetch` to `/v1/messages` (`_shared/llm.ts`). The chat agent uses `npm:ai@6.0.315` + `npm:@ai-sdk/anthropic@3.0.131` + `npm:zod@3.25.76` |
| Scheduling | `npm:cron-parser@4.9.0` (`schedule-tick`) |
| Browser automation | Browserless `ghcr.io/browserless/chromium:v2.55.4` (OSS `/chromium/function` API) |
| Warehouse | Python FastAPI + Uvicorn + `snowflake-connector-python` + Pydantic |

### 3.4 Data and platform

| Concern | Technology |
|---|---|
| Database | Supabase Postgres (hosted, project `ilyntmzpjwpjzkfghiur`). Extensions `pg_cron` and `pg_net` are enabled but unused |
| Auth | Supabase Auth (email/password); roles in `user_roles` (`admin` / `user`) |
| Storage | Supabase Storage bucket `artifacts` |
| Deployment | AWS ECS Express Mode: one Fargate task (2 vCPU / 8 GB) running 4 containers (`Main` nginx, backend, snowflake-sso, browserless). Images in ECR, secrets in Secrets Manager `rtb/prod` |
| Local | Docker Desktop on a Bayer VDI behind the Skyhigh proxy (`10.185.190.10:8080`) |

---

## 4. Architecture

```
 Browser (React SPA)
   │  Supabase Auth + PostgREST (direct, anon key + user JWT)  ──────────►  Supabase Postgres / Auth / Storage
   │  same-origin /functions/v1/<name>                                          ▲
   ▼                                                                            │ service-role key
 nginx (Main :80 on AWS / :8080 compose)  or  Vite dev proxy (:8080)            │
   │  proxy, 900 s timeout                                                      │
   ▼                                                                            │
 Deno gateway  backend/server.ts  :8000  ── hosts 15 functions ─────────────────┘
   ├── playwright-runtime ──► Browserless Chromium :3000 ──► MicroStrategy dashboards
   │        (wrapped by auth-session-gateway: cookie reuse in .auth-sessions/)
   ├── run-warehouse-sql / test-warehouse-connectivity ──► snowflake-sso :8002 ──► Snowflake
   │                                                   └─► Snowflake REST login (password/token)
   ├── agent-scripts / agent-heal* / agent-analyze / script-agent-chat ──► Anthropic-compatible gateway
   └── agent-orchestrate ──► (loopback HTTP) playwright-runtime, run-warehouse-sql, agent-scripts, agent-analyze
```

**Key architectural facts:**

1. **The "edge functions" do not run on Supabase Edge in normal use.** `backend/server.ts` monkey-patches `Deno.serve` while it imports each `supabase/functions/<name>/index.ts`, captures the handlers, and routes `/functions/v1/<name>` to them.
   - The reason: hosted Edge kills a function after about 150 s, and Playwright runs take minutes.
   - The frontend sends every call to the same origin unless `VITE_USE_CLOUD_FUNCTIONS=true` (`src/lib/functions.ts`).
2. **Two data paths from the browser.**
   - The SPA reads and writes most tables **directly through PostgREST**, protected only by RLS.
   - Long-running or privileged work goes through the Deno functions, which usually use the **service-role key** and so bypass RLS.
   - This split is the root cause of most security findings in §8.1.
3. **Functions call each other over loopback HTTP**: `LOCAL_FUNCTIONS_URL`, with the service key as the bearer token (`_shared/internal-functions.ts`).
4. **Scripts are data.** Playwright code is stored in `scripts.playwright_code`, and the reference script in `scripts.assertion_spec.__reference_playwright_code`. At run time the code is wrapped, injected with `__creds`, `__filterCombinations` and the report URL, then POSTed to Browserless.
5. **A "filter core"** (`_shared/mstr-filter-core.ts`) is embedded in every template between `@@RTB_FILTER_CORE_START@@` and `@@RTB_FILTER_CORE_END@@`. The orchestrator re-injects the current version at run time.
6. **Logic is duplicated between frontend and backend** because Vite does not bundle `supabase/**`. The pairs must be kept in sync by hand:

   | Frontend | Backend |
   |---|---|
   | `tableCompare.ts` | `table-compare.ts` |
   | `sqlFilter.ts` | `sql-filter.ts` |
   | `canonicalScript.ts` | `canonical-script.ts` |
   | `script-agent-proposal.ts` | `proposal.ts` |
   | `playwrightAuthSession.ts` | `auth-session-store.ts` |
   | KPI pass/fail in `kpi-values.ts` | `ScenarioDetail.tsx` and `agent-orchestrate` |

7. **Deployment topologies:**
   - local native (Vite + Deno + Python + Browserless in Docker);
   - Docker Compose;
   - AWS ECS Express, where all four containers share one network namespace, so Browserless can reach `127.0.0.1:8000` and `127.0.0.1:8002`.

---

## 5. Application execution flows

### 5.1 Sign-in and roles
1. `Auth.tsx` signs in with Supabase password auth. On first use it calls `bootstrap-admin`, which makes the first user an admin and refuses once any user exists.
2. `AuthContext` loads `user_roles` and sets `isAdmin`.
3. `ProtectedRoute` hides `/settings` and `/admin/users` from non-admins. This is **UI only**.
4. `functions.ts` attaches the JWT, refreshes it when it is within 60 s of expiry, and for `agent-orchestrate` also sends the **refresh token** in `X-Refresh-Token`.

### 5.2 A validation run (`agent-orchestrate`)
1. **Trigger.** A UI Run button (report, screen or case), `trigger-run` (CI with an API token), or `schedule-tick` (an external cron; nothing registers it) POSTs to `agent-orchestrate`.
2. **Auth and client.** `requireAuth` accepts any valid user JWT or the service key. The function then uses the service-role client.
3. **Scope.** A scenario resolves to its report, a report to itself, and a workstream to all of its reports.
4. **Lock.**
   - `findActiveRunConflict` scans up to 1000 running `runs` for overlapping scope and returns 409 if one is found.
   - Otherwise it inserts a `runs` row, sleeps 150 ms and re-checks; the loser cancels itself.
   - The lock is skipped when `existing_run_id` is passed.
5. **Workstream.** The parent POSTs one child `agent-orchestrate` per report over loopback, with `mapPool(reports, concurrency)` and children forced to concurrency 1. Children finalize through the `finalize_workstream_report` RPC (SECURITY DEFINER, row lock, idempotent).
6. **Per report.** It loads the report, the filter key map and the scenarios, then runs `mapPool(scenarios, concurrency)`, where concurrency defaults to `ORCHESTRATE_CONCURRENCY` (3) and is capped at 10.
7. **Per scenario.**
   - Fetch the canonical script; auto-generate it through `agent-scripts` if it is missing.
   - Re-inject the current filter core.
   - Load the `scenario_filter_matrix` combos.
   - **Combos run serially, one Browserless session each**, with a main call and then a reference call.
   - Each call is retried up to 3 times with **no backoff**.
8. **playwright-runtime.**
   - Inserts `playwright_jobs`.
   - Resolves credentials (`credential_profiles`) and the URL.
   - Wraps the code with `__creds`, `__filterCombinations` and a `process` shim, and checks syntax with `new Function`.
   - POSTs to Browserless `/chromium/function?timeout=600000`.
   - Stores the full result (including `screenshot_b64`) in `playwright_jobs.last_event`.
   - The **auth-session gateway** injects saved MSTR cookies. If the extraction looks unusable it re-runs once with a fresh login, then saves the cookies to `.auth-sessions/<profile>.json`.
9. **Expected values.**
   - Reference: the second scrape.
   - Warehouse: `run-warehouse-sql` builds a WHERE clause from the combo filters (`buildWhere`), applies the template, and runs it via the sidecar or the Snowflake REST API.
10. **Compare** each KPI: numeric with tolerance, dates, text, or tables (`compareTables`, cell by cell).
11. **Persist** one `test_results` row per combo. Each failure triggers `agent-analyze` (RCA) without waiting for it. Finally `runs.update(status, summary)`, or the RPC for workstream children.
12. **UI.** Polls `runs` and `test_results` every 3 s while anything is running. `useExecutionLocks` disables Run buttons for locked scopes.

### 5.3 Manual run from the scenario page
`ScenarioDetail` calls `playwright-runtime` directly (no lock, no pool). It then persists a run and results **from the browser** (`persistManualHeadlessRun`), and can run SQL per combo and write expected values and statuses itself (`persistWarehouseExpected`, "Sync").

### 5.4 Script generation (`agent-scripts`)
1. **Detect the kind** from title, description and `assertion_spec`. The order in code is `trend_check → record_count → grid → kpi → chart → date`, falling back to the LLM. The docs give a different order.
2. **Assemble** from `_shared/mstr-*-template.ts` or `references/*.js` using string replacement. User values go through `JSON.stringify`.
3. **Validate** (`SCRIPT_VALIDATE_ON_GENERATE`):
   - Run against Browserless with the first combo.
   - `analyzeScriptRun` checks runtime, navigation, filters and extraction.
   - **Only LLM-generated scripts are repaired**, by the LLM, using a 16k-character head+tail excerpt.
4. **Persist** to `scripts.playwright_code` with `assertion_spec.__generated_by = skill:<kind> | skill:llm | skill:repair:<n>`. Saved scripts are never replaced automatically.

### 5.5 Script chat agent (`script-agent-chat`)
- Streaming AI SDK chat with up to 12 tool steps.
- Tools: `getHelper`, `lookupScript`, `proposeScript`. `proposeScript` applies exact search-and-replace edits with structural guards.
- The UI applies a proposal only if the editor still matches its `baseCode`; the user must then Save.
- Threads are stored in `script_agent_conversations`. **This table is not in any migration or in the generated types** (see I-21).

### 5.6 Auto-heal and RCA
- `agent-heal-script`: the UI loop (up to 50 iterations) sends the full script and a screenshot, asks for a full rewrite, and saves it automatically.
- `agent-heal`: proposes a patch for a failed `test_result`.
- `agent-analyze`: writes an RCA for a failed result.

---

## 6. APIs, database and external integrations

### 6.1 HTTP endpoints (all under `/functions/v1/` on the Deno gateway; CORS `*`)

| Function | Auth | Called by | Purpose |
|---|---|---|---|
| `agent-orchestrate` | any user JWT / service key | UI, `trigger-run`, `schedule-tick`, itself | Run scenarios, reports, workstreams |
| `playwright-runtime` | any user JWT | orchestrator, ScenarioDetail, validate loop | Execute a script in Browserless |
| `run-warehouse-sql` | any user JWT | orchestrator, ScenarioDetail | Run a SQL template (or raw `sql`) in Snowflake |
| `test-warehouse-connectivity` | any user JWT | Settings | Test a stored or **inline** connector |
| `agent-scripts` | any user JWT | UI, orchestrator | Generate / regenerate scripts |
| `agent-heal`, `agent-heal-script` | any user JWT | ScenarioResultCard, ScenarioDetail | LLM healing |
| `agent-analyze` | any user JWT | orchestrator | LLM RCA |
| `agent-scenarios` | any user JWT | ReportDetail | LLM test-case generation |
| `script-agent-chat` | any user JWT | ScriptAgentChat | Streaming chat agent (optional at startup) |
| `agent-scrape` | any user JWT | nobody | **Mock**: returns hard-coded KPIs |
| `admin-users` | JWT + admin role (checked) | AdminUsers | List users, set roles, delete users |
| `bootstrap-admin` | **none** (works only while there are no users) | Auth page | Create the first admin |
| `trigger-run` | API token (SHA-256 in `api_tokens`) | external CI | Start a run |
| `schedule-tick` | **none** | external cron (none configured) | Fire due schedules |
| `/healthz` | none | Docker / ALB | Gateway health |

**Python sidecar (`:8002`, no authentication):** `POST /v1/query`, `POST /v1/test`, `DELETE /v1/connections/{id}`, `/docs`.

**Browserless (`:3000`, token):** `POST /chromium/function`, `GET /pressure`.

### 6.2 Database (Supabase Postgres)

**Hierarchy:** `workstreams → brands → reports → scenarios → scripts`, with cascading deletes.

**Children of scenarios and scripts:** `test_results`, `scenario_versions`, `script_versions`, `scenario_filter_matrix`, `playwright_jobs`.

**Children of reports:** `prerun_scripts`, `scenario_filter_key_map` (front-end → back-end filter mapping), `sql_templates`.

**Execution tables:**
- `runs`, with polymorphic `scope_type` / `scope_id` and no foreign key.
- `test_results`, which stores actual, expected, diff and status for each combo.
- `playwright_jobs`.
- `schedules`.

**Configuration tables (admin-only under RLS):** `credential_profiles`, `warehouse_connectors`, `llm_providers`, `agent_model_config`, `api_tokens`, `browser_runtime`, `schedules`.

**Other tables:** `user_roles`, `note_memory`, `operator_notes`, `warehouse_mock`; plus `script_agent_conversations`, which is used by code but not created by any migration.

**RLS:** every domain table uses `for all to authenticated using (true) with check (true)`. There is no per-user or per-team isolation and no `user_id` ownership column.

**RPCs and triggers:**

| Function | Notes |
|---|---|
| `has_role` | SECURITY DEFINER, `search_path` set; also granted to `anon` |
| `handle_new_user` | Every new sign-up gets the `user` role |
| `snapshot_scenario_version` / `snapshot_script_version` | Run on every UPDATE |
| `set_scripts_updated_at` | |
| `finalize_workstream_child`, `finalize_workstream_report` | SECURITY DEFINER, granted to `authenticated` |

**Missing indexes** on columns the app filters by:
- `test_results(run_id)`, `test_results(scenario_id, created_at)`
- `scenarios(report_id)`, `brands(workstream_id)`, `sql_templates(report_id)`
- `scenario_filter_matrix(scenario_id)`, `prerun_scripts(report_id)`
- `playwright_jobs(scenario_id)`, `operator_notes(test_result_id)`
- `runs(status)`, `runs(scope_type, scope_id)`

### 6.3 External integrations

| System | How | Credentials |
|---|---|---|
| Supabase (hosted) | supabase-js from the browser (anon key) and the backend (service-role key) | `.env` / Secrets Manager |
| MicroStrategy dashboards | Browserless Chromium; login form filled with `__creds` | `credential_profiles.password_secret_ref`, **plaintext or the name of an env var** |
| Snowflake | Python sidecar (password, key pair, externalbrowser SSO, token) or direct REST login | `warehouse_connectors`: password plaintext, PEM and passphrase plaintext in `extra` |
| Anthropic-compatible LLM | `ANTHROPIC_BASE_URL` (Bayer gateway), model `CLAUDE_MODEL` (default `claude-sonnet-4.5`) | `ANTHROPIC_API_KEY` |
| Browserless | HTTP `/chromium/function` | `BROWSERLESS_TOKEN` (default `local-dev-token`), sent in the query string |
| Corporate proxy | `HTTP(S)_PROXY`; TLS verification is disabled whenever a proxy is set | n/a |
| AWS | ECS Express, ECR, Secrets Manager, CloudWatch `/ecs/rtb` | Task / execution roles (the same role is used for both) |

---

## 7. Technical dependencies and automated check results

### 7.1 Python
| File | Packages | Notes |
|---|---|---|
| `backend/snowflake-sso/requirements.txt` | `fastapi>=0.115.0`, `uvicorn[standard]>=0.32.0`, `snowflake-connector-python>=3.12.0`, `pydantic>=2.9.0` | Minimum versions only, no lock file or hashes. The 3.12 minimum is below the 3.13.1 fixes for CVE-2025-24793/24794/24795 |
| `demo-recorder/requirements.txt` | `pyautogui`, `mss`, `opencv-python`, `numpy 1.26.4`, `Pillow 10.4.0` (pinned) | Local tool only |
| `scripts/test_anthropic_hello.py` | (no requirements file) | Connectivity smoke test |

### 7.2 SQL
- 24 PostgreSQL migrations (Supabase CLI naming). Two later ones add cascades and the atomic workstream finalization RPCs.
- `src/drizzle/migrations/0000_snapshot.json` contains SQL for `finalize_workstream_report` but is not a migration and is not referenced. Confirm the function is applied through `supabase/migrations/20261014184500_*`.
- Snowflake SQL is user-authored in `sql_templates`. WHERE predicates are built in `_shared/sql-filter.ts` and `buildWhere`.

### 7.3 Deno / container
- Remote imports: `esm.sh/@supabase/supabase-js@2.45.0` (sub-dependencies resolved by esm.sh), plus the `npm:` packages listed in §3.3, all pinned.
- `deno.lock` exists but is **not copied into the image**. `deno cache` runs with `--unsafely-ignore-certificate-errors`.
- Base images use floating tags (`node:22-alpine`, `nginx:1.27-alpine`, `python:3.12-slim`, `denoland/deno:1.46.3`). App images are pushed as mutable `:latest`.

### 7.4 Automated checks (run 2026-11-03)
| Check | Result |
|---|---|
| `vitest run` | **77 passed, 2 failed** (12 files). Example: `record-count-template.test.ts:96` expects the string `!isPccScenario && comboExtractionN…` in `agent-orchestrate/index.ts`. The orchestrator code has changed (uncommitted work) and the test, which matches on source text, no longer agrees |
| `tsc --noEmit -p tsconfig.app.json` | **Errors.** `ScriptAgentChat.tsx:54-72` uses table `script_agent_conversations`, which is absent from the generated types. `kpi-values.test.ts:291` omits a required `expected` argument |
| `eslint .` | Not completed (disk full) |
| `npm audit` | Not completed (disk full) |
| `deno check` (functions) | Not completed (disk full) |

---

## 8. Existing issues

Severity: **Critical** means exploitable now with a normal user account; **High** means it causes data loss, wrong results or security exposure; **Medium** means reliability or performance risk; **Low** means a defect with limited impact.

### 8.1 Security

| ID | Sev | Location | Issue and failure scenario | Status |
|---|---|---|---|---|
| I-1 | Critical | `test-warehouse-connectivity/index.ts:25,37,40,47-68,148-162` | **Any signed-in user can extract backend secrets.** An inline `connector` from the request body is accepted. `password_secret_ref` / `token_secret_ref` are resolved with `Deno.env.get(ref) ?? ref`, and the login URL is built from the caller-supplied `account`. Sending `password_secret_ref:"SUPABASE_SERVICE_ROLE_KEY"` and `account:"attacker.example/?"` POSTs the service-role key (full DB bypass) to the attacker's host. The same works for `ANTHROPIC_API_KEY` and `BROWSERLESS_TOKEN` | Verified |
| I-2 | Critical | `playwright-runtime/index.ts:612-689` | **Any signed-in user can read admin-only MSTR passwords.** The endpoint takes caller-supplied `code`, uses the service-role client, resolves `__creds` for any `scenario_id` and executes the code, so `export default async () => __creds` returns the password. The gateway also injects that profile's saved session cookies | Verified |
| I-3 | High | `playwright-runtime/index.ts:685-689`; migration `20260513001009:79-84` | **Session cookies and screenshots are written to a table every user can read.** The full result, including `__storageState` and `screenshot_b64`, is saved to `playwright_jobs.last_event` *before* the gateway strips the cookies. `playwright_jobs` has `using (true)` read for all authenticated users. Each row is also multi-MB | Verified |
| I-4 | High | migration `20260513001009:73-86` (+ later) | **No row-level authorization on domain data.** Any user can rewrite or delete every workstream, report, scenario, script, SQL template, run and result, and forge `*_versions`. Results are not tamper-evident. Admin-only pages are hidden in the UI only | Verified |
| I-5 | High | `sql_templates` RLS + `agent-orchestrate` → `run-warehouse-sql` (service key) | **Any user can run arbitrary Snowflake SQL** with the admin-configured connector: edit a template to `SELECT * FROM <anything>` (or DML if the role permits) and click Run. Rows land in `test_results.expected`, which everyone can read | Confirmed |
| I-6 | High | `agent-orchestrate:793`, `_shared/sql-filter.ts:386,410` | **SQL injection through filter values.** Only `'` is doubled. Snowflake also treats `\` as an escape, so `\' OR 1=1 --` breaks out of the literal. Values come from `scenario_filter_matrix` (writable by any user) or from scraped dropdowns | Confirmed |
| I-7 | High | `agent-scripts`, `script-gen-validate-loop.ts`, `agent-heal-script`, `ScenarioDetail.tsx:580,644-655` | **LLM output runs with real credentials and is never checked.** Descriptions and run errors (prompt-injectable) feed the model; the generated, repaired or healed code runs in Browserless with `__creds` injected and is auto-saved by auto-heal. No allow-list of hosts or APIs is enforced | Confirmed |
| I-8 | High | `backend/snowflake-sso/app.py:172-180,282-327` | **The Snowflake sidecar has no authentication and binds `0.0.0.0`.** Its connection cache is keyed only by the caller's `connector_id` and reused whatever credentials are sent. On ECS, Browserless (running user scripts) shares localhost with it. On a VDI, other LAN hosts can query with the developer's cached SSO session. Rotated credentials are ignored until restart | Confirmed |
| I-9 | High | `.devcontainer/devcontainer.json:9-17` | The Codespace forwards Browserless :3000 **publicly**, protected only by the published `local-dev-token` | Confirmed |
| I-10 | High | `credential_profiles`, `warehouse_connectors`, `Settings.tsx:186-187,229-236,497` | **Credentials are stored unencrypted**: MSTR and Snowflake passwords, PEM private keys and passphrases are plaintext in Postgres and are sent back to the admin's browser. MSTR cookies are plaintext files in `.auth-sessions/`, which locally sits inside OneDrive | Confirmed |
| I-11 | Medium | `src/lib/functions.ts:77-86` | The **refresh token** is sent to the backend (`X-Refresh-Token`, on by default). This widens where a long-lived credential is exposed and can trigger Supabase refresh-token reuse revocation mid-run | Confirmed |
| I-12 | Medium | `_shared/auth.ts:57-64,84-115` | With `AUTH_DEV_GRACE=true` (opt-in), forged or expired JWTs are accepted and upgraded to the service-role client; "network-ish" auth errors fall through to *accepted* | Confirmed (not enabled in prod config) |
| I-13 | Medium | `docker-entrypoint.sh:8-12`, `app.py:162-167`, compose `:85`, task def `:95` | **TLS verification is off** whenever a proxy is set (Deno and Snowflake). Browserless always runs with `--ignore-certificate-errors`. Compose pins `mstr-prod/qa.bayer.com` to fixed AWS ALB IPs, so a reassigned IP would receive real MSTR passwords | Confirmed |
| I-14 | Medium | `schedule-tick/index.ts` | No authentication: lists schedule ids, cron expressions and scopes to anyone who can reach the gateway | Confirmed |
| I-15 | Medium | `finalize_workstream_*` grants, `has_role` granted to `anon` | Any user, and plausibly the anon key, can call the finalize RPCs and mark any run completed or failed | Plausible |
| I-16 | Medium | `logs/script-agents/*.json` (`script-gen-validate-loop.ts:316`, `script-agent-log.ts:111`) | Logging is **on by default** (the docs say opt-in). Logs contain the Browserless token inside URLs, MSTR hostnames and titles. There is no rotation and every event rewrites 4 files | Confirmed |
| I-17 | Medium | `nginx.runtime.conf.template`; `ReportDetail.tsx:278`, `RunScenarioCard.tsx:186` | No CSP, X-Frame-Options or HSTS. User-editable URLs are rendered as `href` without scheme checks (`javascript:`), and sessions live in `localStorage` | Plausible |
| I-18 | Medium | `infra/ecs/task-definition.json:8`; Dockerfiles | The task role equals the execution role (Secrets Manager / ECR rights at runtime); containers run as root; Deno runs with `--allow-read --allow-write --allow-env` | Confirmed |
| I-19 | Low | `runtime/server.js:59-63` | Unused, unauthenticated Express server that runs posted code with `new Function`. Remote code execution if it is ever deployed | Confirmed |
| I-20 | Low | `.dockerignore` | Does not exclude `.auth-sessions/`, so the web image build context and build layers receive MSTR cookies | Confirmed |

### 8.2 Correctness bugs

| ID | Sev | Location | Issue and failure scenario | Status |
|---|---|---|---|---|
| I-21 | High | `ScriptAgentChat.tsx:54-72`; `supabase/migrations/` | `script_agent_conversations` is used but **no migration creates it**, and it is absent from the generated types (causing tsc errors). On a fresh database, chat history load and save fail | Verified (tsc + grep) |
| I-22 | High | `ScenarioDetail.tsx:847-857` + `:3495` | **The wrong SQL result is applied to other combos.** `runComboSql` passes `sqlResult: data` (the current combo's result). For every combo without its own entry, `persistWarehouseExpected` falls back to that result and overwrites the combo's expected values and status | Verified |
| I-23 | High | `ScenarioDetail.tsx:847,871-881` | **Stale closure in "Run all combos".** Each iteration builds `nextCombo` from the render-time `comboResults`, discarding earlier iterations. Combined with I-22, every combo ends up compared against the last SQL result | Verified |
| I-24 | High | `ScenarioDetail.tsx:343,3531,3610` | **The browser writes `runs.status = "running"`** whenever any row is pending, and nothing ever completes it. `useExecutionLocks` then locks the scenario, report and workstream indefinitely (Run buttons disabled, endless 3 s polling) | Verified |
| I-25 | High | `agent-orchestrate:1828,1837,1861,991` | **Runs can stay "running" forever.** Final update results are unchecked, errors are swallowed by `.catch(() => {})`, and there is no stale-run cleanup. A crash or restart mid-run leaves the scope permanently blocked by the 409 lock | Confirmed |
| I-26 | High | `agent-orchestrate:243-256` (`mapPool`) | One thrown error (for example a failed `test_results` insert) rejects `Promise.all`. The run is finalized as failed with pass/fail = 0 **while the other workers keep inserting results** into the finalized run, so the summary and the rows disagree | Confirmed |
| I-27 | High | `agent-orchestrate:46-49`; `mstr-filter-core.ts:572-575` | **Orchestrated runs replace the record-count script's frame-aware filter core** with the main-frame core, because `hasFilterCore` accepts the frame core. Record-count filters can pass in manual runs and fail in orchestrated runs | Verified (swap) / Plausible (impact) |
| I-28 | High | `_shared/llm.ts:268`; `agent-scripts:1415-1431`; `script-validation.ts:361-392` | **Truncated LLM output is saved.** `stop_reason` is never checked, and `recoverPlaywrightCode` accepts a cut-off script. Repair sends only a head+tail excerpt (>16k characters) but asks for the *complete* script, so the model must invent the missing middle (the filter core and extract helpers) | Confirmed |
| I-29 | High | `agent-heal-script/index.ts:58-64,115` | Asks for the full rewritten script (~60k characters) with `max_tokens: 4096`, and **instructs the model to use `getByRole` / `getByText` / `.first()`**, which the Browserless runtime contract forbids. Auto-heal saves each result unchecked | Verified |
| I-30 | Medium | `script-gen-validate-loop.ts:168-178` | `SCRIPT_VALIDATE_MAX_ATTEMPTS` set to a non-number gives `NaN`, so zero validation attempts run and the script is saved unvalidated | Verified |
| I-31 | Medium | `agent-scripts:247-490` vs `docs/` | The detector order differs from the docs (`kpi` comes before `chart`), so chart scenarios with configured KPIs become KPI scripts. The docs say templates are repaired; the code skips them. The trend_check kind skips validation entirely | Confirmed |
| I-32 | Medium | `ScenarioDetail.tsx:219-237,463-472` | **Unsaved editor changes are silently overwritten** when the scenario or script queries refetch, and "Run" prefers the DB code over the editor | Confirmed |
| I-33 | Medium | `ScenarioDetail.tsx:1310-1367` ("Sync") | Overwrites `runs.status/summary` for possibly in-progress orchestrated runs, which breaks the finalize RPC, and lets users rewrite stored results to PASS | Plausible |
| I-34 | Medium | `lib/deleteEntities.ts`, `lib/duplicateEntities.ts` | Multi-step delete and duplicate run from the browser with no transaction, so partial failures leave half-deleted or half-copied trees. Schedule deletes silently affect 0 rows for non-admins (orphan schedules keep firing). Delete ignores execution locks | Confirmed |
| I-35 | Medium | `latestTestResults.ts:48-53`; Dashboard/Scenarios/Reports limits | The PostgREST 1000-row cap silently truncates the `limit(2000/5000/10000)` queries, so results show as "pending". One busy scenario can hide others in a chunk | Confirmed |
| I-36 | Medium | `ScenarioDetail.tsx:3661-3840` vs `kpi-values.ts` vs `agent-orchestrate` | Pass/fail evaluation is implemented three times, so the detail page, list pages and backend can disagree | Confirmed |
| I-37 | Medium | `script-agent-chat/index.ts:136,283-289` | One gateway 403 writes `access_denial` and **locks that conversation permanently** | Confirmed |
| I-38 | Medium | `agent-scripts:1394` | `scenario.reports.kpi_config` without optional chaining crashes the LLM path when the report was deleted | Confirmed |
| I-39 | Medium | `run-warehouse-sql:52-55` | `:name` placeholders are replaced with `JSON.stringify(v)` (a double-quoted *identifier* in Snowflake), and `replaceAll(':brand')` also clobbers `:brand_id` | Confirmed |
| I-40 | Low | various | `bootstrap-admin` ignores the role-insert error (lockout risk); `admin-users set-role` ignores errors and allows removing the last admin; `trigger-run` passes 409/500 through as HTTP 200; `/healthz` stays 503 if optional chat fails to load; `s.description` is never selected (AO:1023 vs 1158); unhandled `void persistManualHeadlessRun(...)` promises | Confirmed |

### 8.3 Performance and resource bottlenecks

| ID | Sev | Location | Issue |
|---|---|---|---|
| P-1 | High | `agent-orchestrate:1185-1214`, `auth-session-wrap.ts:116` | Full-page `screenshot_b64` is parsed and cloned 3–4 times per call and **kept in memory for every combo** until a scenario finishes. With 10 parallel scenarios × combos × 2 targets in an 8 GB task shared with Chromium, this risks running out of memory. The screenshot is never used (`screenshot_url` is always null) |
| P-2 | High | `agent-orchestrate:1159-1210`, `auth-session-gateway.ts:137-147` | Worst case per combo: 3 retries × (run + fresh-login re-run) × 10 min ≈ **1 hour**, doubled for reference. Combos are serial. There is no backoff, no overall deadline, and no fetch timeout on warehouse or LLM calls |
| P-3 | High | `script-gen-validate-loop.ts`, `llm.ts` | One Generate can take ~95 min and ~80k output tokens on the LLM path, inside one HTTP request that keeps running after the client disconnects. Prompt caching is not used despite ~30k-character static system prompts |
| P-4 | Medium | — | No global Browserless concurrency limit. Each request has its own pool; separate scopes and direct UI runs add up past `CONCURRENT=3` (compose) or `10` (ECS) |
| P-5 | Medium | `playwright-runtime`, gateway | About 9 DB round-trips per Browserless call (job insert/update, credentials ×3, URL ×2, profile ×2), repeated for every combo |
| P-6 | Medium | `script-agent-chat` `proposal.ts:172` | The `proposeScript` tool result (`code` + `baseCode`, ~120k characters) is fed back to the model on each of up to 12 steps, which is a likely cause of the gateway 502s |
| P-7 | Medium | `Scenarios.tsx:160`, `Runs.tsx:49-58`, `useExecutionLocks.ts:59` | 3 s polling re-downloads large payloads: about 25 sequential `test_results` chunks plus 5000 scripts *including `playwright_code`*; Runs re-fetches all results for 200 runs. Lock polling runs unconditionally on every page |
| P-8 | Medium | `ScenarioDetail.tsx` | One 5,500-line component with ~60 `useState` and a single `useMemo`. Every keystroke in the editor re-runs heavy KPI pairing and re-renders the whole tree. It pulls up to 1000 full `test_results` rows on mount |
| P-9 | Medium | `ScenarioResultCard.tsx:75` | N+1: each card fetches its own script, including the full code |
| P-10 | Medium | migrations | Missing indexes (§6.2). Cascade deletes and lock and dashboard queries do sequential scans that get slower as `test_results` grows. Version-snapshot triggers copy the full `playwright_code` on every UPDATE, growing without limit |
| P-11 | Medium | `app.py:173-203` | A global lock is held during Snowflake connect (up to 120 s) and a ping on every query, so one slow login blocks all warehouse checks. Inline tests leak cached sessions. There is no statement timeout |
| P-12 | Low | Vite config | No code splitting: xlsx, the AI SDK, ScenarioDetail and the chat UI are all in the main bundle. Many unused dependencies are installed |
| P-13 | Low | `agent-orchestrate:64-85`, `script-agent-log.ts` | Append-only JSONL with `mkdir` per line and O(n²) rewrites of the log files, with no rotation. The local disk is full right now |

### 8.4 Maintainability and documentation drift

- **Duplicated modules** between `src/lib` and `_shared` (§4.6) have no shared package and no parity tests. One drift is already confirmed: the chat run-context limit is 5,000 characters in the frontend and 3,000 on the server.
- **TypeScript `strict: false`** and heavy `any` use. The generated Supabase types are stale: the finalize RPCs and `script_agent_conversations` are missing.
- **Tests read source code as text.** For example, `record-count-template.test.ts` checks that particular strings appear in the orchestrator, so refactors break the tests without any change in behaviour.
- **No tests** for the riskiest logic: ScenarioDetail persistence and comparison, `sqlFilter.ts`, `functions.ts`, `useExecutionLocks`, delete and duplicate, the orchestrator, `playwright-runtime`.
- **Dead code:**
  - `runtime/`, `agent-scrape` (mock), `pages/Index.tsx`, `pages/Tests.tsx`, `KpiSummary.tsx`, `lib/platform/` (both sides), `src/drizzle/`, `scripts/_performance-trend-grid-working.js`.
  - Unused helpers in `run-id.ts` and `script-gen-skill.ts`.
  - The `sql_templates` query on every Generate.
- **Broken tooling:** `npm run dev:all` (missing `scripts/dev-all.ps1`); `build-images.ps1` (undefined variables); the `buildspec.yml` nginx copy does nothing; `infra/README.md` describes Lambda, Cognito and Aurora resources that do not exist.
- **Docs out of date:** detector order, template repair, logging default, filter cadence, skill version, and the function count in `START-HERE.md`. `docs/SCRIPT_AGENTS_WORKING.md` also points to `.cursor/skills/*`, which is not in the repository.
- **Machine-specific setup:** hard-coded proxy IP, MSTR IP pins, and `C:\Users\EASXP\...` paths in the docs.

---

## 9. Prioritized implementation roadmap

Each phase is a set of separately reviewable changes. Following the repository workflow, every item should start as a short spec in `specs/` and be implemented only after approval.

### Phase 0: Contain exposure (immediately, days)
1. **I-1:** In `test-warehouse-connectivity` and `run-warehouse-sql`, stop resolving `*_secret_ref` from arbitrary env names (use an explicit allow-list or a secret store), validate `account`/`host` against `^[A-Za-z0-9_.-]+$`, and require admin for inline connectors.
2. **I-2:** In `playwright-runtime`, never combine caller-supplied `code` with stored credentials unless the caller is an admin, or the code equals the saved script for that scenario.
3. **I-3:** Remove `__storageState` and `screenshot_b64` from `last_event` before saving it, and restrict `playwright_jobs` reads. Purge existing rows that contain cookies.
4. **I-8, I-9, I-14:** Add a shared-secret header to the sidecar, bind it to `127.0.0.1`, and key the connection cache by a hash of all connection fields. Make the Codespace port private. Require the service key or a token for `schedule-tick`.
5. **Rotate secrets** that may already have been exposed: the service-role key, the Browserless token, MSTR service-account passwords.
6. Confirm Supabase **public sign-up is disabled**. If it is enabled, every Critical item can be exploited from the internet.

### Phase 1: Authorization and data integrity (1–2 weeks)
1. **I-4, I-5:** Redesign RLS so that configuration (`sql_templates`, `scripts.sql_template_id`, `scenario_filter_key_map`, credential bindings on `reports`) is admin- or owner-write. Use a read-only Snowflake role with a statement timeout.
2. **I-6, I-39:** Use parameter binding (or escape both `\` and `'`) for filter values, and fix the `:name` placeholder replacement.
3. **I-10, I-11:** Move credentials into Supabase Vault or Secrets Manager and stop returning them to the browser. Stop sending the refresh token; give long runs a server-side identity instead.
4. **I-15, I-12:** Revoke the finalize RPCs and `has_role` from `anon`/`authenticated` where possible, and remove the `AUTH_DEV_GRACE` path.
5. **I-21:** Add the missing `script_agent_conversations` migration and regenerate `types.ts`.

### Phase 2: Run correctness and reliability (1–2 weeks)
1. **I-22, I-23, I-24, I-33:** Fix the SQL fallback and the stale closure. **Stop the browser writing `runs.status`**: move manual-run persistence, warehouse-expected persistence and Sync into a backend function.
2. **I-25, I-26:** Add a stale-run reaper (`pg_cron` is already enabled), check finalization errors, make `mapPool` record per-item failures instead of rejecting, and enforce the run lock with a DB constraint or advisory lock.
3. **I-27:** Exclude the record-count frame core from `withCurrentFilterCore`.
4. **P-2:** Retry with backoff, set an overall run deadline, and add fetch timeouts on all internal and LLM calls.
5. **I-34:** Move cascade delete and duplicate into transactional Postgres RPCs, and respect execution locks.
6. **I-35, I-36:** Paginate properly, or use a server-side "latest result per scenario" view. Put pass/fail evaluation in one shared module used by the UI and the orchestrator.

### Phase 3: AI pipeline safety and cost (1–2 weeks)
1. **I-7:** Check every LLM, repair and heal output before execution: Browserless contract, host allow-list, no exfiltration of `__creds`. Require human approval before auto-saving healed scripts.
2. **I-28, I-29:** Reject `stop_reason: max_tokens`. Switch repair and heal to edit-based output (as the chat agent already does) and stop sending excerpts with a request for full scripts. Rewrite the heal prompt to match the runtime contract.
3. **I-30, I-31, I-37, I-38:** Fix the NaN clamp, align the detector order with the docs (or the docs with the code), make the 403 lock expire, and add null safety.
4. **P-3, P-6:** Enable prompt caching for the static system prompts, strip `code`/`baseCode` from tool results sent back to the model, and pass the request abort signal through.
5. **I-16:** Default script-agent logging to off, redact tokens, and add rotation.

### Phase 4: Performance (1–2 weeks)
1. **P-1:** Drop screenshots from runtime responses, or upload them to Storage and pass the URL. Free per-combo responses once they have been compared.
2. **P-4, P-5:** Add a process-wide Browserless semaphore. Resolve credentials and URLs once per scenario.
3. **P-10:** Add the missing indexes. Snapshot versions only when `playwright_code` or spec actually changes.
4. **P-7, P-9:** Poll lightweight status endpoints only; never select `playwright_code` in list views; turn lock polling off when idle.
5. **P-8, P-12:** Split `ScenarioDetail` into memoized sub-components with local editor state, and lazy-load heavy routes and dependencies.
6. **P-11:** Per-connector locks in the sidecar, statement timeouts, and closing cached sessions.

### Phase 5: Engineering hygiene (ongoing)
1. Fix the 2 failing tests and the tsc errors. Get ESLint, `npm audit` and `deno check` running cleanly in CI.
2. Turn on `strictNullChecks` gradually. Add tests for the untested critical paths (§8.4), plus parity tests for the duplicated modules (or extract them into one shared package).
3. Remove dead code (`runtime/`, `agent-scrape`, unused pages and dependencies, `src/drizzle/`). Fix `dev:all`, `build-images.ps1`, `buildspec.yml` and `.dockerignore`.
4. Infra: separate the task and execution roles, run containers as non-root, use immutable image tags, copy `deno.lock` into the image, add nginx security headers, upgrade Deno to 2.x, and pin Python dependencies with hashes.
5. Bring `docs/` back in line with the code, and replace `infra/README.md` with the real deployment.

### Candidate skill files (for the agentic engineering assistant)

These follow directly from the recurring work in this codebase and can be refined in the next step:

| Skill | Purpose | Grounded in |
|---|---|---|
| `rtb-security-review` | Check changes to functions, RLS or credentials against the authorization model (§8.1) | I-1 … I-20 |
| `rtb-supabase-migration` | Write migrations with RLS, indexes and grants; regenerate `types.ts` | §6.2, I-4, I-21, P-10 |
| `rtb-edge-function` | Add or modify a function in the Deno gateway (registration in `server.ts`, auth, CORS, internal calls, timeouts) | §4, §6.1 |
| `rtb-orchestrator-debug` | Diagnose stuck, failed or inconsistent runs (`runs`, `test_results`, locks, finalization) | §5.2, I-25, I-26 |
| `rtb-mstr-script-template` | Change or add MSTR templates and the filter core under the Browserless contract | §5.4, I-27, `docs/SCRIPT_AGENTS_WORKING.md` |
| `rtb-llm-pipeline` | Change generation, repair, heal or chat prompts and LLM calls safely (truncation, caching, output checks) | I-7, I-28, I-29, P-3, P-6 |
| `rtb-warehouse-sql` | Snowflake templates, filter predicates, sidecar behaviour | I-5, I-6, I-8, I-39, P-11 |
| `rtb-frontend-page` | Work in the React pages (query patterns, polling, splitting ScenarioDetail) | I-22 … I-24, I-32, P-7, P-8 |
| `rtb-parity-check` | Keep the duplicated frontend/backend modules in sync | §4.6, §8.4 |
| `rtb-local-stack` | Start, health-check and troubleshoot the local and compose stacks on the VDI | README, `run-rtb-local.ps1`, compose |

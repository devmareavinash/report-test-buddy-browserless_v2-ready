# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Report Test Buddy (RTB) validates values shown in MicroStrategy/analytics dashboards. Saved per-scenario Playwright scripts run in Browserless Chromium, extract KPI / chart / grid values, and are compared against a reference UI extraction or Snowflake SQL. Scenarios, scripts, runs and results live in Supabase (hosted Postgres + Auth).

## Commands

Windows/PowerShell dev environment (corporate VDI behind a proxy).

```powershell
npm test                                   # vitest run (jsdom), src/**/*.{test,spec}.{ts,tsx}
npx vitest run src/lib/tableCompare.test.ts   # single file
npx vitest run -t "test name"              # single test by name
npm run lint                               # eslint
npm run build                              # vite build

# Full local stack (Browserless, Snowflake SSO sidecar, Deno backend, Vite)
powershell -ExecutionPolicy Bypass -File .\run-rtb-local.ps1 -SkipInstall [-SkipSso] [-SkipBrowserless] [-Compose]

# Individual services
npm run dev                                # Vite UI on 127.0.0.1:8080 (load env first: . .\scripts\load-env.ps1)
npm run dev:backend                        # Deno gateway on :8000 (loads .env, runs backend/server.ts)
npm run dev:sso                            # Snowflake FastAPI sidecar on :8002 (needs .venv + backend/snowflake-sso/requirements.txt)
docker compose up -d browserless           # Browserless on :3000
docker compose up -d --build               # web + backend + browserless; add --profile docker-sso for the sidecar
```

Health checks: `curl http://127.0.0.1:8000/healthz`, `curl "http://127.0.0.1:3000/pressure?token=local-dev-token"`. A healthy backend logs `Backend listening on :8000 — N/N functions loaded`.

Note: `npm run dev:all` references `scripts/dev-all.ps1`, which does not exist.

## Architecture

```
React SPA (Vite :8080 / nginx)
   │  same-origin /functions/v1/<name>   (Vite proxy or nginx → :8000)
   ▼
Deno gateway backend/server.ts (:8000) ── hosts every supabase/functions/<name>/index.ts
   ├─► Browserless Chromium (:3000)   runs saved Playwright scripts
   ├─► snowflake-sso sidecar (:8002)  Python FastAPI → Snowflake
   ├─► Supabase (service role)        persists runs / test_results
   └─► Anthropic-compatible LLM       script generation / repair / analysis
```

- **Edge functions are not deployed to Supabase Edge in normal use.** `backend/server.ts` monkey-patches `Deno.serve` to capture each function's handler, then routes `/functions/v1/<name>/*` to it in one process. A new function must be added to the `FUNCTIONS` list there. Hosted Edge idle-kills Playwright at 150s, so the frontend (`src/lib/functions.ts`) defaults to the local/same-origin backend; `VITE_USE_CLOUD_FUNCTIONS=true` opts back into hosted Edge.
- `playwright-runtime` is wrapped at the gateway by `_shared/auth-session-gateway.ts` to persist/restore MicroStrategy login cookies (`.auth-sessions/`, gitignored).
- **Run flow:** `trigger-run` / `schedule-tick` → `agent-orchestrate` (the core: concurrency pool, active-run locking, per-combination extraction, KPI comparison with tolerances/dates/structured values, atomic run finalization) → `playwright-runtime` (main + reference scrapes) and/or `run-warehouse-sql` → results written to Supabase.
- **Script generation:** `agent-scripts` detects the template kind from the user's description (`kpi`, `chart_show_data`, `trend_check`, `geography_grid`, `date_refresh`) and assembles it from `_shared/mstr-*-template.ts`; LLM generation is only a fallback. Generate/Regenerate runs a validate-and-repair loop (`_shared/script-gen-validate-loop.ts`, `_shared/script-validation.ts`). Saved scripts are never replaced automatically — regeneration is an explicit user action. `script-agent-chat` is optional at startup (may fail to load behind the proxy).
- **Filter core:** `_shared/mstr-filter-core.ts` is embedded in every template between `// @@RTB_FILTER_CORE_START@@` / `// @@RTB_FILTER_CORE_END@@`. Fix the core file, never a copy inside a template, reference script, or healed script.
- **Browserless script contract** (see `docs/SCRIPT_AGENTS_WORKING.md` §10): `export default async ({ page }) => {...}`, no imports; runtime injects `__creds`, `__filterCombinations`, report URL; never hardcode filter values or credentials; `domcontentloaded` not `networkidle`; no `page.waitForTimeout`, `getByText`/`getByRole`, or locator chaining.

### Duplicated frontend/backend modules

Vite does not watch or bundle `supabase/**`, so some logic exists twice and must stay behaviourally identical:

| Frontend (`src/lib/`) | Backend (`supabase/functions/_shared/`) |
|---|---|
| `tableCompare.ts` | `table-compare.ts` (backend copy decides the stored status) |
| `sqlFilter.ts` | `sql-filter.ts` |
| `canonicalScript.ts` | `canonical-script.ts` |
| `script-agent-proposal.ts` | `../script-agent-chat/proposal.ts` |
| `platform/index.ts` | `platform/index.ts` (adapter facades; only Supabase is wired, AWS is a stub) |

Some vitest tests import backend modules directly (e.g. `src/lib/record-count-template.test.ts`), which is how `_shared` code gets tested.

### Frontend

React 18 + TypeScript, shadcn/Radix (`src/components/ui/` is generated — don't hand-edit), TanStack Query, React Router; pages in `src/pages/`. Supabase client/types in `src/integrations/supabase/`. `streamdown`/`shiki` are aliased to lightweight shims in `src/shims/` (full packages are too large for the VDI disk). Vite HMR is deliberately disabled and the server binds to `127.0.0.1` because the corporate proxy kills the HMR websocket.

### Database

Supabase migrations in `supabase/migrations/` (Supabase CLI, project id in `supabase/config.toml`). Run finalization uses DB functions (`atomic_workstream_finalization`, `finalize_workstream_report`).

## Environment

Copy `.env.example` → `.env`. `SUPABASE_SERVICE_ROLE_KEY` is server-only — never in `VITE_*` vars or `src/`. In Docker, backend hostnames are compose service names (`browserless`, `snowflake-sso`), not `127.0.0.1`; `docker-compose.yml` comments explain the proxy/DNS workarounds (MSTR hosts pinned via `extra_hosts`, Chromium must not use the corporate proxy). Only the UI port should be exposed; 8000/8002/3000 stay private.

## Further docs

- `docs/SCRIPT_AGENTS_WORKING.md` — script-generation policy, templates, extraction rules, common failures. Read before changing templates or `agent-scripts`.
- `docs/VALIDATION_AGENT.md` — Generate-time validate/repair loop.
- `docs/ARCHITECTURE_AND_FUNCTIONING.md`, `docs/DEPLOYMENT_GUIDE.md` — AWS ECS Express deployment (single Fargate task, four containers, `nginx.aws.conf`, `infra/ecs/task-definition.json`).
- `LOCAL_TEST_STEPS.md` — manual regression checklist (result/history consistency, multi-user execution locks).

# Report Test Buddy

Report Test Buddy validates data shown in analytics dashboards. It runs saved
Playwright scripts in Browserless, extracts KPI or grid values, compares them
with another UI or Snowflake, and stores the result and execution history.

## Tech stack

### Frontend

- React 18 and TypeScript
- Vite
- Tailwind CSS and shadcn/Radix UI
- React Router
- TanStack Query
- React Hook Form and Zod
- Recharts
- Vitest and Testing Library

### Backend and data

- Deno HTTP gateway on port `8000`
- Supabase Edge Function code for orchestration, extraction and analysis
- Supabase Postgres for scenarios, scripts, runs and results
- Supabase Auth for user sessions
- Supabase migrations under `supabase/migrations`

### Browser automation

- Playwright scripts saved per scenario
- Browserless Chromium running in Docker on port `3000`
- Each script runs headlessly and returns extracted KPI or grid values
- Default Browserless timeout: 10 minutes

### Warehouse integration

- Snowflake Python connector
- FastAPI and Uvicorn SSO sidecar on port `8002`
- Warehouse results can be compared with values extracted from the UI

### Optional AI integration

- Anthropic-compatible API for script generation, repair and failure analysis
- The default internal endpoint is configurable with `ANTHROPIC_BASE_URL`

## How the application works

1. A user creates a report, scenario, KPI configuration and filter combinations.
2. The application loads the scenario's last saved Playwright script.
3. The Deno orchestrator sends the script to Browserless.
4. Browserless opens the report, applies filters and extracts values.
5. For reference checks, a second UI extraction supplies the expected values.
6. For warehouse checks, the Snowflake sidecar executes the configured SQL.
7. The application compares actual and expected values using KPI tolerances.
8. Results, errors and run totals are stored in Supabase and displayed in the UI.

Saved scripts are not automatically replaced. Regeneration is an explicit user
action.

## Local infrastructure

The full application uses these services:

- UI: `http://127.0.0.1:8080`
- Deno backend: `http://127.0.0.1:8000`
- Browserless: `http://127.0.0.1:3000`
- Snowflake SSO sidecar: `http://127.0.0.1:8002`
- Supabase: hosted Postgres and authentication

Only the UI should be exposed to users. Ports `8000`, `8002` and `3000` should
remain private.

## Prerequisites

Install:

- Node.js 22 or newer
- npm
- Deno
- Docker Desktop
- Python 3.11 or newer
- Access to the required Supabase project
- Bayer network/VPN access for internal dashboard, Snowflake and AI endpoints

Docker Desktop should have at least 4 GB of memory available. Browserless also
uses a `2 GB` shared-memory allocation.

## Environment setup

Create the local environment file:

```powershell
Copy-Item .env.example .env
```

Set at least:

```text
VITE_SUPABASE_URL=
VITE_SUPABASE_PUBLISHABLE_KEY=
VITE_SUPABASE_PROJECT_ID=
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
BROWSERLESS_HOST=http://127.0.0.1:3000
BROWSERLESS_TOKEN=local-dev-token
SNOWFLAKE_SSO_URL=http://127.0.0.1:8002
```

Add `ANTHROPIC_API_KEY` only when script generation or AI analysis is required.
Never commit `.env` or real secrets.

The Supabase service-role key is server-only. Do not place it in frontend source
code or any `VITE_*` variable.

## Run locally on Windows

Start Docker Desktop, connect to the Bayer VPN if required, and run:

```powershell
cd report-test-buddy-browserless_v2-ready
npm install
powershell -ExecutionPolicy Bypass -File .\run-rtb-local.ps1 -SkipInstall
```

Open:

```text
http://127.0.0.1:8080
```

The startup script launches or reuses Browserless, the Snowflake SSO sidecar,
the Deno backend and the Vite frontend.

To skip Snowflake when warehouse comparisons are not needed:

```powershell
powershell -ExecutionPolicy Bypass -File .\run-rtb-local.ps1 -SkipInstall -SkipSso
```

## Run services separately

Frontend:

```powershell
npm install
npm run dev
```

Deno backend:

```powershell
npm run dev:backend
```

Snowflake SSO sidecar:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend\snowflake-sso\requirements.txt
npm run dev:sso
```

Browserless:

```powershell
docker compose up -d browserless
```

## Run with Docker Compose

Start the UI, backend and Browserless:

```powershell
docker compose up -d --build
```

Include the containerized Snowflake sidecar:

```powershell
docker compose --profile docker-sso up -d --build
```

Check status:

```powershell
docker compose ps
curl.exe http://127.0.0.1:8000/healthz
curl.exe "http://127.0.0.1:3000/pressure?token=local-dev-token"
```

Stop the stack:

```powershell
docker compose down
```

## Tests and build

```powershell
npm test
npm run lint
npm run build
```

## Production infrastructure

A production deployment needs:

- Private network access to Supabase, Browserless, Snowflake and target reports
- A static web host or Nginx for the React build
- A long-running Deno backend for orchestration
- Browserless/Chromium with sufficient CPU, memory and shared memory
- A Python Snowflake sidecar when warehouse checks are enabled
- Secure secret storage
- Central logs and health monitoring

The repository includes an AWS reference design under `infra/`. It maps the UI
to S3/CloudFront, APIs to Lambda/API Gateway, long jobs and Playwright to ECS
Fargate, data to Aurora PostgreSQL, authentication to Cognito, secrets to
Secrets Manager, and monitoring to CloudWatch.

## Troubleshooting

### Unauthorized when starting a run

- Confirm the backend was started with `npm run dev:backend` or the provided
  startup script so `.env` is loaded.
- Refresh the page or sign in again if the browser session expired.

### Browserless timeout

- Confirm Docker Desktop is running.
- Check `http://127.0.0.1:3000/pressure?token=local-dev-token`.
- Review the saved Playwright selectors, waits and navigation.
- Change `BROWSERLESS_TIMEOUT_MS` only when a script genuinely needs more time.

### Snowflake checks fail

- Start without `-SkipSso`.
- Confirm the sidecar responds on port `8002`.
- Confirm VPN, proxy and Snowflake authentication are available.

### Internal dashboard does not load in Browserless

- Confirm VPN/network access.
- Check Docker DNS and proxy settings in `docker-compose.yml`.
- Confirm the report hostname is reachable from inside the container.

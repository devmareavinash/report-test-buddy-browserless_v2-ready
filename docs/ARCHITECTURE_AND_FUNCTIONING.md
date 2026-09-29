# Report Test Buddy — Architecture & Functioning

**Audience:** reviewers / merge request / handoff  
**Environment:** AWS account `717998086494` (ph-cdp-qa-galaxy), region `us-east-1`  
**Live URL (example):** `https://rt-04b81583dea14c6c8274d3c935118c98.ecs.us-east-1.on.aws`

---

## 1. Purpose

Report Test Buddy (Agentic Frontend Validations) is a web application that helps teams:

- Define and run **frontend / MicroStrategy report validation** scenarios
- Orchestrate **Playwright** runs against dashboards via headless Chromium
- Query **Snowflake** warehouses for SQL / data checks
- Store scenarios, runs, credentials, and results in **Supabase** (Postgres + Auth)

Auth and database stay on **Supabase Cloud**. Compute (UI + APIs + browser + Snowflake sidecar) runs on **AWS ECS Fargate** behind **ECS Express Mode** (HTTPS).

---

## 2. High-level architecture

```text
                         Internet (HTTPS)
                                |
                                v
              ECS Express shared Application Load Balancer
              (same ALB pattern as ops-monitor; host-based rules)
              Certificate: *.ecs.us-east-1.on.aws
                                |
              Host: rt-….ecs.us-east-1.on.aws
                                |
                                v
                    Target group → Fargate task (rtb:3)
                    2 vCPU / 8 GB · awsvpc
                                |
        +-----------------------+-----------------------+
        |                       |                       |
        v                       v                       v
   Main (web:80)          backend:8000           browserless:3000
   nginx + SPA            Deno edge functions    Chromium OSS
        |                       |
        |                       +-------> snowflake-sso:8002
        |                       |         (Python sidecar)
        |                       |
        +--- /functions/v1/* ---+
              (localhost proxy)

        Supabase Cloud <---- Auth / DB / Storage (HTTPS)
        Snowflake      <---- from sidecar / backend (egress IP allowlist)
        MicroStrategy  <---- from Browserless Chromium
```

### Design choices

| Choice | Why |
|--------|-----|
| One Fargate **task**, four containers | Same pattern as local Docker Compose; containers talk via `127.0.0.1` |
| ECS **Express Mode** | Auto HTTPS URL + ALB + cert (no manual HTTP listener) |
| Container named **`Main`** | Required by Express when using a custom task definition |
| Supabase Cloud (not self-hosted) | Auth/DB already in use; avoids running Postgres on ECS |
| Browserless from **GHCR** | Avoid pushing ~4 GB image through constrained CloudShell |
| Shared Express ALB with ops-monitor | Express host-based routing; expected, not a conflict |

---

## 3. Containers (runtime)

| Container | Image | Port | Role |
|-----------|--------|------|------|
| **Main** | `…/rtb-web:latest` | **80** | nginx serves React SPA; proxies `/functions/v1/*` → `127.0.0.1:8000`; `/healthz` → `ok` |
| **backend** | `…/rtb-backend:latest` | 8000 | Deno process hosting edge functions (`agent-orchestrate`, `playwright-runtime`, warehouse SQL, etc.) |
| **snowflake-sso** | `…/rtb-snowflake-sso:latest` | 8002 | Python FastAPI sidecar for Snowflake auth (password / key-pair / SSO-helpers) |
| **browserless** | `ghcr.io/browserless/chromium:v2.55.4` | 3000 | Headless Chromium for Playwright script execution |

Task definition family: **`rtb`** (revision **3** as of initial Express deploy).  
Cluster: **`default`**. Service name: **`rtb`** (Express gateway service).

### Backend environment (essentials)

- `BROWSERLESS_HOST=http://127.0.0.1:3000`
- `BROWSERLESS_OSS=true`
- `SNOWFLAKE_SSO_URL=http://127.0.0.1:8002`
- `LOCAL_FUNCTIONS_URL=http://127.0.0.1:8000/functions/v1`
- Secrets from Secrets Manager `rtb/prod`: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `BROWSERLESS_TOKEN`
- Browserless `TOKEN` must match `BROWSERLESS_TOKEN`

---

## 4. How the application functions

### 4.1 User login

1. User opens the Express HTTPS URL.
2. React app loads from **Main** (static assets).
3. Login uses **Supabase Auth** (browser → Supabase directly).
4. Session JWT is used when calling backend functions (Authorization / apikey headers).

Optional: add the Express URL under Supabase Auth → Site URL / Redirect URLs for email/magic-link flows.

### 4.2 UI → backend (edge functions)

1. For warehouse / orchestrate / playwright paths, the SPA calls **same-origin** `/functions/v1/<name>`.
2. nginx on **Main** proxies to Deno on **backend:8000**.
3. Backend loads handlers under `supabase/functions/*` via the Deno router (`backend/server.ts`).

Examples of functions:

- `agent-orchestrate` — run scenarios / workstreams  
- `playwright-runtime` — execute generated Playwright against Browserless  
- `run-warehouse-sql` / `test-warehouse-connectivity` — Snowflake via sidecar  

### 4.3 Playwright / MicroStrategy checks

1. Orchestrator asks `playwright-runtime` to run a script.
2. Backend calls Browserless OSS (`POST` to Chromium function API) with `BROWSERLESS_TOKEN`.
3. Chromium opens the dashboard URL (often MicroStrategy), applies credentials from app settings, captures results/screenshots.
4. Results are written back through Supabase APIs / DB as configured by the function.

**Note:** Browserless OSS is **headless**. Live headed streaming is not part of this deployment.

### 4.4 Snowflake

1. Warehouse connectors are stored in the app (Settings → Warehouses).
2. Connectivity/SQL goes: UI → backend → **snowflake-sso** sidecar → Snowflake.
3. On ECS, prefer **Password** or **key-pair (JWT)**.  
   **SSO (externalbrowser)** often fails in the cloud (no interactive browser on the task).
4. Snowflake **network policies** must allow the task’s egress IP (or a stable NAT EIP).  
   Password connectors that already allow the AWS egress range work; others may return “IP … is not allowed”.

### 4.5 Health and scaling

- ALB / Express health check path: **`/healthz`** (nginx returns `ok`).
- Express scaling (defaults observed): min 1 / max 20 tasks, CPU target ~60%.
- Logs: CloudWatch log group **`/ecs/rtb`** (streams: web, backend, snowflake-sso, browserless).

---

## 5. External dependencies

| System | Usage |
|--------|--------|
| **Supabase** | Auth, Postgres, some REST/storage |
| **Snowflake** | Warehouse SQL / connectivity tests |
| **MicroStrategy** (or other URLs) | Targets of Playwright validation |
| **GitHub Container Registry** | Browserless base image pull at task start |
| **Amazon ECR** | `rtb-web`, `rtb-backend`, `rtb-snowflake-sso` |
| **Secrets Manager** | `rtb/prod` |

---

## 6. Security notes

- Only port **80** on **Main** is exposed via the ALB (HTTPS terminated at ALB).
- Backend, Browserless, and Snowflake sidecar are **not** published on the internet; they listen on localhost inside the task.
- Service role / anon keys live in Secrets Manager, not in the git repo.
- Private keys pasted into the UI should be treated as secrets; rotate if exposed.
- Express may **share one ALB** with other Express apps (e.g. ops-monitor). Do not delete that ALB when cleaning unused **manual** resources (`rtb-alb`).

---

## 7. Local vs AWS

| Concern | Local (Compose / VDI) | AWS (this deploy) |
|---------|------------------------|-------------------|
| UI | `localhost:8080` | Express `https://rt-….on.aws` |
| nginx → backend | `backend:8000` (Docker DNS) | `127.0.0.1:8000` (`nginx.aws.conf`) |
| Snowflake SSO | Works with desktop browser | Prefer password / key-pair |
| Browserless | Compose service or script | Sidecar in same task |
| Corp proxy | Often required on VDI | Usually unset on ECS |

---

## 8. Related repo files

| File | Purpose |
|------|---------|
| `infra/ecs/task-definition.json` | Fargate task (Main + sidecars) |
| `nginx.aws.conf` | AWS nginx (localhost proxy + `/healthz`) |
| `Dockerfile` | Web image |
| `backend/Dockerfile` | Deno backend |
| `backend/snowflake-sso/Dockerfile` | Snowflake sidecar |
| `docs/DEPLOYMENT_GUIDE.md` | Build / push / Express deploy steps |
| `DEPLOY_ECS_EXPRESS.md` | Earlier Express notes (see Deployment Guide for the path that worked) |

---

## 9. Glossary

| Term | Meaning |
|------|---------|
| ECS Express Mode | Managed path that creates ALB, HTTPS cert, and `*.ecs.us-east-1.on.aws` URL |
| Task definition | Blueprint for the four containers (`rtb:N`) |
| Main | Public container Express routes to (must be named `Main` for custom TD) |
| ECR | Private image registry in AWS |
| Browserless | Headless Chrome service used by Playwright runtime |

# Deploy to AWS with Docker

This app ships as **three containers**:

| Container | Tech | Purpose |
|-----------|------|---------|
| `web`     | nginx + built Vite SPA | Serves the React frontend on `:80` |
| `backend` | Deno | Hosts all edge functions on `:8000` under `/functions/v1/<name>` |
| `browserless` | Browserless OSS (`ghcr.io/browserless/chromium`) | Self-hosted headless Chromium on `:3000`; runs Playwright scripts via `POST /chromium/function` |

The Postgres database + Auth still live in **Supabase** (managed cloud or
self-hosted). `backend` needs `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and
`SUPABASE_SERVICE_ROLE_KEY`, and is pre-wired to call Browserless OSS via
`BROWSERLESS_HOST=http://browserless:3000` and `BROWSERLESS_TOKEN` (see
`docker-compose.yml`).

> **Headed / live browser streaming** (`/live`, `/frame`, `/screenshot` iframe
> viewer) is **not** available in Browserless OSS. Use **headless** mode — scripts
> still execute and return base64 screenshots. Live debugging requires Browserless
> Enterprise or Cloud.

---

## 1. Build all three images

```bash
# Frontend
docker build \
  --build-arg VITE_SUPABASE_URL="https://YOUR-PROJECT.supabase.co" \
  --build-arg VITE_SUPABASE_PUBLISHABLE_KEY="<anon-key>" \
  --build-arg VITE_SUPABASE_PROJECT_ID="YOUR-PROJECT" \
  -t bi-tester-web:latest .

# Backend (edge functions)
docker build -f backend/Dockerfile -t bi-tester-backend:latest .

# Browserless OSS — pull the upstream image (no custom build)
docker pull ghcr.io/browserless/chromium:v2.55.4
```

Or run the whole thing locally with compose (fill in `.env` first):

```bash
cat > .env <<EOF
VITE_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<anon-key>
VITE_SUPABASE_PROJECT_ID=YOUR-PROJECT
SUPABASE_URL=https://YOUR-PROJECT.supabase.co
SUPABASE_ANON_KEY=<anon-key>
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
BROWSERLESS_HOST=http://browserless:3000
BROWSERLESS_TOKEN=local-dev-token
LOVABLE_API_KEY=<optional, only if using Lovable AI gateway>
EOF

docker compose up --build
# web:         http://localhost:8080
# backend:     http://localhost:8000/functions/v1/<name>
# browserless: http://localhost:3000/active  (health)
```

---

## 2. Push to Amazon ECR

```bash
AWS_REGION=us-east-1
ACCT=$(aws sts get-caller-identity --query Account --output text)
REG=$ACCT.dkr.ecr.$AWS_REGION.amazonaws.com

aws ecr create-repository --repository-name bi-tester-web        --region $AWS_REGION || true
aws ecr create-repository --repository-name bi-tester-backend    --region $AWS_REGION || true
aws ecr create-repository --repository-name browserless-chromium --region $AWS_REGION || true

aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $REG

for img in bi-tester-web bi-tester-backend; do
  docker tag  $img:latest $REG/$img:latest
  docker push             $REG/$img:latest
done

# Mirror Browserless OSS (or pull ghcr.io/browserless/chromium directly in ECS)
docker tag ghcr.io/browserless/chromium:v2.55.4 $REG/browserless-chromium:v2.55.4
docker push $REG/browserless-chromium:v2.55.4
```

---

## 3. Deploy to AWS — pick ONE

### Option A — App Runner (simplest, three services)

For **each** image, in AWS Console → App Runner → Create service:
- Source: ECR → pick the image
- Port: `80` for web, `8000` for backend, `3000` for browserless
- Health check: `/healthz` for web/backend; `/active` for browserless (expects 204)
- For `backend`: add env vars `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`, `LOVABLE_API_KEY`, `BROWSERLESS_HOST`,
  and `BROWSERLESS_TOKEN` (mark secrets appropriately)
- For `browserless`: set `TOKEN`, `CONCURRENT`, `QUEUED`, `TIMEOUT`, and
  `shm_size: 2g` equivalent (Fargate task ephemeral storage / shared memory)

After backend deploys, App Runner gives it an HTTPS URL like
`https://abc123.us-east-1.awsapprunner.com`. Rebuild the **web** image with
that URL as `VITE_FUNCTIONS_BASE_URL` (or front both behind one CloudFront — see
Option C) so the frontend calls your backend instead of Supabase Functions.

### Option B — ECS Fargate (one cluster, three services)

1. Create one task definition per image; backend task gets the env vars above.
2. Create three services in the same cluster; web and browserless sit behind ALB target groups, backend can be internal or ALB-backed.
3. Single ALB with listener rules:
   - `Host = app.example.com` → web target group
   - `Path = /functions/v1/*` → backend target group
4. Browserless stays **internal** — only the backend calls it on the Docker network / service discovery.

### Option C — Single CloudFront in front of both (recommended for prod)

```text
                 CloudFront
                 /        \
        path=/*           path=/functions/v1/*
           |                       |
          web (App Runner)       backend (App Runner)
                                       |
                                  browserless (internal)
```

Then the frontend can keep calling same-origin `/functions/v1/<name>` and you
don't need to rebuild it when backend URL changes.

---

## 4. Point the frontend at YOUR backend

The Supabase JS client uses `VITE_SUPABASE_URL` for both database **and**
function calls. Two options:

- **Easy**: keep `VITE_SUPABASE_URL` pointed at Supabase (DB), and replace
  `supabase.functions.invoke(name, ...)` callsites with a fetch helper that
  hits your backend URL. Search for `functions.invoke(` — there are ~10
  callsites in `src/`.
- **Cleanest**: put both behind a CloudFront (Option C) so `/functions/v1/*`
  routes to your backend and the rest to Supabase REST/Auth — no code change.

---

## 5. Updating

```bash
docker build ... -t bi-tester-web:latest .
docker build -f backend/Dockerfile -t bi-tester-backend:latest .
docker push  $REG/bi-tester-web:latest
docker push  $REG/bi-tester-backend:latest
docker pull ghcr.io/browserless/chromium:v2.55.4
docker tag ghcr.io/browserless/chromium:v2.55.4 $REG/browserless-chromium:v2.55.4
docker push $REG/browserless-chromium:v2.55.4
# App Runner auto-redeploys; ECS:
aws ecs update-service --force-new-deployment --service web         --cluster bi-tester
aws ecs update-service --force-new-deployment --service backend     --cluster bi-tester
aws ecs update-service --force-new-deployment --service browserless --cluster bi-tester
```

---

## Notes & caveats

- **Service role key** is a server-only secret. Set it as an App Runner
  secret env var or ECS Secrets Manager reference — never bake it into an
  image.
- The backend container loads all edge functions into one Deno process
  using a small router (`backend/server.ts`) that intercepts `Deno.serve`.
  Cold start ~1s; per-function memory is shared.
- `playwright-runtime` delegates to **Browserless OSS** via
  `BROWSERLESS_HOST` + `BROWSERLESS_TOKEN`. Do not leave these empty in AWS,
  or script runs will return 503.
- **No headed/live mode on OSS** — the UI "Run headed (live)" button returns
  a clear error. Headless runs work and return screenshots from `/chromium/function`.
- Always set **`shm_size: 2g`** on the browserless container — Docker defaults
  to 64 MB shared memory and Chrome crashes under load.
- For full DB/auth self-hosting on AWS, see Supabase's official
  `supabase/docker` compose stack and run it on ECS or an EC2 host with
  RDS Postgres.

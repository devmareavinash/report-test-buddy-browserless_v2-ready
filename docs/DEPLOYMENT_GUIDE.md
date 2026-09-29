# Report Test Buddy — Deployment Guide

**Audience:** operators deploying or redeploying on AWS  
**Account:** `717998086494` · **Region:** `us-east-1`  
**Pattern:** Build images → ECR → Task definition `rtb` → **ECS Express** (custom task definition via CloudShell)

This is the path that was used successfully. Manual ALB `rtb-alb` + HTTP:80 is **not** required and was removed after go-live.

---

## 0. Prerequisites

- AWS Console access (ECS, ECR, IAM read, Secrets Manager, CloudShell)
- Docker on VDI (to build images)
- Supabase project URL + anon + service role keys
- VPC with two **public** subnets (example used):
  - `vpc-092837c590627a97e`
  - `subnet-0cbfdb847f5a4d71c`, `subnet-053a7ff726e70f1ce`
- IAM role (shared with ops-monitor Express):  
  `arn:aws:iam::717998086494:role/service-role/ecsInfrastructureRoleForExpressServices`  
  (note the **`service-role/`** path in the ARN)
- Task execution role: `ecsTaskExecutionRole` (ECR pull + Secrets Manager + CloudWatch Logs)

---

## 1. Build images (VDI)

From the project root, with `.env` loaded (`VITE_SUPABASE_*`):

```powershell
# Web must use AWS nginx (proxy to 127.0.0.1:8000)
Copy-Item nginx.aws.conf nginx.conf -Force   # optional if you pass NGINX_CONF

docker build `
  --build-arg VITE_SUPABASE_URL="$env:VITE_SUPABASE_URL" `
  --build-arg VITE_SUPABASE_PUBLISHABLE_KEY="$env:VITE_SUPABASE_PUBLISHABLE_KEY" `
  --build-arg VITE_SUPABASE_PROJECT_ID="$env:VITE_SUPABASE_PROJECT_ID" `
  --build-arg VITE_USE_LOCAL_BACKEND=true `
  --build-arg NGINX_CONF=nginx.aws.conf `
  -t rtb-web:latest .

docker compose build backend snowflake-sso
docker tag reporttestbuddybrwserless-backend:latest rtb-backend:latest
docker tag reporttestbuddybrwserless-snowflake-sso:latest rtb-snowflake-sso:latest
```

Browserless is **not** pushed to ECR; the task pulls:

`ghcr.io/browserless/chromium:v2.55.4`

### Optimize for CloudShell (~1 GB home)

Create compressed archives of the three small images only:

| File | Approx size |
|------|-------------|
| `rtb-web.tar.gz` | ~21 MB |
| `rtb-backend.tar.gz` | ~54 MB |
| `rtb-snowflake-sso.tar.gz` | ~86 MB |

Example location used: `%USERPROFILE%\Downloads\rtb-ecr-push\`

---

## 2. Push images to ECR (CloudShell upload — no S3)

### 2.1 Create repos + login

```bash
ACCOUNT=717998086494
REGION=us-east-1
for name in rtb-web rtb-backend rtb-snowflake-sso; do
  aws ecr create-repository --repository-name "$name" --region "$REGION" 2>/dev/null || true
done
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
```

### 2.2 One image at a time (Actions → Upload file)

**Web**

```bash
ACCOUNT=717998086494; REGION=us-east-1
gunzip -c rtb-web.tar.gz | docker load
docker tag rtb-web:latest $ACCOUNT.dkr.ecr.$REGION.amazonaws.com/rtb-web:latest
docker push $ACCOUNT.dkr.ecr.$REGION.amazonaws.com/rtb-web:latest
docker rmi rtb-web:latest $ACCOUNT.dkr.ecr.$REGION.amazonaws.com/rtb-web:latest
rm -f rtb-web.tar.gz
```

Repeat for `rtb-backend` and `rtb-snowflake-sso`.

### 2.3 Verify

ECR → each of `rtb-web`, `rtb-backend`, `rtb-snowflake-sso` shows tag **`latest`**.

---

## 3. Secrets Manager

Secret name: **`rtb/prod`** (reuse if already present)

| Key | Purpose |
|-----|---------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_ANON_KEY` | Anon / publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key |
| `BROWSERLESS_TOKEN` | Shared token with Browserless `TOKEN` env |

Ensure `ecsTaskExecutionRole` can `GetSecretValue` on this secret.

---

## 4. Log group

```bash
aws logs create-log-group --log-group-name /ecs/rtb --region us-east-1 2>/dev/null || true
```

---

## 5. Task definition

File: `infra/ecs/task-definition.json`

Requirements for Express + custom task definition:

- Fargate compatible
- Public container named **`Main`** (not `web`)
- Port mapping on Main includes **`containerPort`** and **`name`** (e.g. `"http"`)
- Do **not** set `linuxParameters.sharedMemorySize` on Fargate (unsupported)
- Use Chrome flag `--disable-dev-shm-usage` for Browserless instead
- Browserless `TOKEN` = same value as secret `BROWSERLESS_TOKEN`

Register / revise in Console:

1. ECS → Task definitions → **`rtb`** → Create new revision → JSON  
2. Paste file contents → Create  
3. Confirm revision (e.g. **`rtb:3`**)

---

## 6. Create Express service (CloudShell)

The Express **console** form is single-image only. Use CLI with the custom task definition:

```bash
aws ecs create-express-gateway-service \
  --service-name rtb \
  --infrastructure-role-arn arn:aws:iam::717998086494:role/service-role/ecsInfrastructureRoleForExpressServices \
  --task-definition-arn arn:aws:ecs:us-east-1:717998086494:task-definition/rtb:3 \
  --health-check-path /healthz \
  --network-configuration "subnets=subnet-0cbfdb847f5a4d71c,subnet-053a7ff726e70f1ce" \
  --region us-east-1
```

### Important ARN note

Wrong (fails assume-role):

`arn:aws:iam::717998086494:role/ecsInfrastructureRoleForExpressServices`

Correct (ops-monitor / console-created role):

`arn:aws:iam::717998086494:role/service-role/ecsInfrastructureRoleForExpressServices`

### Success payload includes

- `serviceName`: `rtb`
- `cluster`: typically `default`
- `ingressPaths[].endpoint`:  
  `https://rt-<id>.ecs.us-east-1.on.aws`

---

## 7. Verify

```text
https://rt-<id>.ecs.us-east-1.on.aws/healthz   →  ok
https://rt-<id>.ecs.us-east-1.on.aws/          →  app UI
```

If **503** briefly: wait for target health. Check:

```bash
aws ecs describe-services --cluster default --services rtb --region us-east-1
aws elbv2 describe-target-health --target-group-arn <tg-arn> --region us-east-1
```

Logs: CloudWatch → `/ecs/rtb`.

---

## 8. Post-deploy configuration

1. **Supabase Auth (optional but recommended)**  
   Add Express URL to Site URL / Redirect URLs.
2. **Snowflake**  
   Prefer **Password** or **key-pair** on ECS.  
   If “IP not allowed”, allowlist task egress IP (or NAT EIP) in Snowflake network policy.
3. **Do not** reuse ops-monitor’s `op-….on.aws` hostname for RTB; RTB has its own `rt-….on.aws` host on the shared Express ALB.

---

## 9. Redeploy (new image)

1. Rebuild and push updated image(s) to ECR (`:latest`).
2. Register a new task definition revision if JSON changed (or force new deployment with same TD if only image digest changed — prefer new revision or `update-service` / Express update).
3. Update Express service to the new task definition revision (Console service deploy, or Express update API/CLI as available).

Minimal image-only bump often:

```bash
# After push of new :latest layers, force new deployment of the ECS service
aws ecs update-service --cluster default --service rtb --force-new-deployment --region us-east-1
```

(Confirm service name/cluster if Express naming differs in your account.)

---

## 10. Cleanup of unused test resources

Safe to delete after Express URL works:

| Resource | Action |
|----------|--------|
| Load balancer **`rtb-alb`** | Delete (manual test ALB) |
| Target group **`rtb-web`** | Delete if unused |

**Do not delete:**

- Shared Express ALB / `ecs-gateway-tg-*` (serves RTB and possibly ops-monitor)
- ECR repos `rtb-*`
- Secret `rtb/prod`
- Task definition family `rtb`
- Express service `rtb`

---

## 11. Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Express console only asks for Image URI | Single-container UI | Use CloudShell `create-express-gateway-service` + custom TD |
| `Cannot assume role` infrastructure role | Wrong ARN (missing `service-role/`) | Use full ARN from `aws iam get-role` |
| `sharedMemorySize` rejected | Fargate limit | Remove shm; use `--disable-dev-shm-usage` |
| 503 on URL | Targets not healthy yet / crash | Check tasks, TG health, `/ecs/rtb` logs |
| Snowflake IP not allowed | Network policy | Allowlist egress IP or use password account already allowed |
| Snowflake SSO EOF | No browser on ECS | Use password or key-pair |
| Functions 502 | Backend down / wrong nginx | Confirm `nginx.aws.conf` and backend essential container |

---

## 12. Checklist (print / MR)

- [ ] `rtb-web` built with `nginx.aws.conf`
- [ ] `rtb-web`, `rtb-backend`, `rtb-snowflake-sso` in ECR `:latest`
- [ ] Secret `rtb/prod` complete; Browserless TOKEN matches
- [ ] Task definition with container **`Main`**, health `/healthz`
- [ ] Express created via CLI with **service-role/** infrastructure ARN
- [ ] `/healthz` → `ok`; UI loads
- [ ] Password Snowflake test OK (or IP allowlisted for key-pair)
- [ ] Old `rtb-alb` / unused `rtb-web` TG removed
- [ ] Architecture doc reviewed: `docs/ARCHITECTURE_AND_FUNCTIONING.md`

---

## 13. Reference commands

```bash
# Describe Express service / URL
aws ecs describe-express-gateway-service --service-arn \
  arn:aws:ecs:us-east-1:717998086494:service/default/rtb \
  --region us-east-1
# (API shape may vary; alternatively use Console → Clusters → default → rtb → Resources)
```

Live application URL (initial deploy):

`https://rt-04b81583dea14c6c8274d3c935118c98.ecs.us-east-1.on.aws`

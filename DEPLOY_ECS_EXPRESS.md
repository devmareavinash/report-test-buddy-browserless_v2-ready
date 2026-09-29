================================================================================
Report Test Buddy — ECS Express Mode (beginner guide)
================================================================================
NOTE: For MR / handoff, prefer the polished docs:
  - docs/ARCHITECTURE_AND_FUNCTIONING.md
  - docs/DEPLOYMENT_GUIDE.md  (path that actually worked in production)
================================================================================
Region:  us-east-1
Account: 717998086494 (ph-cdp-qa-galaxy)

Unlike ops-monitor (1 container), RTB runs **4 containers in one task**.
ECS Express still gives you HTTPS + public URL automatically when you use a
**custom task definition** (supported in Express Mode).

================================================================================
1. BIG PICTURE
================================================================================

  Build 4 images on VDI (done)
          |
          v
  Push to Amazon ECR  (rtb-web, rtb-backend, rtb-snowflake-sso, rtb-browserless)
          |
          v
  Register task definition "rtb"  (4 containers, localhost networking)
          |
          v
  ECS Express Mode + that task definition
          |
          v
  Open https://op-<NEW-ID>.ecs.us-east-1.on.aws   ← YOUR RTB URL (not ops-monitor)

  Internet → Express HTTPS :443 → web:80
                                   ├─ backend:8000        (127.0.0.1)
                                   ├─ snowflake-sso:8002
                                   └─ browserless:3000

ops-monitor URL (leave alone):
  https://op-e533f17df829450e90783c93f3eded04.ecs.us-east-1.on.aws

================================================================================
2. IMAGES (already built on this VDI)
================================================================================

| Local image              | ECR target                                              |
|--------------------------|---------------------------------------------------------|
| rtb-web:latest           | …/rtb-web:latest                                        |
| rtb-backend:latest       | …/rtb-backend:latest                                    |
| rtb-snowflake-sso:latest | …/rtb-snowflake-sso:latest                              |
| rtb-browserless:v2.55.4  | …/rtb-browserless:v2.55.4                               |

web nginx proxies /functions/v1/* → http://127.0.0.1:8000 (AWS config).
Health: GET /healthz → ok

================================================================================
3. SECRETS (one time — Console)
================================================================================

Secrets Manager → Store a new secret → Other type of secret → Plaintext / key-value:

  SUPABASE_URL
  SUPABASE_ANON_KEY
  SUPABASE_SERVICE_ROLE_KEY
  BROWSERLESS_TOKEN     ← long random string, e.g. rtb-prod-token-XXXX

Secret name:  rtb/prod
Region:       us-east-1

After create, open the secret → copy full ARN.
Edit infra/ecs/task-definition.json if the ARN suffix differs from:
  arn:aws:secretsmanager:us-east-1:717998086494:secret:rtb/prod:KEY::

Also set browserless env TOKEN in the task definition to the SAME value as
BROWSERLESS_TOKEN (Express/secrets JSON key cannot always feed TOKEN for that image).

================================================================================
4. PUSH IMAGES TO ECR
================================================================================

VDI docker login to ECR often fails (corp proxy). Prefer **CloudShell** or
**CodeBuild**. If CloudShell has enough disk (~6+ GB free):

--- 4A. CloudShell: login + create repos ---

  ACCOUNT=717998086494
  REGION=us-east-1

  for name in rtb-web rtb-backend rtb-snowflake-sso rtb-browserless; do
    aws ecr create-repository --repository-name "$name" --region "$REGION" 2>/dev/null || true
  done

  aws ecr get-login-password --region "$REGION" \
    | docker login --username AWS --password-stdin \
      "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"

--- 4B. Get images into CloudShell ---

Option 1 — CodeBuild from GitHub/S3 (best for large browserless image):
  Use existing buildspec.yml (privileged) → pushes all rtb-* tags.

Option 2 — If small images only fit in CloudShell, upload web/backend/sso tars
  via S3, then:

  aws s3 cp s3://YOUR-BUCKET/rtb-web.tar .
  docker load -i rtb-web.tar
  docker tag rtb-web:latest $ACCOUNT.dkr.ecr.$REGION.amazonaws.com/rtb-web:latest
  docker push $ACCOUNT.dkr.ecr.$REGION.amazonaws.com/rtb-web:latest
  # repeat for backend, snowflake-sso, browserless

Confirm in Console: ECR → each rtb-* repo has tag latest (or v2.55.4 for browserless).

================================================================================
5. REGISTER TASK DEFINITION
================================================================================

File in repo:  infra/ecs/task-definition.json

CloudShell (after uploading that JSON or cloning repo):

  aws logs create-log-group --log-group-name /ecs/rtb --region us-east-1 2>/dev/null || true

  # Ensure ecsTaskExecutionRole can pull ECR + read Secrets Manager
  # (AmazonECSTaskExecutionRolePolicy + secretsmanager:GetSecretValue on rtb/prod)

  aws ecs register-task-definition \
    --cli-input-json file://infra/ecs/task-definition.json \
    --region us-east-1

Or Console: ECS → Task definitions → Create → JSON → paste file → Create.

Important settings already in the file:
  CPU 2 vCPU / Memory 8 GB
  web port 80, health /healthz
  backend → BROWSERLESS_HOST=http://127.0.0.1:3000
  browserless linuxParameters.sharedMemorySize = 2048

Replace BROWSERLESS TOKEN placeholder with your real token before register.

================================================================================
6. CREATE ECS EXPRESS SERVICE
================================================================================

6.1 Console → Elastic Container Service → Express mode → Create

6.2 Instead of “single image only”, choose **custom task definition** (if shown):
      Family:  rtb
      Revision: latest

    If Express only asks for one image (older UI):
      Image:   717998086494.dkr.ecr.us-east-1.amazonaws.com/rtb-web:latest
      Port:    80
      Health:  /healthz
      Then immediately edit the service to use task definition family "rtb"
      (Express now supports custom task definitions — prefer that path).

6.3 Roles
  Task execution role  → Create / use ecsTaskExecutionRole
  Infrastructure role  → Create new (Express offers this)

6.4 Additional configuration
  Name:               rtb   (or report-test-buddy)
  Container port:     80          ← web (ALB target)
  Health check path:  /healthz
  CPU / Memory:       match task def (2 vCPU / 8 GB) when using custom TD
  Networking:         VPC vpc-092837c590627a97e
                      Subnets: subnet-0cbfdb847f5a4d71c , subnet-053a7ff726e70f1ce
                      (same public subnets as ops-monitor)

6.5 Environment / secrets
  Prefer secrets from rtb/prod via the task definition (already wired).
  Do NOT set Value type = Secret and paste the raw API key string
  (ECS will treat it as an SSM parameter name — same ops-monitor pitfall).

6.6 Create → wait until Tasks = 1 Running

6.7 Open Application URL
  https://op-<NEW-ID>.ecs.us-east-1.on.aws
  Health:  https://op-<NEW-ID>.ecs.us-east-1.on.aws/healthz   → ok

  Add that URL in Supabase Auth → Site URL / Redirect URLs.

================================================================================
7. AFTER DEPLOY — SNOWFLAKE
================================================================================

ECS has no interactive browser. Prefer **Password** or **key-pair** in Settings.
SSO (externalbrowser) often fails with "EOF when reading a line".

================================================================================
8. DELETE OLD TEST-BUDDY INFRA (only after Express URL works)
================================================================================

Do this ONLY after:
  [ ] Express task Running
  [ ] /healthz returns ok
  [ ] You can log in and open the UI on the NEW Express URL

Delete in this order (EC2 / ECS Console or CloudShell):

8.1 ECS (classic) leftovers
  - Cluster "rtb" → any non-Express Service → Update desired count 0 → Delete service
  - Stop leftover tasks
  - (Keep cluster if Express uses it; delete empty cluster only if unused)

8.2 Load balancer (manual test ALB)
  - EC2 → Load Balancers → rtb-alb → Delete
  - Target Groups → rtb-web (and any rtb-*) → Delete
  - Do NOT delete the ALB that Express created for the new service
    (name will look different / managed by Express)

8.3 Security groups (optional cleanup)
  - Delete SGs you created only for rtb-alb / old ECS service
  - Do NOT delete VPC default SG or Express-managed SGs still in use
  - Do NOT delete ops-monitor security groups

8.4 Keep
  - ECR repos rtb-*          (needed by Express)
  - Secret rtb/prod
  - Task definition family rtb
  - ops-monitor Express service + its URL/cert

CloudShell examples:

  # List ALBs — delete only the manual test one
  aws elbv2 describe-load-balancers --region us-east-1 \
    --query "LoadBalancers[].{Name:LoadBalancerName,Arn:LoadBalancerArn,DNS:DNSName}"

  aws elbv2 delete-load-balancer --load-balancer-arn ARN_OF_rtb-alb --region us-east-1
  # wait ~30s
  aws elbv2 delete-target-group --target-group-arn ARN_OF_rtb-web --region us-east-1

================================================================================
9. NEXT TIME CHECKLIST
================================================================================

[ ] docker images show fresh rtb-web / rtb-backend / rtb-snowflake-sso
[ ] Images pushed to ECR (all 4)
[ ] Secret rtb/prod exists; TOKEN matches browserless
[ ] Task definition registered (sharedMemorySize 2048)
[ ] Express Create → custom task def rtb → port 80 → /healthz
[ ] New https://op-….on.aws/healthz → ok
[ ] Supabase redirect URLs updated
[ ] Snowflake Password or key-pair
[ ] Delete old rtb-alb + old target group (not Express resources)

================================================================================
10. SIMPLE GLOSSARY
================================================================================

ECS Express     = easy deploy; AWS creates ALB + HTTPS URL for you
Custom task def = your 4-container JSON (web+backend+sso+browserless)
ECR             = image storage
/healthz        = RTB web health (ops-monitor uses /api/health)
op-….on.aws     = Express HTTPS hostname (one per Express service)

================================================================================
END
================================================================================

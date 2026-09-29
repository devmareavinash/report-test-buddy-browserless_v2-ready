# AWS reference deployment

This app is **cloud-agnostic** but ships with a reference AWS-native deployment
target. All business logic talks to thin adapters (`src/lib/platform/`,
`supabase/functions/_shared/platform/`) so the same code can run against either
Lovable Cloud (Supabase Postgres + Edge Functions) **or** AWS-native services.

## Service mapping

| Concern              | Lovable Cloud (preview)  | AWS production               |
|----------------------|--------------------------|------------------------------|
| Frontend hosting     | Lovable preview          | **S3 + CloudFront**          |
| API / agents         | Supabase Edge Functions  | **Lambda** (Node 20) + API Gateway HTTP API |
| Long-running jobs    | Edge Function timeouts   | **ECS Fargate** worker tasks |
| Playwright runtime   | Hosted Browserless/Browserbase via `browser_runtime` | **Fargate** task with Playwright + Chromium + noVNC behind ALB |
| Database             | Supabase Postgres        | **Aurora Postgres Serverless v2** (same SQL schema) |
| Auth                 | Supabase Auth            | **Cognito User Pools**       |
| Object storage       | Supabase Storage `artifacts` bucket | **S3** bucket `bi-test-artifacts` |
| Secrets              | Supabase Vault / env     | **AWS Secrets Manager**      |
| Schedules            | pg_cron + edge function  | **EventBridge** rules → Lambda |
| Async queue          | Inline edge calls        | **SQS** (orchestrator → playwright workers) |
| External trigger API | `trigger-run` edge fn    | API Gateway → Lambda         |
| LLM                  | Lovable AI Gateway       | **Bedrock** (Anthropic / Mistral) or any provider via `llm_providers.kind=custom_wrapper` |
| Observability        | Supabase logs            | CloudWatch Logs/Metrics + X-Ray |

## Switching providers

The frontend reads `VITE_PLATFORM_PROVIDER` (`supabase` | `aws`). Server-side
functions read `PLATFORM_PROVIDER`. Adapter factories pick the right
implementation; nothing in `src/pages/**` or business code changes.

## Terraform skeleton

Modules under `infra/terraform/`:

```
infra/terraform/
  main.tf
  variables.tf
  modules/
    network/        # VPC, subnets, NAT
    rds/            # Aurora Postgres Serverless v2 + parameter group
    cognito/        # User pool, app client, hosted UI
    s3-artifacts/   # bi-test-artifacts bucket + lifecycle
    lambda-orchestrator/   # packages supabase/functions/agent-* as Lambdas
    fargate-playwright/    # Playwright + noVNC task, ALB, target group
    eventbridge/    # scheduled rules per workstream/report
    sqs/            # job queue + DLQ
    secretsmanager/ # LLM keys, warehouse creds, browser endpoint creds
```

Apply order: `network → rds → cognito → s3 → secretsmanager → sqs → lambda → fargate → eventbridge`.

## Environment variables (Lambda runtime)

```
PLATFORM_PROVIDER=aws
DATABASE_URL=postgres://…@aurora-cluster:5432/biqa
AWS_REGION=us-east-1
ARTIFACTS_BUCKET=bi-test-artifacts
PLAYWRIGHT_RUNTIME_URL=https://playwright.<your-domain>
LLM_DEFAULT_PROVIDER=bedrock         # or openai / anthropic / custom_wrapper
SECRETS_PREFIX=biqa/                 # AWS Secrets Manager prefix
```

## Notes

- The Playwright Fargate task should expose:
  - `POST /run` — accepts `{mode, code, scenario_id}`, runs the script.
  - In headed mode, returns `{live_url}` pointing at the noVNC viewer (ALB path
    `/vnc/<jobId>`); the UI iframes that URL on the Scenario detail page.
  - In headless mode, returns `{extracted, screenshot_url, dom_snapshot_url}`
    with S3 URLs already uploaded.
- LLM provider configuration lives in the database (`llm_providers` table),
  so switching from AI Gateway → Bedrock → custom corporate wrapper is a UI
  action, not a redeploy.

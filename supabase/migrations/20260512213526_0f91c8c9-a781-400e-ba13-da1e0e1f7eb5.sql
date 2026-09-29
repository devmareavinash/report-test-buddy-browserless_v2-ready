
-- Workstreams & Brands
CREATE TABLE public.workstreams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.brands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workstream_id UUID NOT NULL REFERENCES public.workstreams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- LLM providers and per-agent config
CREATE TABLE public.llm_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  base_url TEXT,
  model_default TEXT,
  api_key_secret_ref TEXT,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.agent_model_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_key TEXT NOT NULL UNIQUE,
  llm_provider_id UUID REFERENCES public.llm_providers(id) ON DELETE SET NULL,
  model TEXT,
  temperature NUMERIC DEFAULT 0.2
);

-- Warehouse connectors
CREATE TABLE public.warehouse_connectors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  host TEXT,
  port INT,
  account TEXT,
  database TEXT,
  schema TEXT,
  warehouse TEXT,
  role TEXT,
  http_path TEXT,
  auth_method TEXT,
  username TEXT,
  password_secret_ref TEXT,
  token_secret_ref TEXT,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Credential profiles for report logins
CREATE TABLE public.credential_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  login_url TEXT,
  username TEXT,
  password_secret_ref TEXT,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Browser runtime
CREATE TABLE public.browser_runtime (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  ws_endpoint_secret_ref TEXT,
  provider TEXT,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Reports
CREATE TABLE public.reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id UUID NOT NULL REFERENCES public.brands(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  reference_url TEXT,
  credential_profile_id UUID REFERENCES public.credential_profiles(id) ON DELETE SET NULL,
  warehouse_connector_id UUID REFERENCES public.warehouse_connectors(id) ON DELETE SET NULL,
  kpi_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  schedule_cron TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Scenarios
CREATE TABLE public.scenarios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id UUID NOT NULL REFERENCES public.reports(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  type TEXT,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- SQL templates
CREATE TABLE public.sql_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope TEXT NOT NULL DEFAULT 'project',
  report_id UUID REFERENCES public.reports(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sql_text TEXT NOT NULL,
  parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
  tags TEXT[] DEFAULT ARRAY[]::TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Scripts
CREATE TABLE public.scripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id UUID NOT NULL REFERENCES public.scenarios(id) ON DELETE CASCADE,
  assertion_spec JSONB NOT NULL DEFAULT '{}'::jsonb,
  playwright_code TEXT,
  sql_template_id UUID REFERENCES public.sql_templates(id) ON DELETE SET NULL,
  sql_filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  debug_status TEXT DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.warehouse_mock (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name TEXT NOT NULL,
  row JSONB NOT NULL
);

-- Runs
CREATE TABLE public.runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type TEXT NOT NULL,
  scope_id UUID,
  trigger_source TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'pending',
  started_at TIMESTAMPTZ DEFAULT now(),
  finished_at TIMESTAMPTZ,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE public.test_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES public.runs(id) ON DELETE CASCADE,
  scenario_id UUID REFERENCES public.scenarios(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  expected JSONB,
  actual JSONB,
  diff JSONB,
  screenshot_url TEXT,
  dom_snapshot_url TEXT,
  analysis TEXT,
  severity TEXT,
  rank_score NUMERIC DEFAULT 0,
  healing_proposal JSONB,
  healing_status TEXT DEFAULT 'none',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.operator_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_result_id UUID REFERENCES public.test_results(id) ON DELETE CASCADE,
  scenario_id UUID REFERENCES public.scenarios(id) ON DELETE SET NULL,
  note_type TEXT NOT NULL,
  body TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.note_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id UUID REFERENCES public.scenarios(id) ON DELETE CASCADE,
  signature TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT,
  weight NUMERIC NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.api_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  scopes JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type TEXT NOT NULL,
  scope_id UUID,
  cron TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS and open policies (single-workspace MVP, no auth)
DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'workstreams','brands','llm_providers','agent_model_config','warehouse_connectors',
    'credential_profiles','browser_runtime','reports','scenarios','sql_templates',
    'scripts','warehouse_mock','runs','test_results','operator_notes','note_memory',
    'api_tokens','schedules'
  ])
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "public_all_%s" ON public.%I FOR ALL USING (true) WITH CHECK (true)', t, t);
  END LOOP;
END$$;

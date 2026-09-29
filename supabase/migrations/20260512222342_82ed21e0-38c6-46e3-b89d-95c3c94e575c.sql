-- 1. reports: add workstream_id, backfill, allow brand_id null
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS workstream_id uuid;
UPDATE public.reports r SET workstream_id = b.workstream_id
  FROM public.brands b WHERE r.brand_id = b.id AND r.workstream_id IS NULL;
-- if any reports still lack a workstream, attach to first workstream (or create one)
DO $$
DECLARE wsid uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM public.reports WHERE workstream_id IS NULL) THEN
    SELECT id INTO wsid FROM public.workstreams ORDER BY created_at LIMIT 1;
    IF wsid IS NULL THEN
      INSERT INTO public.workstreams(name) VALUES ('Default') RETURNING id INTO wsid;
    END IF;
    UPDATE public.reports SET workstream_id = wsid WHERE workstream_id IS NULL;
  END IF;
END $$;
ALTER TABLE public.reports ALTER COLUMN workstream_id SET NOT NULL;
ALTER TABLE public.reports ALTER COLUMN brand_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reports_workstream ON public.reports(workstream_id);

-- 2. scenarios: deferred / criticality / prerun_id
ALTER TABLE public.scenarios
  ADD COLUMN IF NOT EXISTS deferred boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS criticality text NOT NULL DEFAULT 'medium',
  ADD COLUMN IF NOT EXISTS prerun_id uuid;

-- 3. prerun_scripts
CREATE TABLE IF NOT EXISTS public.prerun_scripts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL,
  name text NOT NULL,
  playwright_code text,
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.prerun_scripts ENABLE ROW LEVEL SECURITY;
CREATE POLICY public_all_prerun_scripts ON public.prerun_scripts FOR ALL USING (true) WITH CHECK (true);

-- 4. scenario_filter_matrix
CREATE TABLE IF NOT EXISTS public.scenario_filter_matrix (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id uuid NOT NULL,
  label text,
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.scenario_filter_matrix ENABLE ROW LEVEL SECURITY;
CREATE POLICY public_all_filter_matrix ON public.scenario_filter_matrix FOR ALL USING (true) WITH CHECK (true);

-- 5. llm_providers: payload template
ALTER TABLE public.llm_providers
  ADD COLUMN IF NOT EXISTS wrapper_payload_template text;

-- 6. agent_model_config: system_instruction
ALTER TABLE public.agent_model_config
  ADD COLUMN IF NOT EXISTS system_instruction text;

-- 7. test_results: criticality
ALTER TABLE public.test_results
  ADD COLUMN IF NOT EXISTS criticality text;

-- 8. playwright_jobs
CREATE TABLE IF NOT EXISTS public.playwright_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id uuid,
  prerun_id uuid,
  mode text NOT NULL DEFAULT 'headless',
  status text NOT NULL DEFAULT 'pending',
  live_url text,
  last_event jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
ALTER TABLE public.playwright_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY public_all_playwright_jobs ON public.playwright_jobs FOR ALL USING (true) WITH CHECK (true);

-- 9. artifacts bucket
INSERT INTO storage.buckets (id, name, public) VALUES ('artifacts','artifacts', true)
  ON CONFLICT (id) DO NOTHING;
CREATE POLICY "artifacts_public_read" ON storage.objects FOR SELECT USING (bucket_id = 'artifacts');
CREATE POLICY "artifacts_anyone_write" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'artifacts');
CREATE POLICY "artifacts_anyone_update" ON storage.objects FOR UPDATE USING (bucket_id = 'artifacts');
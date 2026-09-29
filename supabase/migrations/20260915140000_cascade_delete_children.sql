-- Ensure deleting a workstream / screen / scenario drops inner rows (no orphans).
-- Polymorphic runs.scope_id and schedules.scope_id stay app-managed (no FK).

-- Orphans from older tables that lacked FKs
DELETE FROM public.scenario_filter_matrix m
WHERE NOT EXISTS (SELECT 1 FROM public.scenarios s WHERE s.id = m.scenario_id);

DELETE FROM public.prerun_scripts p
WHERE NOT EXISTS (SELECT 1 FROM public.reports r WHERE r.id = p.report_id);

DELETE FROM public.scenario_versions v
WHERE NOT EXISTS (SELECT 1 FROM public.scenarios s WHERE s.id = v.scenario_id);

DELETE FROM public.script_versions v
WHERE NOT EXISTS (SELECT 1 FROM public.scripts s WHERE s.id = v.script_id);

DELETE FROM public.script_versions v
WHERE NOT EXISTS (SELECT 1 FROM public.scenarios s WHERE s.id = v.scenario_id);

UPDATE public.playwright_jobs j
SET scenario_id = NULL
WHERE j.scenario_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.scenarios s WHERE s.id = j.scenario_id);

UPDATE public.playwright_jobs j
SET prerun_id = NULL
WHERE j.prerun_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.prerun_scripts p WHERE p.id = j.prerun_id);

UPDATE public.scenarios s
SET prerun_id = NULL
WHERE s.prerun_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.prerun_scripts p WHERE p.id = s.prerun_id);

ALTER TABLE public.scenario_filter_matrix
  DROP CONSTRAINT IF EXISTS scenario_filter_matrix_scenario_id_fkey;
ALTER TABLE public.scenario_filter_matrix
  ADD CONSTRAINT scenario_filter_matrix_scenario_id_fkey
  FOREIGN KEY (scenario_id) REFERENCES public.scenarios(id) ON DELETE CASCADE;

ALTER TABLE public.prerun_scripts
  DROP CONSTRAINT IF EXISTS prerun_scripts_report_id_fkey;
ALTER TABLE public.prerun_scripts
  ADD CONSTRAINT prerun_scripts_report_id_fkey
  FOREIGN KEY (report_id) REFERENCES public.reports(id) ON DELETE CASCADE;

ALTER TABLE public.scenario_versions
  DROP CONSTRAINT IF EXISTS scenario_versions_scenario_id_fkey;
ALTER TABLE public.scenario_versions
  ADD CONSTRAINT scenario_versions_scenario_id_fkey
  FOREIGN KEY (scenario_id) REFERENCES public.scenarios(id) ON DELETE CASCADE;

ALTER TABLE public.script_versions
  DROP CONSTRAINT IF EXISTS script_versions_script_id_fkey;
ALTER TABLE public.script_versions
  ADD CONSTRAINT script_versions_script_id_fkey
  FOREIGN KEY (script_id) REFERENCES public.scripts(id) ON DELETE CASCADE;

ALTER TABLE public.script_versions
  DROP CONSTRAINT IF EXISTS script_versions_scenario_id_fkey;
ALTER TABLE public.script_versions
  ADD CONSTRAINT script_versions_scenario_id_fkey
  FOREIGN KEY (scenario_id) REFERENCES public.scenarios(id) ON DELETE CASCADE;

ALTER TABLE public.playwright_jobs
  DROP CONSTRAINT IF EXISTS playwright_jobs_scenario_id_fkey;
ALTER TABLE public.playwright_jobs
  ADD CONSTRAINT playwright_jobs_scenario_id_fkey
  FOREIGN KEY (scenario_id) REFERENCES public.scenarios(id) ON DELETE CASCADE;

ALTER TABLE public.playwright_jobs
  DROP CONSTRAINT IF EXISTS playwright_jobs_prerun_id_fkey;
ALTER TABLE public.playwright_jobs
  ADD CONSTRAINT playwright_jobs_prerun_id_fkey
  FOREIGN KEY (prerun_id) REFERENCES public.prerun_scripts(id) ON DELETE SET NULL;

ALTER TABLE public.scenarios
  DROP CONSTRAINT IF EXISTS scenarios_prerun_id_fkey;
ALTER TABLE public.scenarios
  ADD CONSTRAINT scenarios_prerun_id_fkey
  FOREIGN KEY (prerun_id) REFERENCES public.prerun_scripts(id) ON DELETE SET NULL;

-- Scenario delete should drop its results (was SET NULL, which left orphans).
DO $$
DECLARE
  conname text;
BEGIN
  SELECT c.conname INTO conname
  FROM pg_constraint c
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
  WHERE c.conrelid = 'public.test_results'::regclass
    AND c.contype = 'f'
    AND a.attname = 'scenario_id'
    AND array_length(c.conkey, 1) = 1
  LIMIT 1;
  IF conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.test_results DROP CONSTRAINT %I', conname);
  END IF;
END $$;

ALTER TABLE public.test_results
  ADD CONSTRAINT test_results_scenario_id_fkey
  FOREIGN KEY (scenario_id) REFERENCES public.scenarios(id) ON DELETE CASCADE;

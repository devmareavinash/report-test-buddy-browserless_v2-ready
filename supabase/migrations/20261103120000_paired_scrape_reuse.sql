-- Paired Pre-prod ↔ Prod reports + scenario pair keys + schedule reuse flags.
-- Forward-only; safe to run twice.

ALTER TABLE public.reports
  ADD COLUMN IF NOT EXISTS paired_report_id uuid REFERENCES public.reports(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_reports_paired_report
  ON public.reports(paired_report_id)
  WHERE paired_report_id IS NOT NULL;

ALTER TABLE public.scenarios
  ADD COLUMN IF NOT EXISTS pair_key uuid;

CREATE INDEX IF NOT EXISTS idx_scenarios_pair_key
  ON public.scenarios(pair_key)
  WHERE pair_key IS NOT NULL;

ALTER TABLE public.schedules
  ADD COLUMN IF NOT EXISTS reuse_main boolean NOT NULL DEFAULT false;

ALTER TABLE public.schedules
  ADD COLUMN IF NOT EXISTS reuse_reference boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_test_results_scenario_created
  ON public.test_results(scenario_id, created_at DESC);

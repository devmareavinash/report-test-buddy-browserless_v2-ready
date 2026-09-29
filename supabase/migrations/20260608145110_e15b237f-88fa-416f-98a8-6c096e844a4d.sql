
ALTER TABLE public.scenario_filter_key_map ADD COLUMN IF NOT EXISTS report_id uuid REFERENCES public.reports(id) ON DELETE CASCADE;

UPDATE public.scenario_filter_key_map km
SET report_id = s.report_id
FROM public.scenarios s
WHERE km.scenario_id = s.id AND km.report_id IS NULL;

-- Deduplicate any (report_id, fe_label) collisions, keep earliest
DELETE FROM public.scenario_filter_key_map a
USING public.scenario_filter_key_map b
WHERE a.report_id = b.report_id
  AND a.fe_label = b.fe_label
  AND a.created_at > b.created_at;

ALTER TABLE public.scenario_filter_key_map ALTER COLUMN report_id SET NOT NULL;
ALTER TABLE public.scenario_filter_key_map DROP CONSTRAINT IF EXISTS scenario_filter_key_map_scenario_id_fe_label_key;
ALTER TABLE public.scenario_filter_key_map DROP COLUMN IF EXISTS scenario_id;

CREATE UNIQUE INDEX IF NOT EXISTS scenario_filter_key_map_report_fe_label_key
  ON public.scenario_filter_key_map(report_id, fe_label);
CREATE INDEX IF NOT EXISTS idx_scenario_filter_key_map_report ON public.scenario_filter_key_map(report_id);

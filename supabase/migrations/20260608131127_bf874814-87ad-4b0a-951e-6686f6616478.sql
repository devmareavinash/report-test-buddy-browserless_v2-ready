CREATE TABLE public.scenario_filter_key_map (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  scenario_id UUID NOT NULL REFERENCES public.scenarios(id) ON DELETE CASCADE,
  fe_label TEXT NOT NULL,
  be_column TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scenario_id, fe_label)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.scenario_filter_key_map TO authenticated;
GRANT ALL ON public.scenario_filter_key_map TO service_role;

ALTER TABLE public.scenario_filter_key_map ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read scenario_filter_key_map"
  ON public.scenario_filter_key_map FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated write scenario_filter_key_map"
  ON public.scenario_filter_key_map FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE INDEX idx_scenario_filter_key_map_scenario ON public.scenario_filter_key_map(scenario_id);
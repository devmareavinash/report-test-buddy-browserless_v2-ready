-- Canonical script per scenario: last write wins (Save / Generate persist).
-- scripts is scenario-level shared data (no user_id). Any authenticated JWT can SELECT.
-- Existing duplicate rows are not deleted; loaders take updated_at then created_at,
-- preferring a row that already has playwright_code so a new AWS login reuses the save.

ALTER TABLE public.scripts
  ADD COLUMN IF NOT EXISTS updated_at timestamptz;

UPDATE public.scripts
  SET updated_at = COALESCE(updated_at, created_at, now())
  WHERE updated_at IS NULL;

ALTER TABLE public.scripts
  ALTER COLUMN updated_at SET DEFAULT now();

ALTER TABLE public.scripts
  ALTER COLUMN updated_at SET NOT NULL;

CREATE OR REPLACE FUNCTION public.set_scripts_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS scripts_set_updated_at ON public.scripts;
CREATE TRIGGER scripts_set_updated_at
  BEFORE UPDATE ON public.scripts
  FOR EACH ROW
  EXECUTE FUNCTION public.set_scripts_updated_at();

CREATE INDEX IF NOT EXISTS scripts_scenario_updated_idx
  ON public.scripts (scenario_id, updated_at DESC NULLS LAST, created_at DESC);

-- Child report executions finish concurrently in hosted Edge workers. Serialize
-- their updates so every completion increments the parent workstream run once.
CREATE OR REPLACE FUNCTION public.finalize_workstream_child(
  p_run_id uuid,
  p_add_pass integer,
  p_add_fail integer,
  p_had_error boolean,
  p_error_message text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_run public.runs%ROWTYPE;
  next_summary jsonb;
  next_done integer;
  child_count integer;
  errors jsonb;
BEGIN
  SELECT *
  INTO current_run
  FROM public.runs
  WHERE id = p_run_id
  FOR UPDATE;

  IF NOT FOUND OR current_run.status <> 'running' THEN
    RETURN;
  END IF;

  child_count := COALESCE((current_run.summary ->> 'child_count')::integer, 0);
  next_done := COALESCE((current_run.summary ->> 'done')::integer, 0) + 1;
  errors := COALESCE(current_run.summary -> 'errors', '[]'::jsonb);

  IF p_had_error THEN
    errors := errors || jsonb_build_array(COALESCE(p_error_message, 'child error'));
  END IF;

  next_summary := jsonb_build_object(
    'pass', COALESCE((current_run.summary ->> 'pass')::integer, 0) + COALESCE(p_add_pass, 0),
    'fail', COALESCE((current_run.summary ->> 'fail')::integer, 0) + COALESCE(p_add_fail, 0),
    'total', COALESCE((current_run.summary ->> 'total')::integer, 0)
      + COALESCE(p_add_pass, 0) + COALESCE(p_add_fail, 0),
    'done', next_done,
    'child_count', child_count,
    'concurrency', current_run.summary -> 'concurrency'
  );

  IF jsonb_array_length(errors) > 0 THEN
    next_summary := next_summary || jsonb_build_object('errors', errors);
  END IF;

  UPDATE public.runs
  SET
    summary = next_summary,
    status = CASE
      WHEN child_count > 0 AND next_done >= child_count THEN 'completed'
      ELSE status
    END,
    finished_at = CASE
      WHEN child_count > 0 AND next_done >= child_count THEN now()
      ELSE finished_at
    END
  WHERE id = p_run_id;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_workstream_child(uuid, integer, integer, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finalize_workstream_child(uuid, integer, integer, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_workstream_child(uuid, integer, integer, boolean, text) TO service_role;

-- Finalize each report in a workstream run exactly once.
-- The orchestrator supplies report_id so retries cannot double-count a child.
CREATE OR REPLACE FUNCTION public.finalize_workstream_report(
  p_run_id uuid,
  p_report_id uuid,
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
  current_summary jsonb;
  reports jsonb;
  report_outcome jsonb;
  errors jsonb;
  next_summary jsonb;
  next_done integer;
  child_count integer;
  failed_reports integer;
BEGIN
  SELECT *
  INTO current_run
  FROM public.runs
  WHERE id = p_run_id
  FOR UPDATE;

  IF NOT FOUND OR current_run.status <> 'running' THEN
    RETURN;
  END IF;

  current_summary := COALESCE(current_run.summary, '{}'::jsonb);
  reports := COALESCE(current_summary -> 'reports', '{}'::jsonb);

  -- Hosted workers can retry finalization. Do not count a report twice.
  IF reports ? p_report_id::text THEN
    RETURN;
  END IF;

  report_outcome := jsonb_build_object(
    'status', CASE WHEN p_had_error THEN 'error' ELSE 'done' END,
    'pass', COALESCE(p_add_pass, 0),
    'fail', COALESCE(p_add_fail, 0),
    'error', CASE WHEN p_had_error THEN COALESCE(p_error_message, 'report error') ELSE NULL END
  );
  reports := reports || jsonb_build_object(p_report_id::text, report_outcome);

  next_done := jsonb_object_length(reports);
  child_count := COALESCE((current_summary ->> 'child_count')::integer, 0);
  SELECT count(*)::integer
  INTO failed_reports
  FROM jsonb_each(reports) AS report
  WHERE report.value ->> 'status' = 'error';

  errors := COALESCE(current_summary -> 'errors', '[]'::jsonb);
  IF p_had_error THEN
    errors := errors || jsonb_build_array(COALESCE(p_error_message, 'report error'));
  END IF;

  next_summary := current_summary || jsonb_build_object(
    'pass', COALESCE((current_summary ->> 'pass')::integer, 0) + COALESCE(p_add_pass, 0),
    'fail', COALESCE((current_summary ->> 'fail')::integer, 0) + COALESCE(p_add_fail, 0),
    'total', COALESCE((current_summary ->> 'total')::integer, 0)
      + COALESCE(p_add_pass, 0) + COALESCE(p_add_fail, 0),
    'done', next_done,
    'failed_reports', failed_reports,
    'reports', reports,
    'errors', errors
  );

  UPDATE public.runs
  SET
    summary = next_summary,
    status = CASE
      WHEN child_count > 0 AND next_done >= child_count AND failed_reports > 0 THEN 'failed'
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

REVOKE ALL ON FUNCTION public.finalize_workstream_report(uuid, uuid, integer, integer, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finalize_workstream_report(uuid, uuid, integer, integer, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_workstream_report(uuid, uuid, integer, integer, boolean, text) TO service_role;

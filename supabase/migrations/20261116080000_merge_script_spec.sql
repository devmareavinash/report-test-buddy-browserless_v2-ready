CREATE OR REPLACE FUNCTION public.merge_script_spec(p_id uuid, p_patch jsonb, p_remove text[] DEFAULT '{}', p_fields jsonb DEFAULT '{}'::jsonb)
RETURNS SETOF public.scripts
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  UPDATE public.scripts SET
    assertion_spec = (COALESCE(assertion_spec, '{}'::jsonb) - COALESCE(p_remove, '{}')) || COALESCE(p_patch, '{}'::jsonb),
    playwright_code = CASE WHEN p_fields ? 'playwright_code' THEN p_fields->>'playwright_code' ELSE playwright_code END,
    debug_status = CASE WHEN p_fields ? 'debug_status' THEN p_fields->>'debug_status' ELSE debug_status END,
    credential_profile_id = CASE WHEN p_fields ? 'credential_profile_id' THEN (p_fields->>'credential_profile_id')::uuid ELSE credential_profile_id END
  WHERE id = p_id
  RETURNING *;
$$;
REVOKE ALL ON FUNCTION public.merge_script_spec(uuid, jsonb, text[], jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.merge_script_spec(uuid, jsonb, text[], jsonb) TO authenticated, service_role;
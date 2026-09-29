
-- 1. Make artifacts bucket private
UPDATE storage.buckets SET public = false WHERE id = 'artifacts';

-- Drop any public/anon SELECT policies on artifacts in storage.objects
DO $$
DECLARE p record;
BEGIN
  FOR p IN
    SELECT policyname FROM pg_policies
    WHERE schemaname='storage' AND tablename='objects'
      AND qual LIKE '%artifacts%'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', p.policyname);
  END LOOP;
END $$;

-- Authenticated-only access policies for artifacts bucket
CREATE POLICY "Authenticated read artifacts"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'artifacts');

CREATE POLICY "Authenticated write artifacts"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'artifacts');

CREATE POLICY "Authenticated update artifacts"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'artifacts');

CREATE POLICY "Authenticated delete artifacts"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'artifacts');

-- 2. Privilege escalation hardening on user_roles: restrictive deny for non-admin writes
CREATE POLICY "Only admins can write roles (restrictive)"
  ON public.user_roles AS RESTRICTIVE
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- 3. Revoke EXECUTE from anon on SECURITY DEFINER functions
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, app_role) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.snapshot_script_version() FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.snapshot_scenario_version() FROM anon, authenticated, public;

-- has_role still needs to be callable by authenticated for RLS policy use
GRANT EXECUTE ON FUNCTION public.has_role(uuid, app_role) TO authenticated;

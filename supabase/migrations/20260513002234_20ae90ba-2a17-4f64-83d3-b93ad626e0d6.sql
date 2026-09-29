
-- Remove public write access to artifacts storage bucket
DROP POLICY IF EXISTS "artifacts_anyone_write" ON storage.objects;
DROP POLICY IF EXISTS "artifacts_anyone_update" ON storage.objects;

-- Restrict EXECUTE on SECURITY DEFINER helpers
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM anon;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon, authenticated, public;

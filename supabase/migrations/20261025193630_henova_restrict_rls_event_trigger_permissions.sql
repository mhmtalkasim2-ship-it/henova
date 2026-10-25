-- Restrict invocation of the Supabase-generated event-trigger helper.
-- The underlying event trigger remains enabled for automatic RLS on new tables.
REVOKE ALL ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;

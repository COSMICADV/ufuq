-- ===========================================================================
-- Pre-Phase 7 cleanup — pin `platform_list_active_company_ids()` against
-- search_path shadowing.
--
-- MIGRATION IMPLICATIONS — DOCUMENT 27 RULE 31
--
--   What data exists:   none is changed. One function body and its
--                       `search_path` setting are replaced; its signature,
--                       result and grants are unchanged.
--   In-flight records:  none.
--   Reversibility:      reversible — restore the previous definition from
--                       `20260926000000_phase6_nightly_company_enumeration`.
--
-- Why: the function was declared `SET search_path = public`. PostgreSQL
-- searches the session's temporary schema *before* every schema in the path
-- unless `pg_temp` is named explicitly, and `ufuq_app` holds TEMP on the
-- database. Verified before this change: as `ufuq_app`, `CREATE TEMP TABLE
-- companies (...)` followed by a call to the function returned the temp
-- table's rows instead of the real ones. The PostgreSQL manual's guidance for
-- SECURITY DEFINER functions is to name `pg_temp` last; the body is also
-- schema-qualified so it cannot resolve to anything but `public.companies`.
-- ===========================================================================

CREATE OR REPLACE FUNCTION platform_list_active_company_ids()
RETURNS TABLE (id UUID)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT c.id
  FROM public.companies c
  WHERE c.status = 'active'::public.company_status AND c.deleted_at IS NULL
  ORDER BY c.id;
$$;

-- `CREATE OR REPLACE` keeps the existing privileges; restated so the
-- restriction is visible in the migration that last defined the function.
REVOKE ALL ON FUNCTION platform_list_active_company_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_list_active_company_ids() TO "ufuq_app";

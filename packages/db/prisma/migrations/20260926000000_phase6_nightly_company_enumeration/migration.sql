-- ===========================================================================
-- Phase 6 (critical fix) — company enumeration for the nightly attendance run,
-- and the correction window's undocumented upper bound removed.
--
-- MIGRATION IMPLICATIONS — DOCUMENT 27 RULE 31
--
--   What data exists:   none is changed. One function is added, and one CHECK
--                       constraint on `companies` is replaced by a strictly
--                       looser one — every value the old constraint accepted
--                       (1–365) the new one accepts, so no existing row can
--                       fail it.
--   In-flight records:  none.
--   Reversibility:      reversible — drop the function, and restore
--                       `companies_correction_window_days_range` after first
--                       bringing any value above 365 back inside it.
--
-- Written as a separate migration: a migration that has been written down is
-- append-only (see `20260924000000_phase6_correction_window_and_system_actor`).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Which companies the nightly run should visit — DOCUMENT 09 §7
--
-- The nightly attendance run (DOCUMENT 12 rule 10) starts with no tenant: its
-- first question is which companies exist. `companies` is under FORCE row-level
-- security keyed on `app.company_id`, so `ufuq_app` asking that question with
-- no tenant bound is answered with zero rows — the run reports success and
-- generates nothing, for every company, every night.
--
-- This is the same kind of question the `auth_lookup_*` functions answer (a
-- lookup that must happen before a tenant is known), so it gets the same kind
-- of answer: one explicit, greppable SECURITY DEFINER function, granted to
-- `ufuq_app` and nothing wider. Row-level security is not disabled or
-- loosened, and no role gains BYPASSRLS.
--
-- It returns **ids only**. Everything the run then needs to know about a
-- company — its timezone included — is read inside that company's own tenant
-- scope, so this function discloses nothing but the fact that an active
-- company with this id exists. Like the `auth_lookup_*` functions it runs as
-- its owner, the migration role; see the Phase 3 migration for why that role
-- is the deploy-time superuser and never the role a request runs as.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION platform_list_active_company_ids()
RETURNS TABLE (id UUID)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT c.id
  FROM companies c
  WHERE c.status = 'active' AND c.deleted_at IS NULL
  ORDER BY c.id;
$$;

REVOKE ALL ON FUNCTION platform_list_active_company_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_list_active_company_ids() TO "ufuq_app";

-- ---------------------------------------------------------------------------
-- 2. The correction window has a minimum, not a maximum — DOCUMENT 12 rule 13
--
-- "Corrections have a window, default 7 days, configurable per company."
-- DOCUMENT 12 states a default and says it is configurable; it states no upper
-- bound, and the 365 the previous migration added was not documented anywhere.
-- The minimum of 1 stays: a window of zero days is not a configuration, it is
-- switching off the flow DOCUMENT 12 rule 14 depends on.
--
-- Renamed from `_range` to `_min` because it no longer describes a range.
-- ---------------------------------------------------------------------------
ALTER TABLE "companies"
  DROP CONSTRAINT "companies_correction_window_days_range";

ALTER TABLE "companies"
  ADD CONSTRAINT "companies_correction_window_days_min"
  CHECK ("correction_window_days" >= 1);

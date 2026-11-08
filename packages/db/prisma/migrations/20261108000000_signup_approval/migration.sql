-- ===========================================================================
-- Sign-up approval — a public registration waits for the platform owner.
--
-- MIGRATION IMPLICATIONS — DOCUMENT 27 RULE 31
--
--   What data exists:   none is changed. Two `company_status` values, three
--                       `audit_action` values and one nullable column are
--                       added; existing companies keep their status.
--   In-flight records:  a registration made before this migration is still an
--                       `active` company with an `invited` ADMIN, and finishes
--                       through its emailed invitation exactly as before.
--   Reversibility:      the column and function can be dropped; enum values
--                       cannot be removed in PostgreSQL, so they stay unused.
--
-- Why: a new company created from the public register form now starts as
-- `pending_approval`. Its ADMIN cannot sign in until the platform owner
-- approves it from the owner page (or the link in the notification email).
-- ===========================================================================

ALTER TYPE "company_status" ADD VALUE IF NOT EXISTS 'pending_approval';
ALTER TYPE "company_status" ADD VALUE IF NOT EXISTS 'rejected';

ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'signup.requested';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'signup.approved';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'signup.rejected';

ALTER TABLE "companies" ADD COLUMN "reviewed_at" TIMESTAMPTZ(3);

-- The owner page lists sign-ups across every tenant. Row-level security
-- answers that question with nothing (see `tenant.ts`), so — like
-- `platform_list_active_company_ids()` — this is one explicit SECURITY DEFINER
-- function, pinned against search_path shadowing, returning only what the
-- owner page shows. Statuses are compared as text so the body does not depend
-- on the enum values added above being committed first.
CREATE OR REPLACE FUNCTION platform_list_signup_requests()
RETURNS TABLE (
  company_id UUID,
  company_name VARCHAR(200),
  employee_count_range VARCHAR(20),
  status TEXT,
  created_at TIMESTAMPTZ,
  reviewed_at TIMESTAMPTZ,
  admin_name TEXT,
  admin_email VARCHAR(255),
  admin_phone TEXT
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT
    c.id,
    c.name,
    c.employee_count_range,
    c.status::text,
    c.created_at,
    c.reviewed_at,
    u.display_name::text,
    u.email,
    u.phone::text
  FROM public.companies c
  JOIN public.users u ON u.id = c.created_by AND u.company_id = c.id
  WHERE c.deleted_at IS NULL
    AND c.status::text IN ('pending_approval', 'active', 'rejected')
    AND (c.status::text = 'pending_approval' OR c.reviewed_at IS NOT NULL)
  ORDER BY (c.status::text = 'pending_approval') DESC, c.created_at DESC
  LIMIT 500;
$$;

REVOKE ALL ON FUNCTION platform_list_signup_requests() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_list_signup_requests() TO "ufuq_app";

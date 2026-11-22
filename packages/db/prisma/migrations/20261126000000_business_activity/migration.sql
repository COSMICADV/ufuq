-- ===========================================================================
-- 1to1OS Business — the activity chosen on the Business page.
--
-- MIGRATION IMPLICATIONS — DOCUMENT 27 RULE 31
--   What data exists:   every existing company keeps NULL (no activity chosen).
--   In-flight records:  none.
--   Reversibility:      drop the two columns.
--
-- The activity configures the one workspace a company gets (which core
-- modules matter most to it); it never creates a separate system. Medical
-- has a sub-type: a doctor's clinic or a medical center.
-- ===========================================================================

ALTER TABLE "companies"
  ADD COLUMN "business_activity" VARCHAR(20),
  ADD COLUMN "business_subtype"  VARCHAR(30),
  ADD CONSTRAINT "companies_business_activity_check" CHECK (
    "business_activity" IS NULL
    OR "business_activity" IN ('medical', 'food', 'clothing', 'perfume', 'fitness', 'beauty', 'retail', 'other')
  ),
  ADD CONSTRAINT "companies_business_subtype_check" CHECK (
    "business_subtype" IS NULL
    OR ("business_activity" = 'medical' AND "business_subtype" IN ('clinic', 'medical_center'))
  );

-- The owner's review list shows the activity too. Its return type grows, so
-- the function is dropped and recreated (same body, two more columns, same
-- SECURITY DEFINER pinning and grants as 20261108000000_signup_approval).
DROP FUNCTION IF EXISTS platform_list_signup_requests();
CREATE FUNCTION platform_list_signup_requests()
RETURNS TABLE (
  company_id UUID,
  company_name VARCHAR(200),
  employee_count_range VARCHAR(20),
  business_activity VARCHAR(20),
  business_subtype VARCHAR(30),
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
    c.business_activity,
    c.business_subtype,
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

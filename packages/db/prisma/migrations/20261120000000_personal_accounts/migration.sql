-- ===========================================================================
-- 1to1OS Personal — individual accounts.
--
-- MIGRATION IMPLICATIONS — DOCUMENT 27 RULE 31
--
--   What data exists:   none is changed. One enum type and one NOT NULL
--                       column with a default are added, so every existing
--                       company becomes `business`; one `audit_action` value
--                       is added.
--   In-flight records:  none; Business sign-up, approval and sign-in are
--                       untouched.
--   Reversibility:      the column and type can be dropped; the enum value
--                       cannot be removed in PostgreSQL, so it stays unused.
--
-- Why: a Personal account is a one-person workspace — a `companies` row of
-- kind `personal` with a single user holding the `personal` system role (seeded
-- by prisma/seed.ts, no Business permissions). Reusing the tenant row keeps
-- row-level security, sessions and sign-in exactly as they are. It is active
-- straight away (no owner review), and it never appears on the owner's
-- sign-up list, which only lists pending or reviewed companies.
-- ===========================================================================

CREATE TYPE "company_kind" AS ENUM ('business', 'personal');

ALTER TABLE "companies" ADD COLUMN "kind" "company_kind" NOT NULL DEFAULT 'business';

ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'signup.personal';

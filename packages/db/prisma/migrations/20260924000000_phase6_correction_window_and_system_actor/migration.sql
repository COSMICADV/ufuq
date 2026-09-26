-- ===========================================================================
-- Phase 6 (final fix) — the correction window as a company setting, and a
-- designated system actor (DOCUMENT 12 rule 13, DOCUMENT 21 "Record content").
--
-- MIGRATION IMPLICATIONS — DOCUMENT 27 RULE 31
--
--   What data exists:   `companies` gains `correction_window_days` with the
--                       DOCUMENT 12 default of 7, so every existing company
--                       keeps exactly the behaviour it had while the value
--                       was a constant in the service — this migration changes
--                       no company's correction window, it only makes it
--                       configurable. `users` gains `is_system`, false for
--                       every existing row: no account already in the database
--                       becomes a system actor.
--   In-flight records:  none. The backfill below creates one system user per
--                       existing company; a company created after this
--                       migration gets one on first use (`SystemActorService`,
--                       which is idempotent against the unique index here).
--   Reversibility:      reversible — drop the two columns, the index, the
--                       constraints, and restore the previous
--                       `auth_lookup_login` body. The backfilled system users
--                       would have to be removed first, and any audit row
--                       pointing at one re-attributed, which is why the
--                       backfill is written to be re-runnable rather than
--                       clever.
--
-- Written as a separate migration rather than an edit to
-- `20260923000000_phase6_attendance`: a migration that has been written down
-- is append-only, and editing one that a database may already have applied is
-- how two environments quietly stop sharing a schema.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The correction window — DOCUMENT 12 rule 13, DOCUMENT 04 C4
--
-- "Corrections have a window, default 7 days, configurable per company."
-- DOCUMENT 06 §3.1 did not give it a column; this is that column, and the
-- DEFAULT is DOCUMENT 12's own number rather than a choice made here.
--
-- The CHECK bounds are 1–365. Zero is excluded because a window of zero days
-- is not a configuration, it is switching the correction flow off, and
-- DOCUMENT 12 rule 14 depends on that flow existing as the route a forgotten
-- check-in takes. An upper bound exists so the value stays a window.
-- ---------------------------------------------------------------------------
ALTER TABLE "companies"
  ADD COLUMN "correction_window_days" SMALLINT NOT NULL DEFAULT 7;

ALTER TABLE "companies"
  ADD CONSTRAINT "companies_correction_window_days_range"
  CHECK ("correction_window_days" BETWEEN 1 AND 365);

-- ---------------------------------------------------------------------------
-- 2. The designated system actor — DOCUMENT 21 "Record content"
--
-- DOCUMENT 21 requires an acting user on every audit record and forbids null.
-- Generated attendance (DOCUMENT 12 rules 9 and 10) has no acting human, and
-- attributing it to a real administrator reads as though that person did
-- something they did not.
--
-- This is the minimum that makes such an account safe: a flag that marks it,
-- and two constraints plus one lookup change that together mean it can never
-- authenticate.
-- ---------------------------------------------------------------------------
ALTER TABLE "users"
  ADD COLUMN "is_system" BOOLEAN NOT NULL DEFAULT false;

-- A system actor has no password, ever. Acceptance of an invitation is what
-- would otherwise set one (`POST /auth/accept-invitation`), so this constraint
-- is what makes "it can never authenticate" a property of the database rather
-- than a promise made by the service layer.
ALTER TABLE "users"
  ADD CONSTRAINT "users_system_has_no_password"
  CHECK (NOT "is_system" OR "password_hash" IS NULL);

-- Nor can it hold a session: without a password there is no login, and
-- without a login there is no session row to find.
ALTER TABLE "users"
  ADD CONSTRAINT "users_system_is_not_invited"
  CHECK (NOT "is_system" OR "status" = 'deactivated');

-- Exactly one per company. Partial, so it constrains only system rows and
-- leaves ordinary users alone; it is also what makes `SystemActorService`'s
-- find-or-create idempotent under concurrency.
CREATE UNIQUE INDEX "users_one_system_actor_per_company"
  ON "users"("company_id")
  WHERE "is_system";

-- ---------------------------------------------------------------------------
-- 3. The login path cannot see a system actor at all
--
-- `auth_lookup_login` is the single entry point for both `POST /auth/login`
-- and `POST /auth/forgot-password` (DOCUMENT 08 §4.1). Excluding system rows
-- here closes both in one place: the account is not "refused at login", it is
-- invisible to the code that would do the refusing, which is the stronger
-- guarantee and cannot be undone by a later change to the service.
--
-- The body is otherwise byte-for-byte the Phase 3 definition.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_lookup_login(p_email TEXT)
RETURNS TABLE (
  id UUID,
  company_id UUID,
  email VARCHAR(255),
  password_hash VARCHAR(255),
  role_id UUID,
  status user_status,
  failed_login_count SMALLINT,
  last_failed_login_at TIMESTAMPTZ,
  locked_until TIMESTAMPTZ,
  company_status company_status
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT u.id, u.company_id, u.email, u.password_hash, u.role_id, u.status,
         u.failed_login_count, u.last_failed_login_at, u.locked_until, c.status AS company_status
  FROM users u
  JOIN companies c ON c.id = u.company_id
  WHERE u.email = p_email AND u.deleted_at IS NULL AND NOT u.is_system;
$$;

-- ---------------------------------------------------------------------------
-- 4. Backfill — one system actor per existing company
--
-- The role is the lowest-privilege system role (DOCUMENT 02 §2 `employee`).
-- `role_id` is NOT NULL and inventing a fifth role to hold no permissions
-- would be inventing a role (DOCUMENT 27 RULE 2); the account cannot
-- authenticate, so its permissions are never resolved by anything.
--
-- The address is under `.invalid`, which RFC 2606 reserves precisely so that
-- it can never resolve — the row satisfies the NOT NULL column without
-- creating a mailbox anybody could write to.
--
-- Skipped where the `employee` system role has not been seeded yet: in a fresh
-- database this migration runs before the seed, there are no companies, and
-- this is a no-op. `SystemActorService` creates the row on first use.
-- ---------------------------------------------------------------------------
INSERT INTO "users" ("id", "company_id", "email", "password_hash", "role_id",
                     "status", "is_system", "created_at", "updated_at")
SELECT
  gen_random_uuid(),
  c."id",
  'system@ufuq.invalid',
  NULL,
  r."id",
  'deactivated',
  true,
  now(),
  now()
FROM "companies" c
CROSS JOIN LATERAL (
  SELECT "id" FROM "roles"
  WHERE "key" = 'employee' AND "company_id" IS NULL
  LIMIT 1
) r
WHERE NOT EXISTS (
  SELECT 1 FROM "users" u WHERE u."company_id" = c."id" AND u."is_system"
);

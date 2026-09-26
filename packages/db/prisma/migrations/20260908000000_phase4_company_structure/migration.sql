-- ===========================================================================
-- Phase 4 — company structure (DOCUMENT 06 §3.4–3.9, DOCUMENT 12, DOCUMENT 25)
--
-- MIGRATION IMPLICATIONS — DOCUMENT 27 RULE 31
--
--   What data exists:   none of the five tables below exists yet, so there is
--                       no data to migrate. `companies` already carries every
--                       column the Phase 4 settings screen edits (name,
--                       logo_path, timezone, currency, default_locale,
--                       fiscal_month_start_day); Phase 3 created them, and
--                       this migration does not touch that table.
--   In-flight records:  none. Nothing reads or writes these tables until the
--                       endpoints in this phase are deployed alongside it.
--   Reversibility:      fully reversible while the tables are empty — drop the
--                       five tables and the two new enum types. The two values
--                       added to `audit_action` are *not* reversible:
--                       PostgreSQL cannot remove an enum value. That is
--                       intentional and harmless — an audit action that has
--                       been written must remain readable forever
--                       (DOCUMENT 21, append-only).
--
-- `ALTER TYPE … ADD VALUE` is safe inside the transaction Prisma wraps a
-- migration in on PostgreSQL 12+, because nothing in this file *uses* the new
-- values; the first row carrying one is written by the application, in a
-- later transaction.
-- ===========================================================================

CREATE TYPE "department_status" AS ENUM ('active', 'inactive');
CREATE TYPE "overtime_policy" AS ENUM ('none', 'paid', 'banked');

-- DOCUMENT 21 "Settings & data access". Only the two actions Phase 4 can
-- actually raise are added; the rest of the DOCUMENT 21 catalogue arrives with
-- the phases that raise it.
ALTER TYPE "audit_action" ADD VALUE 'settings.company_updated';
ALTER TYPE "audit_action" ADD VALUE 'settings.schedule_changed';

-- ---------------------------------------------------------------------------
-- departments — DOCUMENT 06 §3.4
--
-- `manager_employee_id` is absent by approved Phase 4 decision: it is a
-- foreign key to `employees`, which Phase 5 creates. See schema.prisma.
-- ---------------------------------------------------------------------------
CREATE TABLE "departments" (
  "id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "name_ar" VARCHAR(200) NOT NULL,
  "name_en" VARCHAR(200) NOT NULL,
  "parent_id" UUID,
  "status" "department_status" NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  "deleted_at" TIMESTAMPTZ(3),
  CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- DOCUMENT 06 §5: RESTRICT for anything historical. A department is
-- referenced by employees, attendance and payroll history in later phases, so
-- it is never removed by a cascade from its company.
ALTER TABLE "departments"
  ADD CONSTRAINT "departments_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Self-reference for the tree. RESTRICT rather than CASCADE: silently removing
-- a subtree is not a decision a foreign key should make.
ALTER TABLE "departments"
  ADD CONSTRAINT "departments_parent_id_fkey"
  FOREIGN KEY ("parent_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A department can never be its own parent. Deeper cycles need a recursive
-- walk and are rejected by the service (DOCUMENT 06 §3.6 uses the same
-- division of labour for `employees.manager_id`).
ALTER TABLE "departments"
  ADD CONSTRAINT "departments_parent_not_self" CHECK ("parent_id" IS NULL OR "parent_id" <> "id");

-- DOCUMENT 06 §3.4, written exactly as specified — no soft-delete predicate,
-- so a soft-deleted department keeps its Arabic name reserved.
CREATE UNIQUE INDEX "departments_company_id_name_ar_key" ON "departments"("company_id", "name_ar");
CREATE INDEX "departments_company_id_status_idx" ON "departments"("company_id", "status");
CREATE INDEX "departments_parent_id_idx" ON "departments"("parent_id");

-- ---------------------------------------------------------------------------
-- positions — DOCUMENT 06 §3.5
-- ---------------------------------------------------------------------------
CREATE TABLE "positions" (
  "id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "title_ar" VARCHAR(200) NOT NULL,
  "title_en" VARCHAR(200) NOT NULL,
  "department_id" UUID,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  "deleted_at" TIMESTAMPTZ(3),
  CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "positions"
  ADD CONSTRAINT "positions_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "positions"
  ADD CONSTRAINT "positions_department_id_fkey"
  FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "positions_company_id_department_id_idx" ON "positions"("company_id", "department_id");

-- ---------------------------------------------------------------------------
-- work_schedules — DOCUMENT 06 §3.7, DOCUMENT 12
--
-- DOCUMENT 27 RULE 12: every working-hours value a later phase needs lives
-- here. There is no default schedule seeded and no `WORKING_DAYS` constant
-- anywhere in this repository.
-- ---------------------------------------------------------------------------
CREATE TABLE "work_schedules" (
  "id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "name" VARCHAR(200) NOT NULL,
  "is_default" BOOLEAN NOT NULL DEFAULT false,
  "timezone" VARCHAR(64) NOT NULL,
  "grace_period_minutes" INTEGER NOT NULL DEFAULT 0,
  "half_day_threshold_hours" DECIMAL(4, 2) NOT NULL,
  "overtime_policy" "overtime_policy" NOT NULL DEFAULT 'none',
  "break_minutes" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  "deleted_at" TIMESTAMPTZ(3),
  CONSTRAINT "work_schedules_pkey" PRIMARY KEY ("id"),
  -- Bounds, not business rules: a grace period or an unpaid break longer than
  -- the day it belongs to, or a half-day threshold outside 0–24 hours, is not
  -- a configuration choice — it is corrupt data.
  CONSTRAINT "work_schedules_grace_within_a_day" CHECK ("grace_period_minutes" BETWEEN 0 AND 1440),
  CONSTRAINT "work_schedules_break_within_a_day" CHECK ("break_minutes" BETWEEN 0 AND 1440),
  CONSTRAINT "work_schedules_half_day_within_a_day" CHECK ("half_day_threshold_hours" > 0 AND "half_day_threshold_hours" <= 24)
);

ALTER TABLE "work_schedules"
  ADD CONSTRAINT "work_schedules_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "work_schedules_company_id_is_default_idx" ON "work_schedules"("company_id", "is_default");

-- "Default" is singular by definition. The service clears the previous default
-- inside the same transaction; this index is what makes a race between two
-- concurrent requests fail loudly instead of leaving two defaults behind.
CREATE UNIQUE INDEX "work_schedules_one_default_per_company"
  ON "work_schedules"("company_id")
  WHERE "is_default" AND "deleted_at" IS NULL;

-- ---------------------------------------------------------------------------
-- work_schedule_days — DOCUMENT 06 §3.8
--
-- No `company_id` column: DOCUMENT 06 §3.8 does not define one, and tenancy is
-- reached through the parent schedule (see the row-level security policy
-- below). A duplicated tenant column here could drift out of step with its
-- parent's; a policy that walks the foreign key cannot.
-- ---------------------------------------------------------------------------
CREATE TABLE "work_schedule_days" (
  "id" UUID NOT NULL,
  "work_schedule_id" UUID NOT NULL,
  "day_of_week" SMALLINT NOT NULL,
  "is_working_day" BOOLEAN NOT NULL,
  "start_time" TIME(0),
  "end_time" TIME(0),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "work_schedule_days_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "work_schedule_days_day_of_week_range" CHECK ("day_of_week" BETWEEN 0 AND 6),
  -- A working day always has both times and ends after it starts; a
  -- non-working day has neither. Half-configured days are what force a later
  -- phase to guess (DOCUMENT 27 RULE 12).
  --
  -- `end_time > start_time` also encodes "schedules stay within one calendar
  -- day". Overnight shifts are OD-05, an unresolved Phase 6 decision; when it
  -- is resolved this constraint is what a migration must relax, deliberately.
  CONSTRAINT "work_schedule_days_time_shape" CHECK (
    ("is_working_day" AND "start_time" IS NOT NULL AND "end_time" IS NOT NULL AND "end_time" > "start_time")
    OR (NOT "is_working_day" AND "start_time" IS NULL AND "end_time" IS NULL)
  )
);

-- DOCUMENT 06 §5: CASCADE is listed for `work_schedule_days` by name — the
-- days are genuinely owned by their schedule and have no meaning without it.
ALTER TABLE "work_schedule_days"
  ADD CONSTRAINT "work_schedule_days_work_schedule_id_fkey"
  FOREIGN KEY ("work_schedule_id") REFERENCES "work_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "work_schedule_days_work_schedule_id_day_of_week_key"
  ON "work_schedule_days"("work_schedule_id", "day_of_week");

-- ---------------------------------------------------------------------------
-- holidays — DOCUMENT 06 §3.9, DOCUMENT 12
-- ---------------------------------------------------------------------------
CREATE TABLE "holidays" (
  "id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "date" DATE NOT NULL,
  "name_ar" VARCHAR(200) NOT NULL,
  "name_en" VARCHAR(200) NOT NULL,
  "is_recurring" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "holidays_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "holidays"
  ADD CONSTRAINT "holidays_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "holidays_company_id_date_key" ON "holidays"("company_id", "date");
CREATE INDEX "holidays_company_id_date_idx" ON "holidays"("company_id", "date");

-- ===========================================================================
-- Least privilege — DOCUMENT 20 §3
--
-- The Phase 3 migration's `ALTER DEFAULT PRIVILEGES` already covers tables
-- created by a later migration running as the same owner. These grants are
-- written out anyway so the privileges a table has are readable in the
-- migration that creates it, rather than inferred from another file.
-- ===========================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "departments", "positions", "work_schedules", "work_schedule_days", "holidays"
  TO "ufuq_app";

-- ===========================================================================
-- Row-level security — AD-03, DOCUMENT 20 §3, DOCUMENT 27 RULE 10
--
-- FORCE, not just ENABLE: without it the table owner is exempt, and "the
-- policy protects everyone except whoever owns the table" is not isolation.
-- `packages/db/test/phase4-rls.test.ts` proves each policy holds against a
-- query with no WHERE clause at all — the DOCUMENT 25 Phase 3 exit criterion,
-- re-established for every table this phase adds.
-- ===========================================================================
ALTER TABLE "departments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "departments" FORCE ROW LEVEL SECURITY;
ALTER TABLE "positions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "positions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "work_schedules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "work_schedules" FORCE ROW LEVEL SECURITY;
ALTER TABLE "work_schedule_days" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "work_schedule_days" FORCE ROW LEVEL SECURITY;
ALTER TABLE "holidays" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "holidays" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "departments"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

CREATE POLICY "tenant_isolation" ON "positions"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

CREATE POLICY "tenant_isolation" ON "work_schedules"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

CREATE POLICY "tenant_isolation" ON "holidays"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

-- `work_schedule_days` has no tenant column of its own, so its policy walks
-- the foreign key. The subquery reads `work_schedules`, which is itself
-- row-level secured for this role — so a day whose parent belongs to another
-- company is invisible here for exactly the same reason its parent is, and a
-- day cannot be inserted under a schedule the caller cannot see.
CREATE POLICY "tenant_isolation" ON "work_schedule_days"
  USING (EXISTS (SELECT 1 FROM "work_schedules" s WHERE s."id" = "work_schedule_id"))
  WITH CHECK (EXISTS (SELECT 1 FROM "work_schedules" s WHERE s."id" = "work_schedule_id"));

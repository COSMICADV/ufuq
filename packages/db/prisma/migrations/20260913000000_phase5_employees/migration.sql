-- ===========================================================================
-- Phase 5 — employees (DOCUMENT 06 §3.6, DOCUMENT 09 §6, DOCUMENT 25 Phase 5)
--
-- MIGRATION IMPLICATIONS — DOCUMENT 27 RULE 31
--
--   What data exists:   `employees` does not exist yet, so there is no data to
--                       migrate. `departments` gains one nullable column,
--                       `manager_employee_id`; every existing department row
--                       gets NULL, which is exactly the state it was in
--                       before (no department had a manager to record).
--                       Existing `users` rows (the seed's demo admin) are
--                       untouched and simply have no employee record, which
--                       `employees.user_id` being nullable allows.
--   In-flight records:  none. Nothing reads or writes `employees` until the
--                       endpoints in this phase are deployed alongside it.
--   Reversibility:      reversible while `employees` is empty — drop the
--                       two triggers and their functions, the
--                       `departments.manager_employee_id` column, the
--                       `employees` table and the `employee_status` type. The
--                       seven values added to `audit_action` are not
--                       reversible (PostgreSQL cannot remove an enum value);
--                       that is intentional, for the same reason as in
--                       Phase 4: an audit action that has been written must
--                       stay readable forever (DOCUMENT 21, append-only).
--
-- `ALTER TYPE … ADD VALUE` is safe inside the migration transaction on
-- PostgreSQL 12+ because nothing in this file uses the new values.
--
-- Salary and leave allowances are deliberately absent (approved Phase 5
-- decision): `employee_salaries` arrives with Phase 11 and `leave_balances`
-- with Phase 10, each as an enforced reference rather than a column added
-- here ahead of the table it belongs to.
-- ===========================================================================

CREATE TYPE "employee_status" AS ENUM ('active', 'inactive', 'terminated');

-- DOCUMENT 21 "Employees". `employee.salary_changed` is not added: nothing in
-- Phase 5 can raise it.
ALTER TYPE "audit_action" ADD VALUE 'employee.created';
ALTER TYPE "audit_action" ADD VALUE 'employee.updated';
ALTER TYPE "audit_action" ADD VALUE 'employee.deactivated';
ALTER TYPE "audit_action" ADD VALUE 'employee.activated';
ALTER TYPE "audit_action" ADD VALUE 'employee.manager_changed';
ALTER TYPE "audit_action" ADD VALUE 'employee.department_changed';
ALTER TYPE "audit_action" ADD VALUE 'employee.role_changed';

-- ---------------------------------------------------------------------------
-- employees — DOCUMENT 06 §3.6
--
-- Separate from `users` because employment data outlives and differs from
-- login identity. `phone` is VARCHAR(32): DOCUMENT 06 names the type without
-- a length, and 32 holds any E.164 number with the spaces and dashes people
-- actually type.
-- ---------------------------------------------------------------------------
CREATE TABLE "employees" (
  "id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "user_id" UUID,
  "employee_code" VARCHAR(50) NOT NULL,
  "first_name" VARCHAR(100) NOT NULL,
  "last_name" VARCHAR(100) NOT NULL,
  "photo_path" VARCHAR(500),
  "email" VARCHAR(255),
  "phone" VARCHAR(32),
  "department_id" UUID,
  "position_id" UUID,
  "manager_id" UUID,
  "work_schedule_id" UUID NOT NULL,
  "joining_date" DATE NOT NULL,
  "status" "employee_status" NOT NULL DEFAULT 'active',
  "termination_date" DATE,
  "created_by" UUID,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  "deleted_at" TIMESTAMPTZ(3),
  CONSTRAINT "employees_pkey" PRIMARY KEY ("id"),
  -- DOCUMENT 08 §4.3: `manager_id ≠ self`. Longer cycles need a walk and are
  -- rejected by the service (DOCUMENT 06 §3.6: "cycle prevention enforced in
  -- the service layer").
  CONSTRAINT "employees_manager_not_self" CHECK ("manager_id" IS NULL OR "manager_id" <> "id")
);

-- DOCUMENT 06 §5: RESTRICT for anything historical, SET NULL for optional
-- references such as `manager_id`.
ALTER TABLE "employees"
  ADD CONSTRAINT "employees_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "employees"
  ADD CONSTRAINT "employees_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "employees"
  ADD CONSTRAINT "employees_department_id_fkey"
  FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "employees"
  ADD CONSTRAINT "employees_position_id_fkey"
  FOREIGN KEY ("position_id") REFERENCES "positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "employees"
  ADD CONSTRAINT "employees_manager_id_fkey"
  FOREIGN KEY ("manager_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "employees"
  ADD CONSTRAINT "employees_work_schedule_id_fkey"
  FOREIGN KEY ("work_schedule_id") REFERENCES "work_schedules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- DOCUMENT 06 §3.6 indexes, plus the two uniqueness rules DOCUMENT 08 §4.3
-- validates: `employee_code` and `email` are each unique per company.
CREATE UNIQUE INDEX "employees_company_id_employee_code_key" ON "employees"("company_id", "employee_code");
CREATE UNIQUE INDEX "employees_company_id_email_key" ON "employees"("company_id", "email");
-- DOCUMENT 06 §4: `employees 1─1 users (optional)`.
CREATE UNIQUE INDEX "employees_user_id_key" ON "employees"("user_id");
CREATE INDEX "employees_company_id_status_idx" ON "employees"("company_id", "status");
CREATE INDEX "employees_company_id_department_id_idx" ON "employees"("company_id", "department_id");
CREATE INDEX "employees_manager_id_idx" ON "employees"("manager_id");

-- ---------------------------------------------------------------------------
-- departments.manager_employee_id — DOCUMENT 06 §3.4, approved Phase 4
-- decision: it arrives now, as an enforced reference.
-- ---------------------------------------------------------------------------
ALTER TABLE "departments" ADD COLUMN "manager_employee_id" UUID;

ALTER TABLE "departments"
  ADD CONSTRAINT "departments_manager_employee_id_fkey"
  FOREIGN KEY ("manager_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "departments_manager_employee_id_idx" ON "departments"("manager_employee_id");

-- ===========================================================================
-- Same-company references — DOCUMENT 06 §3.6 ("manager_id must belong to the
-- same company"), DOCUMENT 07 §9 invariant 7 ("no row in any business table
-- has a company_id differing from the company_id of any row it references").
--
-- A foreign key alone does not enforce this, and in a row-level-secured
-- database it is worth being precise about why: PostgreSQL runs referential
-- integrity checks without applying row security, so an INSERT naming another
-- company's department satisfies the foreign key even though the inserting
-- role cannot see that department. The service layer checks every reference
-- first (DOCUMENT 08 §5.3); these triggers are what make a forgotten check a
-- refused write instead of a cross-tenant link.
--
-- SQLSTATE 23503 (foreign_key_violation) is used because that is what this is.
-- ===========================================================================
CREATE OR REPLACE FUNCTION "employees_enforce_same_company"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."user_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "users" u WHERE u."id" = NEW."user_id" AND u."company_id" = NEW."company_id"
  ) THEN
    RAISE EXCEPTION 'employees.user_id must reference a user in the same company'
      USING ERRCODE = '23503', CONSTRAINT = 'employees_same_company';
  END IF;

  IF NEW."department_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "departments" d WHERE d."id" = NEW."department_id" AND d."company_id" = NEW."company_id"
  ) THEN
    RAISE EXCEPTION 'employees.department_id must reference a department in the same company'
      USING ERRCODE = '23503', CONSTRAINT = 'employees_same_company';
  END IF;

  IF NEW."position_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "positions" p WHERE p."id" = NEW."position_id" AND p."company_id" = NEW."company_id"
  ) THEN
    RAISE EXCEPTION 'employees.position_id must reference a position in the same company'
      USING ERRCODE = '23503', CONSTRAINT = 'employees_same_company';
  END IF;

  IF NEW."manager_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "employees" m WHERE m."id" = NEW."manager_id" AND m."company_id" = NEW."company_id"
  ) THEN
    RAISE EXCEPTION 'employees.manager_id must reference an employee in the same company'
      USING ERRCODE = '23503', CONSTRAINT = 'employees_same_company';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "work_schedules" s WHERE s."id" = NEW."work_schedule_id" AND s."company_id" = NEW."company_id"
  ) THEN
    RAISE EXCEPTION 'employees.work_schedule_id must reference a work schedule in the same company'
      USING ERRCODE = '23503', CONSTRAINT = 'employees_same_company';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER "employees_same_company"
  BEFORE INSERT OR UPDATE OF "company_id", "user_id", "department_id", "position_id", "manager_id", "work_schedule_id"
  ON "employees"
  FOR EACH ROW
  EXECUTE FUNCTION "employees_enforce_same_company"();

CREATE OR REPLACE FUNCTION "departments_enforce_same_company"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."manager_employee_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "employees" e WHERE e."id" = NEW."manager_employee_id" AND e."company_id" = NEW."company_id"
  ) THEN
    RAISE EXCEPTION 'departments.manager_employee_id must reference an employee in the same company'
      USING ERRCODE = '23503', CONSTRAINT = 'departments_same_company';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER "departments_same_company"
  BEFORE INSERT OR UPDATE OF "company_id", "manager_employee_id"
  ON "departments"
  FOR EACH ROW
  EXECUTE FUNCTION "departments_enforce_same_company"();

-- ===========================================================================
-- Least privilege — DOCUMENT 20 §3. Written out rather than inherited from
-- the Phase 3 default privileges, so the grant is readable where the table is
-- created.
-- ===========================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON "employees" TO "ufuq_app";

-- ===========================================================================
-- Row-level security — AD-03, DOCUMENT 20 §3, DOCUMENT 27 RULE 10.
-- `packages/db/test/phase5-rls.test.ts` proves the policy against queries
-- with no WHERE clause.
-- ===========================================================================
ALTER TABLE "employees" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "employees" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "employees"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

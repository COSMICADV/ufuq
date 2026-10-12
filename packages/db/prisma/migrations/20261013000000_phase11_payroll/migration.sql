-- ===========================================================================
-- Phase 11 — salary and payroll (DOCUMENT 06 §3.21–3.26, DOCUMENT 15,
-- DOCUMENT 25 Phase 11, OD-06 B, OD-07 A, OD-08 A)
--
-- MIGRATION IMPLICATIONS — DOCUMENT 27 RULE 31
--
--   What data exists:   every table here is new. No existing table or row is
--                       altered. `audit_action` gains DOCUMENT 21's payroll
--                       actions and `employee.salary_changed`.
--   Backfill:           none. No salary policy is seeded (approved decision:
--                       a company has no policy until an ADMIN saves one, and
--                       salaries and payroll are refused until then). No
--                       salary row is backfilled: Phase 5 created employees
--                       without one, and an ADMIN sets each salary.
--   In-flight records:  none. Nothing reads or writes these tables until the
--                       Phase 11 endpoints are deployed with this file.
--   Reversibility:      reversible while the payroll tables are empty: drop the
--                       triggers, functions, tables and types. Once a period
--                       has been finalized it must never be reversed (DOCUMENT
--                       15 rule 1). The added `audit_action` values are not
--                       reversible (PostgreSQL cannot remove an enum value);
--                       as in Phases 4–10 that is intentional.
--
-- Columns DOCUMENT 06 does not name, each required by a documented rule:
--
--   * `created_at` / `updated_at` — DOCUMENT 06 §1.6.
--   * `payroll_periods.total_attendance_adjustment` — DOCUMENT 04's run
--     summary shows the attendance adjustment, and DOCUMENT 15 "totals must
--     equal the lines" needs it stored next to the other totals.
--   * `idempotency_keys` — DOCUMENT 08 §8: generation, deductions and bonuses
--     (and, by DOCUMENT 15 "all create endpoints", adjustments and salary
--     changes) replay a repeated `Idempotency-Key` instead of duplicating.
--
-- Immutability is enforced in the database, not only in the application
-- (DOCUMENT 15 rule 1, DOCUMENT 06 §3.24):
--
--   * a locked payroll line can be neither updated nor deleted, by anyone —
--     the trigger runs for the table owner too, and no function bypasses it;
--   * a finalized/paid/adjusted period's figures cannot change, and its
--     status only moves forward (finalized → paid → adjusted);
--   * deductions, bonuses and adjustments are append-only (no UPDATE, no
--     DELETE), deductions and bonuses only on an editable line, adjustments
--     only on a locked one;
--   * a salary row's amount and start date never change; only an open row's
--     `effective_to` may be set, once, to close it; rows never overlap.
-- ===========================================================================

CREATE TYPE "daily_wage_basis" AS ENUM ('fixed_days', 'scheduled_working_days', 'calendar_days');
CREATE TYPE "unpaid_leave_deduction_rule" AS ENUM ('daily_wage', 'scheduled_day_wage', 'none');
CREATE TYPE "absence_deduction_rule" AS ENUM ('daily_wage', 'none');
CREATE TYPE "payroll_rounding" AS ENUM ('none', 'nearest', 'up', 'down');
CREATE TYPE "payroll_period_status" AS ENUM (
  'draft', 'under_review', 'approved', 'finalized', 'paid', 'adjusted'
);
-- `needs_review`: DOCUMENT 15 "Employee with zero attendance … flagged for
-- review — not silently paid in full".
CREATE TYPE "payroll_line_status" AS ENUM ('calculated', 'needs_review');

-- DOCUMENT 21 "Employees" (the one not yet added) and "Payroll".
ALTER TYPE "audit_action" ADD VALUE 'employee.salary_changed';
ALTER TYPE "audit_action" ADD VALUE 'payroll.generated';
ALTER TYPE "audit_action" ADD VALUE 'payroll.regenerated';
ALTER TYPE "audit_action" ADD VALUE 'payroll.submitted_for_review';
ALTER TYPE "audit_action" ADD VALUE 'payroll.approved';
ALTER TYPE "audit_action" ADD VALUE 'payroll.returned_to_draft';
ALTER TYPE "audit_action" ADD VALUE 'payroll.finalized';
ALTER TYPE "audit_action" ADD VALUE 'payroll.marked_paid';
ALTER TYPE "audit_action" ADD VALUE 'payroll.adjustment_created';
ALTER TYPE "audit_action" ADD VALUE 'deduction.added';
ALTER TYPE "audit_action" ADD VALUE 'bonus.added';
ALTER TYPE "audit_action" ADD VALUE 'salary_policy.changed';

-- ---------------------------------------------------------------------------
-- salary_policies — DOCUMENT 06 §3.22. Configuration, not code.
-- ---------------------------------------------------------------------------
CREATE TABLE "salary_policies" (
    "id"                     UUID                          NOT NULL,
    "company_id"             UUID                          NOT NULL,
    "name"                   VARCHAR(100)                  NOT NULL,
    "daily_wage_basis"       "daily_wage_basis"            NOT NULL,
    "fixed_days_value"       SMALLINT,
    "unpaid_leave_deduction" "unpaid_leave_deduction_rule" NOT NULL,
    "absence_deduction"      "absence_deduction_rule"      NOT NULL,
    "lateness_rule"          JSONB                         NOT NULL,
    "overtime_rate"          DECIMAL(5,2)                  NOT NULL,
    "rounding"               "payroll_rounding"            NOT NULL,
    "is_default"             BOOLEAN                       NOT NULL DEFAULT true,
    "created_at"             TIMESTAMPTZ(3)                NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"             TIMESTAMPTZ(3)                NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salary_policies_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "salary_policies_name_not_blank" CHECK (length(btrim("name")) > 0),
    -- The fixed divisor exists exactly when the basis is `fixed_days`.
    CONSTRAINT "salary_policies_fixed_days_matches_basis"
      CHECK (("daily_wage_basis" = 'fixed_days') = ("fixed_days_value" IS NOT NULL)),
    CONSTRAINT "salary_policies_fixed_days_range"
      CHECK ("fixed_days_value" IS NULL OR "fixed_days_value" BETWEEN 1 AND 31),
    CONSTRAINT "salary_policies_overtime_rate_non_negative" CHECK ("overtime_rate" >= 0),
    -- The three V1 lateness rules (approved decision); their parameters are
    -- validated by the application.
    CONSTRAINT "salary_policies_lateness_rule_known" CHECK (
      jsonb_typeof("lateness_rule") = 'object'
      AND "lateness_rule"->>'type' IN ('none', 'per_minute', 'fixed_per_incident')
    )
);

-- One policy per company in V1: the default one.
CREATE UNIQUE INDEX "salary_policies_one_default_per_company"
  ON "salary_policies"("company_id") WHERE "is_default";

ALTER TABLE "salary_policies" ADD CONSTRAINT "salary_policies_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- employee_salaries — DOCUMENT 06 §3.21. History, never rewritten.
-- ---------------------------------------------------------------------------
CREATE TABLE "employee_salaries" (
    "id"               UUID           NOT NULL,
    "company_id"       UUID           NOT NULL,
    "employee_id"      UUID           NOT NULL,
    "monthly_salary"   DECIMAL(15,2)  NOT NULL,
    "currency"         CHAR(3)        NOT NULL,
    "effective_from"   DATE           NOT NULL,
    "effective_to"     DATE,
    "salary_policy_id" UUID           NOT NULL,
    "created_by"       UUID           NOT NULL,
    "note"             TEXT,
    "created_at"       TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_salaries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "employee_salaries_amount_positive" CHECK ("monthly_salary" > 0),
    CONSTRAINT "employee_salaries_range_ordered"
      CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from")
);

CREATE UNIQUE INDEX "employee_salaries_employee_id_effective_from_key"
  ON "employee_salaries"("employee_id", "effective_from");
CREATE INDEX "employee_salaries_company_id_idx" ON "employee_salaries"("company_id");

ALTER TABLE "employee_salaries" ADD CONSTRAINT "employee_salaries_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "employee_salaries" ADD CONSTRAINT "employee_salaries_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "employee_salaries" ADD CONSTRAINT "employee_salaries_salary_policy_id_fkey"
  FOREIGN KEY ("salary_policy_id") REFERENCES "salary_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "employee_salaries" ADD CONSTRAINT "employee_salaries_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- payroll_periods — DOCUMENT 06 §3.23
-- ---------------------------------------------------------------------------
CREATE TABLE "payroll_periods" (
    "id"                          UUID                    NOT NULL,
    "company_id"                  UUID                    NOT NULL,
    "year"                        SMALLINT                NOT NULL,
    "month"                       SMALLINT                NOT NULL,
    "start_date"                  DATE                    NOT NULL,
    "end_date"                    DATE                    NOT NULL,
    "status"                      "payroll_period_status" NOT NULL DEFAULT 'draft',
    "generated_by"                UUID                    NOT NULL,
    "generated_at"                TIMESTAMPTZ(3)          NOT NULL,
    "finalized_by"                UUID,
    "finalized_at"                TIMESTAMPTZ(3),
    "paid_at"                     TIMESTAMPTZ(3),
    "total_gross"                 DECIMAL(15,2)           NOT NULL DEFAULT 0,
    "total_attendance_adjustment" DECIMAL(15,2)           NOT NULL DEFAULT 0,
    "total_deductions"            DECIMAL(15,2)           NOT NULL DEFAULT 0,
    "total_bonuses"               DECIMAL(15,2)           NOT NULL DEFAULT 0,
    "total_net"                   DECIMAL(15,2)           NOT NULL DEFAULT 0,
    "created_at"                  TIMESTAMPTZ(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"                  TIMESTAMPTZ(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_periods_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payroll_periods_month_range" CHECK ("month" BETWEEN 1 AND 12),
    CONSTRAINT "payroll_periods_year_range" CHECK ("year" BETWEEN 2000 AND 2999),
    CONSTRAINT "payroll_periods_range_ordered" CHECK ("end_date" >= "start_date"),
    CONSTRAINT "payroll_periods_totals_non_negative" CHECK (
      "total_gross" >= 0 AND "total_deductions" >= 0 AND "total_bonuses" >= 0 AND "total_net" >= 0
    ),
    -- Finalization facts exist exactly from finalization on.
    CONSTRAINT "payroll_periods_finalized_fields" CHECK (
      ("status" IN ('finalized', 'paid', 'adjusted'))
        = ("finalized_by" IS NOT NULL AND "finalized_at" IS NOT NULL)
    ),
    CONSTRAINT "payroll_periods_paid_requires_paid_at"
      CHECK ("status" <> 'paid' OR "paid_at" IS NOT NULL)
);

-- DOCUMENT 15 rule 4: one period per company per month.
CREATE UNIQUE INDEX "payroll_periods_company_id_year_month_key"
  ON "payroll_periods"("company_id", "year", "month");
CREATE INDEX "payroll_periods_company_id_status_idx" ON "payroll_periods"("company_id", "status");

ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_generated_by_fkey"
  FOREIGN KEY ("generated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_finalized_by_fkey"
  FOREIGN KEY ("finalized_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- payroll_lines — DOCUMENT 06 §3.24
-- ---------------------------------------------------------------------------
CREATE TABLE "payroll_lines" (
    "id"                    UUID                  NOT NULL,
    "payroll_period_id"     UUID                  NOT NULL,
    "company_id"            UUID                  NOT NULL,
    "employee_id"           UUID                  NOT NULL,
    "base_salary"           DECIMAL(15,2)         NOT NULL,
    "daily_wage"            DECIMAL(15,2)         NOT NULL,
    "working_days"          SMALLINT              NOT NULL,
    "present_days"          SMALLINT              NOT NULL,
    "wfh_days"              SMALLINT              NOT NULL,
    "absent_days"           SMALLINT              NOT NULL,
    "paid_leave_days"       SMALLINT              NOT NULL,
    "unpaid_leave_days"     SMALLINT              NOT NULL,
    "late_minutes_total"    INTEGER               NOT NULL,
    "attendance_adjustment" DECIMAL(15,2)         NOT NULL,
    "total_deductions"      DECIMAL(15,2)         NOT NULL DEFAULT 0,
    "total_bonuses"         DECIMAL(15,2)         NOT NULL DEFAULT 0,
    "net_salary"            DECIMAL(15,2)         NOT NULL,
    "status"                "payroll_line_status" NOT NULL DEFAULT 'calculated',
    "snapshot"              JSONB                 NOT NULL,
    "is_locked"             BOOLEAN               NOT NULL DEFAULT false,
    "created_at"            TIMESTAMPTZ(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"            TIMESTAMPTZ(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_lines_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payroll_lines_counts_non_negative" CHECK (
      "working_days" >= 0 AND "present_days" >= 0 AND "wfh_days" >= 0 AND "absent_days" >= 0
      AND "paid_leave_days" >= 0 AND "unpaid_leave_days" >= 0 AND "late_minutes_total" >= 0
    ),
    CONSTRAINT "payroll_lines_amounts_non_negative" CHECK (
      "base_salary" >= 0 AND "daily_wage" >= 0 AND "total_deductions" >= 0 AND "total_bonuses" >= 0
    ),
    -- OD-06 B: net salary is never negative.
    CONSTRAINT "payroll_lines_net_non_negative" CHECK ("net_salary" >= 0),
    CONSTRAINT "payroll_lines_snapshot_object" CHECK (jsonb_typeof("snapshot") = 'object')
);

CREATE UNIQUE INDEX "payroll_lines_payroll_period_id_employee_id_key"
  ON "payroll_lines"("payroll_period_id", "employee_id");
CREATE INDEX "payroll_lines_employee_id_payroll_period_id_idx"
  ON "payroll_lines"("employee_id", "payroll_period_id");
CREATE INDEX "payroll_lines_company_id_idx" ON "payroll_lines"("company_id");

ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_payroll_period_id_fkey"
  FOREIGN KEY ("payroll_period_id") REFERENCES "payroll_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- payroll_deductions / payroll_bonuses — DOCUMENT 06 §3.25. Append-only.
-- ---------------------------------------------------------------------------
CREATE TABLE "payroll_deductions" (
    "id"              UUID           NOT NULL,
    "payroll_line_id" UUID           NOT NULL,
    "company_id"      UUID           NOT NULL,
    "type"            VARCHAR(50)    NOT NULL,
    "amount"          DECIMAL(15,2)  NOT NULL,
    "reason"          TEXT           NOT NULL,
    "created_by"      UUID           NOT NULL,
    "created_at"      TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_deductions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payroll_deductions_amount_positive" CHECK ("amount" > 0),
    CONSTRAINT "payroll_deductions_reason_length" CHECK (length(btrim("reason")) >= 3),
    CONSTRAINT "payroll_deductions_type_not_blank" CHECK (length(btrim("type")) > 0)
);
CREATE INDEX "payroll_deductions_payroll_line_id_idx" ON "payroll_deductions"("payroll_line_id");

CREATE TABLE "payroll_bonuses" (
    "id"              UUID           NOT NULL,
    "payroll_line_id" UUID           NOT NULL,
    "company_id"      UUID           NOT NULL,
    "type"            VARCHAR(50)    NOT NULL,
    "amount"          DECIMAL(15,2)  NOT NULL,
    "reason"          TEXT           NOT NULL,
    "created_by"      UUID           NOT NULL,
    "created_at"      TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_bonuses_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payroll_bonuses_amount_positive" CHECK ("amount" > 0),
    CONSTRAINT "payroll_bonuses_reason_length" CHECK (length(btrim("reason")) >= 3),
    CONSTRAINT "payroll_bonuses_type_not_blank" CHECK (length(btrim("type")) > 0)
);
CREATE INDEX "payroll_bonuses_payroll_line_id_idx" ON "payroll_bonuses"("payroll_line_id");

ALTER TABLE "payroll_deductions" ADD CONSTRAINT "payroll_deductions_payroll_line_id_fkey"
  FOREIGN KEY ("payroll_line_id") REFERENCES "payroll_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payroll_deductions" ADD CONSTRAINT "payroll_deductions_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payroll_deductions" ADD CONSTRAINT "payroll_deductions_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payroll_bonuses" ADD CONSTRAINT "payroll_bonuses_payroll_line_id_fkey"
  FOREIGN KEY ("payroll_line_id") REFERENCES "payroll_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payroll_bonuses" ADD CONSTRAINT "payroll_bonuses_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payroll_bonuses" ADD CONSTRAINT "payroll_bonuses_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- payroll_adjustments — DOCUMENT 06 §3.26. The only legal way to change a
-- finalized outcome; the original line is never touched.
-- ---------------------------------------------------------------------------
CREATE TABLE "payroll_adjustments" (
    "id"                       UUID           NOT NULL,
    "original_payroll_line_id" UUID           NOT NULL,
    "company_id"               UUID           NOT NULL,
    "employee_id"              UUID           NOT NULL,
    "amount"                   DECIMAL(15,2)  NOT NULL,
    "reason"                   TEXT           NOT NULL,
    "created_by"               UUID           NOT NULL,
    "created_at"               TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- DOCUMENT 06 names these; no approval step for adjustments is documented,
    -- so V1 leaves them empty rather than inventing one.
    "approved_by"              UUID,
    "approved_at"              TIMESTAMPTZ(3),

    CONSTRAINT "payroll_adjustments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payroll_adjustments_amount_not_zero" CHECK ("amount" <> 0),
    CONSTRAINT "payroll_adjustments_reason_length" CHECK (length(btrim("reason")) >= 3)
);
CREATE INDEX "payroll_adjustments_original_payroll_line_id_idx"
  ON "payroll_adjustments"("original_payroll_line_id");
CREATE INDEX "payroll_adjustments_employee_id_idx" ON "payroll_adjustments"("employee_id");

ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_original_payroll_line_id_fkey"
  FOREIGN KEY ("original_payroll_line_id") REFERENCES "payroll_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_approved_by_fkey"
  FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- idempotency_keys — DOCUMENT 08 §8. One row per (company, user, endpoint,
-- key); a repeat within 24 hours replays the stored resource.
-- ---------------------------------------------------------------------------
CREATE TABLE "idempotency_keys" (
    "id"           UUID           NOT NULL,
    "company_id"   UUID           NOT NULL,
    "user_id"      UUID           NOT NULL,
    "scope"        VARCHAR(100)   NOT NULL,
    "key"          VARCHAR(255)   NOT NULL,
    "request_hash" CHAR(64)       NOT NULL,
    "resource_id"  UUID           NOT NULL,
    "created_at"   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "idempotency_keys_key_not_blank" CHECK (length(btrim("key")) > 0)
);
CREATE UNIQUE INDEX "idempotency_keys_company_id_user_id_scope_key_key"
  ON "idempotency_keys"("company_id", "user_id", "scope", "key");

ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- Same-company references — DOCUMENT 07 §9 invariant 7, as in Phases 5–10.
-- ===========================================================================
CREATE OR REPLACE FUNCTION "payroll_assert_same_company"(
  tbl TEXT, col TEXT, ref_table TEXT, ref_id UUID, company UUID
) RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  found BOOLEAN;
BEGIN
  IF ref_id IS NULL THEN
    RETURN;
  END IF;
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE "id" = $1 AND "company_id" = $2)', ref_table)
    INTO found USING ref_id, company;
  IF NOT found THEN
    RAISE EXCEPTION '%.% must reference a % row in the same company', tbl, col, ref_table
      USING ERRCODE = '23503', CONSTRAINT = tbl || '_same_company';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION "employee_salaries_enforce_same_company"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "payroll_assert_same_company"('employee_salaries', 'employee_id', 'employees', NEW."employee_id", NEW."company_id");
  PERFORM "payroll_assert_same_company"('employee_salaries', 'salary_policy_id', 'salary_policies', NEW."salary_policy_id", NEW."company_id");
  PERFORM "payroll_assert_same_company"('employee_salaries', 'created_by', 'users', NEW."created_by", NEW."company_id");
  RETURN NEW;
END
$$;
CREATE TRIGGER "employee_salaries_same_company"
  BEFORE INSERT OR UPDATE OF "company_id", "employee_id", "salary_policy_id", "created_by"
  ON "employee_salaries" FOR EACH ROW EXECUTE FUNCTION "employee_salaries_enforce_same_company"();

CREATE OR REPLACE FUNCTION "payroll_periods_enforce_same_company"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "payroll_assert_same_company"('payroll_periods', 'generated_by', 'users', NEW."generated_by", NEW."company_id");
  PERFORM "payroll_assert_same_company"('payroll_periods', 'finalized_by', 'users', NEW."finalized_by", NEW."company_id");
  RETURN NEW;
END
$$;
CREATE TRIGGER "payroll_periods_same_company"
  BEFORE INSERT OR UPDATE OF "company_id", "generated_by", "finalized_by"
  ON "payroll_periods" FOR EACH ROW EXECUTE FUNCTION "payroll_periods_enforce_same_company"();

CREATE OR REPLACE FUNCTION "payroll_lines_enforce_same_company"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "payroll_assert_same_company"('payroll_lines', 'payroll_period_id', 'payroll_periods', NEW."payroll_period_id", NEW."company_id");
  PERFORM "payroll_assert_same_company"('payroll_lines', 'employee_id', 'employees', NEW."employee_id", NEW."company_id");
  RETURN NEW;
END
$$;
CREATE TRIGGER "payroll_lines_same_company"
  BEFORE INSERT OR UPDATE OF "company_id", "payroll_period_id", "employee_id"
  ON "payroll_lines" FOR EACH ROW EXECUTE FUNCTION "payroll_lines_enforce_same_company"();

CREATE OR REPLACE FUNCTION "payroll_entries_enforce_same_company"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "payroll_assert_same_company"(TG_TABLE_NAME, 'payroll_line_id', 'payroll_lines', NEW."payroll_line_id", NEW."company_id");
  PERFORM "payroll_assert_same_company"(TG_TABLE_NAME, 'created_by', 'users', NEW."created_by", NEW."company_id");
  RETURN NEW;
END
$$;
CREATE TRIGGER "payroll_deductions_same_company"
  BEFORE INSERT ON "payroll_deductions" FOR EACH ROW EXECUTE FUNCTION "payroll_entries_enforce_same_company"();
CREATE TRIGGER "payroll_bonuses_same_company"
  BEFORE INSERT ON "payroll_bonuses" FOR EACH ROW EXECUTE FUNCTION "payroll_entries_enforce_same_company"();

CREATE OR REPLACE FUNCTION "payroll_adjustments_enforce_same_company"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "payroll_assert_same_company"('payroll_adjustments', 'original_payroll_line_id', 'payroll_lines', NEW."original_payroll_line_id", NEW."company_id");
  PERFORM "payroll_assert_same_company"('payroll_adjustments', 'employee_id', 'employees', NEW."employee_id", NEW."company_id");
  PERFORM "payroll_assert_same_company"('payroll_adjustments', 'created_by', 'users', NEW."created_by", NEW."company_id");
  PERFORM "payroll_assert_same_company"('payroll_adjustments', 'approved_by', 'users', NEW."approved_by", NEW."company_id");
  RETURN NEW;
END
$$;
CREATE TRIGGER "payroll_adjustments_same_company"
  BEFORE INSERT ON "payroll_adjustments" FOR EACH ROW EXECUTE FUNCTION "payroll_adjustments_enforce_same_company"();

CREATE OR REPLACE FUNCTION "idempotency_keys_enforce_same_company"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "payroll_assert_same_company"('idempotency_keys', 'user_id', 'users', NEW."user_id", NEW."company_id");
  RETURN NEW;
END
$$;
CREATE TRIGGER "idempotency_keys_same_company"
  BEFORE INSERT OR UPDATE OF "company_id", "user_id"
  ON "idempotency_keys" FOR EACH ROW EXECUTE FUNCTION "idempotency_keys_enforce_same_company"();

-- ===========================================================================
-- Salary history — DOCUMENT 06 §3.21, DOCUMENT 15 rule 8.
-- ===========================================================================
CREATE OR REPLACE FUNCTION "employee_salaries_guard_history"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Only closing an open row is allowed: its amount, start, employee,
    -- policy and currency are history.
    IF NEW."monthly_salary" IS DISTINCT FROM OLD."monthly_salary"
       OR NEW."effective_from" IS DISTINCT FROM OLD."effective_from"
       OR NEW."employee_id" IS DISTINCT FROM OLD."employee_id"
       OR NEW."company_id" IS DISTINCT FROM OLD."company_id"
       OR NEW."currency" IS DISTINCT FROM OLD."currency"
       OR NEW."salary_policy_id" IS DISTINCT FROM OLD."salary_policy_id"
       OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
       OR NEW."note" IS DISTINCT FROM OLD."note"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
      RAISE EXCEPTION 'employee_salaries rows are history: only effective_to may be set'
        USING ERRCODE = '42501';
    END IF;
    IF OLD."effective_to" IS NOT NULL THEN
      RAISE EXCEPTION 'employee_salaries row % is already closed', OLD."id"
        USING ERRCODE = '42501';
    END IF;
  END IF;
  -- No two rows of one employee may overlap.
  IF EXISTS (
    SELECT 1 FROM "employee_salaries" s
    WHERE s."employee_id" = NEW."employee_id"
      AND s."id" <> NEW."id"
      AND s."effective_from" <= COALESCE(NEW."effective_to", DATE '9999-12-31')
      AND COALESCE(s."effective_to", DATE '9999-12-31') >= NEW."effective_from"
  ) THEN
    RAISE EXCEPTION 'employee_salaries rows of one employee may not overlap'
      USING ERRCODE = '23P01', CONSTRAINT = 'employee_salaries_no_overlap';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "employee_salaries_history"
  BEFORE INSERT OR UPDATE ON "employee_salaries"
  FOR EACH ROW EXECUTE FUNCTION "employee_salaries_guard_history"();

-- ===========================================================================
-- Immutability — DOCUMENT 15 rules 1–2, DOCUMENT 06 §3.24.
--
-- These triggers fire for every role, the table owner included. There is no
-- SECURITY DEFINER function that touches these tables, so the application
-- role has no route around them.
-- ===========================================================================

-- A locked line is frozen: no UPDATE, no DELETE. Before that, a line follows
-- its period: it is created and removed only in a draft period, edited only in
-- a draft or under-review one, and locked exactly once, by finalization of an
-- approved period, in an update that changes nothing but the lock and the
-- final snapshot.
CREATE OR REPLACE FUNCTION "payroll_lines_guard_lock"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  period_status "payroll_period_status";
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT p."status" INTO period_status FROM "payroll_periods" p WHERE p."id" = NEW."payroll_period_id";
    IF NEW."is_locked" OR period_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'payroll lines are created unlocked, in a draft period' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."is_locked" THEN
    RAISE EXCEPTION 'payroll line % is locked: finalized payroll is immutable', OLD."id"
      USING ERRCODE = '42501', HINT = 'Create a payroll adjustment instead.';
  END IF;
  SELECT p."status" INTO period_status FROM "payroll_periods" p WHERE p."id" = OLD."payroll_period_id";
  IF TG_OP = 'DELETE' THEN
    IF period_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'payroll line % can only be removed from a draft period', OLD."id"
        USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."is_locked" THEN
    IF period_status IS DISTINCT FROM 'approved'
       OR NEW."payroll_period_id" IS DISTINCT FROM OLD."payroll_period_id"
       OR NEW."company_id" IS DISTINCT FROM OLD."company_id"
       OR NEW."employee_id" IS DISTINCT FROM OLD."employee_id"
       OR NEW."base_salary" IS DISTINCT FROM OLD."base_salary"
       OR NEW."daily_wage" IS DISTINCT FROM OLD."daily_wage"
       OR NEW."working_days" IS DISTINCT FROM OLD."working_days"
       OR NEW."present_days" IS DISTINCT FROM OLD."present_days"
       OR NEW."wfh_days" IS DISTINCT FROM OLD."wfh_days"
       OR NEW."absent_days" IS DISTINCT FROM OLD."absent_days"
       OR NEW."paid_leave_days" IS DISTINCT FROM OLD."paid_leave_days"
       OR NEW."unpaid_leave_days" IS DISTINCT FROM OLD."unpaid_leave_days"
       OR NEW."late_minutes_total" IS DISTINCT FROM OLD."late_minutes_total"
       OR NEW."attendance_adjustment" IS DISTINCT FROM OLD."attendance_adjustment"
       OR NEW."total_deductions" IS DISTINCT FROM OLD."total_deductions"
       OR NEW."total_bonuses" IS DISTINCT FROM OLD."total_bonuses"
       OR NEW."net_salary" IS DISTINCT FROM OLD."net_salary"
       OR NEW."status" IS DISTINCT FROM OLD."status" THEN
      RAISE EXCEPTION 'payroll line % can only be locked unchanged, by finalizing an approved period', OLD."id"
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF period_status NOT IN ('draft', 'under_review') THEN
    RAISE EXCEPTION 'payroll line % is not editable while its period is %', OLD."id", period_status
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "payroll_lines_lock"
  BEFORE INSERT OR UPDATE OR DELETE ON "payroll_lines"
  FOR EACH ROW EXECUTE FUNCTION "payroll_lines_guard_lock"();

-- A finalized period's figures never change, and its status only moves
-- forward: finalized → paid → adjusted, finalized → adjusted. `paid_at` may be
-- set once (approved decision: an Adjusted period not yet paid may still be
-- marked paid, keeping the Adjusted status).
CREATE OR REPLACE FUNCTION "payroll_periods_guard_final"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payroll periods are never deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD."status" IN ('finalized', 'paid', 'adjusted') THEN
    IF NEW."year" IS DISTINCT FROM OLD."year" OR NEW."month" IS DISTINCT FROM OLD."month"
       OR NEW."company_id" IS DISTINCT FROM OLD."company_id"
       OR NEW."start_date" IS DISTINCT FROM OLD."start_date" OR NEW."end_date" IS DISTINCT FROM OLD."end_date"
       OR NEW."generated_by" IS DISTINCT FROM OLD."generated_by" OR NEW."generated_at" IS DISTINCT FROM OLD."generated_at"
       OR NEW."finalized_by" IS DISTINCT FROM OLD."finalized_by" OR NEW."finalized_at" IS DISTINCT FROM OLD."finalized_at"
       OR NEW."total_gross" IS DISTINCT FROM OLD."total_gross"
       OR NEW."total_attendance_adjustment" IS DISTINCT FROM OLD."total_attendance_adjustment"
       OR NEW."total_deductions" IS DISTINCT FROM OLD."total_deductions"
       OR NEW."total_bonuses" IS DISTINCT FROM OLD."total_bonuses"
       OR NEW."total_net" IS DISTINCT FROM OLD."total_net" THEN
      RAISE EXCEPTION 'payroll period % is finalized: its figures are immutable', OLD."id"
        USING ERRCODE = '42501';
    END IF;
    IF OLD."paid_at" IS NOT NULL AND NEW."paid_at" IS DISTINCT FROM OLD."paid_at" THEN
      RAISE EXCEPTION 'payroll period % is already marked paid', OLD."id" USING ERRCODE = '42501';
    END IF;
    IF NOT (
      NEW."status" = OLD."status"
      OR (OLD."status" = 'finalized' AND NEW."status" IN ('paid', 'adjusted'))
      OR (OLD."status" = 'paid' AND NEW."status" = 'adjusted')
    ) THEN
      RAISE EXCEPTION 'payroll period % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = '42501';
    END IF;
  ELSIF NEW."status" = 'finalized' THEN
    -- Finalization: every line must already be locked, and the move is only
    -- from approved.
    IF OLD."status" <> 'approved' THEN
      RAISE EXCEPTION 'payroll period % can only be finalized from approved', OLD."id"
        USING ERRCODE = '42501';
    END IF;
    IF EXISTS (
      SELECT 1 FROM "payroll_lines" l WHERE l."payroll_period_id" = OLD."id" AND NOT l."is_locked"
    ) THEN
      RAISE EXCEPTION 'payroll period % has unlocked lines and cannot be finalized', OLD."id"
        USING ERRCODE = '42501';
    END IF;
  ELSIF NEW."status" IN ('paid', 'adjusted') THEN
    RAISE EXCEPTION 'payroll period % must be finalized first', OLD."id" USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "payroll_periods_final"
  BEFORE UPDATE OR DELETE ON "payroll_periods"
  FOR EACH ROW EXECUTE FUNCTION "payroll_periods_guard_final"();

-- Deductions and bonuses only on an editable line: unlocked, in a draft or
-- under-review period (DOCUMENT 15 "PAYROLL STATES").
CREATE OR REPLACE FUNCTION "payroll_entries_guard_editable"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "payroll_lines" l
    JOIN "payroll_periods" p ON p."id" = l."payroll_period_id"
    WHERE l."id" = NEW."payroll_line_id"
      AND NOT l."is_locked"
      AND p."status" IN ('draft', 'under_review')
  ) THEN
    RAISE EXCEPTION 'payroll line % is not editable', NEW."payroll_line_id"
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "payroll_deductions_editable"
  BEFORE INSERT ON "payroll_deductions" FOR EACH ROW EXECUTE FUNCTION "payroll_entries_guard_editable"();
CREATE TRIGGER "payroll_bonuses_editable"
  BEFORE INSERT ON "payroll_bonuses" FOR EACH ROW EXECUTE FUNCTION "payroll_entries_guard_editable"();

-- Adjustments only on a locked line of a finalized/paid/adjusted period, for
-- that line's own employee.
CREATE OR REPLACE FUNCTION "payroll_adjustments_guard_locked"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "payroll_lines" l
    JOIN "payroll_periods" p ON p."id" = l."payroll_period_id"
    WHERE l."id" = NEW."original_payroll_line_id"
      AND l."employee_id" = NEW."employee_id"
      AND l."is_locked"
      AND p."status" IN ('finalized', 'paid', 'adjusted')
  ) THEN
    RAISE EXCEPTION 'an adjustment needs a finalized line of the same employee'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "payroll_adjustments_locked"
  BEFORE INSERT ON "payroll_adjustments" FOR EACH ROW EXECUTE FUNCTION "payroll_adjustments_guard_locked"();

-- ===========================================================================
-- Least privilege — DOCUMENT 20 §3. Phase 3's default privileges grant
-- everything on every new table, so the REVOKEs are what do the work.
-- ===========================================================================
GRANT SELECT, INSERT, UPDATE ON "salary_policies" TO "ufuq_app";
REVOKE DELETE ON "salary_policies" FROM "ufuq_app";
GRANT SELECT, INSERT, UPDATE ON "employee_salaries" TO "ufuq_app";
REVOKE DELETE ON "employee_salaries" FROM "ufuq_app";
GRANT SELECT, INSERT, UPDATE ON "payroll_periods" TO "ufuq_app";
REVOKE DELETE ON "payroll_periods" FROM "ufuq_app";
-- DELETE is kept on lines for one purpose: regeneration of a draft removes the
-- line of an employee no longer in the period. The lock trigger refuses it for
-- any locked line, and the RESTRICT foreign keys for any line with entries.
GRANT SELECT, INSERT, UPDATE, DELETE ON "payroll_lines" TO "ufuq_app";
GRANT SELECT, INSERT ON "payroll_deductions" TO "ufuq_app";
REVOKE UPDATE, DELETE, TRUNCATE ON "payroll_deductions" FROM "ufuq_app";
GRANT SELECT, INSERT ON "payroll_bonuses" TO "ufuq_app";
REVOKE UPDATE, DELETE, TRUNCATE ON "payroll_bonuses" FROM "ufuq_app";
GRANT SELECT, INSERT ON "payroll_adjustments" TO "ufuq_app";
REVOKE UPDATE, DELETE, TRUNCATE ON "payroll_adjustments" FROM "ufuq_app";
GRANT SELECT, INSERT, UPDATE ON "idempotency_keys" TO "ufuq_app";
REVOKE DELETE ON "idempotency_keys" FROM "ufuq_app";
REVOKE TRUNCATE ON "salary_policies", "employee_salaries", "payroll_periods", "payroll_lines", "idempotency_keys" FROM "ufuq_app";

-- ===========================================================================
-- Row-level security — AD-03, DOCUMENT 20 §3, DOCUMENT 27 RULE 10.
-- `packages/db/test/phase11-rls.test.ts` proves every policy.
-- ===========================================================================
ALTER TABLE "salary_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "salary_policies" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "salary_policies"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

ALTER TABLE "employee_salaries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "employee_salaries" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "employee_salaries"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

ALTER TABLE "payroll_periods" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payroll_periods" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "payroll_periods"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

ALTER TABLE "payroll_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payroll_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "payroll_lines"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

ALTER TABLE "payroll_deductions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payroll_deductions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "payroll_deductions"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

ALTER TABLE "payroll_bonuses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payroll_bonuses" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "payroll_bonuses"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

ALTER TABLE "payroll_adjustments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payroll_adjustments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "payroll_adjustments"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

ALTER TABLE "idempotency_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "idempotency_keys" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "idempotency_keys"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

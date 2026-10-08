-- ===========================================================================
-- Phase 10 — leave management (DOCUMENT 06 §3.12–3.14, §3.10
-- `leave_request_id`, DOCUMENT 16, DOCUMENT 25 Phase 10, OD-09, OD-11, OD-16)
--
-- MIGRATION IMPLICATIONS — DOCUMENT 27 RULE 31
--
--   What data exists:   `leave_types`, `leave_balances` and `leave_requests`
--                       are new. Two existing tables are altered:
--                       `attendance_records` gains a nullable
--                       `leave_request_id` (every existing row gets NULL — no
--                       leave existed), and `attachments.related_type` gains
--                       'leave_request'. The Phase 9 `requests` same-company
--                       function is replaced: its temporary refusal of leave
--                       rows becomes the real same-company / same-employee
--                       check against `leave_requests`.
--   Backfill:           every existing company receives DOCUMENT 16's five
--                       starting leave types (Annual, Sick, Emergency, Unpaid,
--                       Other). Companies created later receive the same rows
--                       from a trigger on `companies`. Allowances start at 0
--                       (approved decision: no invented figures); an ADMIN
--                       sets them in /admin/settings/leave-types. No balance
--                       is backfilled: balances are created on first need,
--                       pro-rated for the year (OD-16), by the application.
--   In-flight records:  none. Nothing reads or writes the new tables until the
--                       Phase 10 endpoints are deployed alongside this file.
--   Reversibility:      reversible while the leave tables are empty — drop the
--                       two leave index triggers, restore the Phase 9
--                       `requests_enforce_same_company` body, drop
--                       `attendance_records.leave_request_id` and its trigger,
--                       restore the attachments CHECK, drop the company
--                       trigger, the three tables and the two new types. The
--                       seven values added to `audit_action` are not reversible
--                       (PostgreSQL cannot remove an enum value); as in Phases
--                       4–9 that is intentional.
--
-- `ALTER TYPE … ADD VALUE` is safe inside the migration transaction on
-- PostgreSQL 12+ because nothing in this file uses the new values.
--
-- Columns DOCUMENT 06 does not name, each required by a documented rule:
--
--   * `leave_requests.year_allocation` — DOCUMENT 16 "Leave spanning two
--     years: each year's balance is charged its portion". The days held at
--     submission per year are recorded so approval, rejection and
--     cancellation move exactly the days that were held.
--   * `leave_balances.carry_over_applied_at` — DOCUMENT 16 rule 13 carry-over
--     must be idempotent and safe to rerun: the job writes a year's carried
--     days once and marks the row, so a rerun (or a later manual adjustment)
--     is never overwritten.
--   * `created_at` / `updated_at` on the three tables — DOCUMENT 06 §1.6.
--
-- See docs/PHASE-10-STATUS.md.
-- ===========================================================================

CREATE TYPE "leave_carry_over_policy" AS ENUM ('none', 'full', 'capped');

CREATE TYPE "leave_request_status" AS ENUM ('pending', 'approved', 'rejected', 'cancelled');

-- DOCUMENT 21 "Leave".
ALTER TYPE "audit_action" ADD VALUE 'leave.requested';
ALTER TYPE "audit_action" ADD VALUE 'leave.approved';
ALTER TYPE "audit_action" ADD VALUE 'leave.rejected';
ALTER TYPE "audit_action" ADD VALUE 'leave.cancelled';
ALTER TYPE "audit_action" ADD VALUE 'leave.balance_adjusted';
ALTER TYPE "audit_action" ADD VALUE 'leave_type.created';
ALTER TYPE "audit_action" ADD VALUE 'leave_type.updated';

-- ---------------------------------------------------------------------------
-- leave_types — DOCUMENT 06 §3.12
-- ---------------------------------------------------------------------------
CREATE TABLE "leave_types" (
    "id"                      UUID                      NOT NULL,
    "company_id"              UUID                      NOT NULL,
    "name_ar"                 VARCHAR(100)              NOT NULL,
    "name_en"                 VARCHAR(100)              NOT NULL,
    "is_paid"                 BOOLEAN                   NOT NULL DEFAULT true,
    "default_days_per_year"   DECIMAL(5,2)              NOT NULL DEFAULT 0,
    "requires_attachment"     BOOLEAN                   NOT NULL DEFAULT false,
    "allows_negative_balance" BOOLEAN                   NOT NULL DEFAULT false,
    "carry_over_policy"       "leave_carry_over_policy" NOT NULL DEFAULT 'none',
    "carry_over_cap"          DECIMAL(5,2),
    "created_at"              TIMESTAMPTZ(3)            NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"              TIMESTAMPTZ(3)            NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at"              TIMESTAMPTZ(3),

    CONSTRAINT "leave_types_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "leave_types_names_not_blank"
      CHECK (length(btrim("name_ar")) > 0 AND length(btrim("name_en")) > 0),
    CONSTRAINT "leave_types_default_days_non_negative" CHECK ("default_days_per_year" >= 0),
    -- A cap exists exactly when the policy is "capped" (DOCUMENT 16 rule 13).
    CONSTRAINT "leave_types_cap_matches_policy"
      CHECK (("carry_over_policy" = 'capped') = ("carry_over_cap" IS NOT NULL)),
    CONSTRAINT "leave_types_cap_non_negative"
      CHECK ("carry_over_cap" IS NULL OR "carry_over_cap" >= 0)
);

CREATE INDEX "leave_types_company_id_idx" ON "leave_types"("company_id");

ALTER TABLE "leave_types" ADD CONSTRAINT "leave_types_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- leave_balances — DOCUMENT 06 §3.13. Remaining is computed, never stored.
-- ---------------------------------------------------------------------------
CREATE TABLE "leave_balances" (
    "id"                    UUID           NOT NULL,
    "company_id"            UUID           NOT NULL,
    "employee_id"           UUID           NOT NULL,
    "leave_type_id"         UUID           NOT NULL,
    "year"                  SMALLINT       NOT NULL,
    "total_days"            DECIMAL(5,2)   NOT NULL DEFAULT 0,
    "used_days"             DECIMAL(5,2)   NOT NULL DEFAULT 0,
    "pending_days"          DECIMAL(5,2)   NOT NULL DEFAULT 0,
    "carried_over_days"     DECIMAL(5,2)   NOT NULL DEFAULT 0,
    "carry_over_applied_at" TIMESTAMPTZ(3),
    "created_at"            TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"            TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leave_balances_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "leave_balances_year_range" CHECK ("year" BETWEEN 2000 AND 2999),
    CONSTRAINT "leave_balances_non_negative" CHECK (
      "total_days" >= 0 AND "used_days" >= 0 AND "pending_days" >= 0 AND "carried_over_days" >= 0
    )
);

CREATE UNIQUE INDEX "leave_balances_employee_id_leave_type_id_year_key"
  ON "leave_balances"("employee_id", "leave_type_id", "year");
CREATE INDEX "leave_balances_company_id_year_idx" ON "leave_balances"("company_id", "year");

ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_leave_type_id_fkey"
  FOREIGN KEY ("leave_type_id") REFERENCES "leave_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- leave_requests — DOCUMENT 06 §3.14
-- ---------------------------------------------------------------------------
CREATE TABLE "leave_requests" (
    "id"              UUID                   NOT NULL,
    "company_id"      UUID                   NOT NULL,
    "employee_id"     UUID                   NOT NULL,
    "leave_type_id"   UUID                   NOT NULL,
    "start_date"      DATE                   NOT NULL,
    "end_date"        DATE                   NOT NULL,
    "days_count"      DECIMAL(5,2)           NOT NULL,
    "year_allocation" JSONB                  NOT NULL,
    "reason"          TEXT                   NOT NULL,
    "attachment_id"   UUID,
    "status"          "leave_request_status" NOT NULL DEFAULT 'pending',
    "reviewed_by"     UUID,
    "reviewed_at"     TIMESTAMPTZ(3),
    "review_note"     TEXT,
    "created_at"      TIMESTAMPTZ(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMPTZ(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "leave_requests_dates_ordered" CHECK ("end_date" >= "start_date"),
    -- DOCUMENT 16 validation: the calculated count is > 0. OD-11 (approved, A):
    -- full days only in V1, so the count is whole; the DECIMAL type keeps
    -- half days additive later.
    CONSTRAINT "leave_requests_days_positive_whole"
      CHECK ("days_count" > 0 AND "days_count" = trunc("days_count")),
    CONSTRAINT "leave_requests_allocation_object" CHECK (jsonb_typeof("year_allocation") = 'object'),
    -- DOCUMENT 16 validation: "Reason required, minimum 3 characters".
    CONSTRAINT "leave_requests_reason_length"
      CHECK (length(btrim("reason")) BETWEEN 3 AND 1000),
    CONSTRAINT "leave_requests_review_note_length"
      CHECK ("review_note" IS NULL OR length("review_note") <= 1000),
    -- A pending request names no reviewer; a decided one does. A cancelled
    -- one may (an ADMIN cancelled it after approval) or may not (the employee
    -- withdrew it while pending).
    CONSTRAINT "leave_requests_review_consistent" CHECK (
      ("status" = 'pending' AND "reviewed_by" IS NULL AND "reviewed_at" IS NULL) OR
      ("status" IN ('approved', 'rejected') AND "reviewed_by" IS NOT NULL AND "reviewed_at" IS NOT NULL) OR
      ("status" = 'cancelled')
    ),
    -- DOCUMENT 16 rule 8: "Rejection requires a reason".
    CONSTRAINT "leave_requests_rejection_has_note" CHECK (
      "status" <> 'rejected' OR length(btrim(coalesce("review_note", ''))) > 0
    )
);

-- DOCUMENT 16 "Database requirements".
CREATE INDEX "leave_requests_company_id_status_idx" ON "leave_requests"("company_id", "status");
CREATE INDEX "leave_requests_employee_id_start_date_idx" ON "leave_requests"("employee_id", "start_date");

ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_leave_type_id_fkey"
  FOREIGN KEY ("leave_type_id") REFERENCES "leave_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_reviewed_by_fkey"
  FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_attachment_id_fkey"
  FOREIGN KEY ("attachment_id") REFERENCES "attachments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- attendance_records.leave_request_id — DOCUMENT 06 §3.10, DOCUMENT 12 rule 8
-- ---------------------------------------------------------------------------
ALTER TABLE "attendance_records" ADD COLUMN "leave_request_id" UUID;
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_leave_request_id_fkey"
  FOREIGN KEY ("leave_request_id") REFERENCES "leave_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- A record written by leave is an `on_leave` day (DOCUMENT 12 rule 8).
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_leave_is_on_leave"
  CHECK ("leave_request_id" IS NULL OR "status" = 'on_leave');
CREATE INDEX "attendance_records_leave_request_id_idx" ON "attendance_records"("leave_request_id");

-- ===========================================================================
-- Same-company references — DOCUMENT 07 §9 invariant 7, as in Phases 5–9.
-- ===========================================================================
CREATE OR REPLACE FUNCTION "leave_balances_enforce_same_company"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "employees" e WHERE e."id" = NEW."employee_id" AND e."company_id" = NEW."company_id"
  ) THEN
    RAISE EXCEPTION 'leave_balances.employee_id must reference an employee in the same company'
      USING ERRCODE = '23503', CONSTRAINT = 'leave_balances_same_company';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "leave_types" t WHERE t."id" = NEW."leave_type_id" AND t."company_id" = NEW."company_id"
  ) THEN
    RAISE EXCEPTION 'leave_balances.leave_type_id must reference a leave type in the same company'
      USING ERRCODE = '23503', CONSTRAINT = 'leave_balances_same_company';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "leave_balances_same_company"
  BEFORE INSERT OR UPDATE OF "company_id", "employee_id", "leave_type_id"
  ON "leave_balances"
  FOR EACH ROW
  EXECUTE FUNCTION "leave_balances_enforce_same_company"();

CREATE OR REPLACE FUNCTION "leave_requests_enforce_same_company"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "employees" e WHERE e."id" = NEW."employee_id" AND e."company_id" = NEW."company_id"
  ) THEN
    RAISE EXCEPTION 'leave_requests.employee_id must reference an employee in the same company'
      USING ERRCODE = '23503', CONSTRAINT = 'leave_requests_same_company';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "leave_types" t WHERE t."id" = NEW."leave_type_id" AND t."company_id" = NEW."company_id"
  ) THEN
    RAISE EXCEPTION 'leave_requests.leave_type_id must reference a leave type in the same company'
      USING ERRCODE = '23503', CONSTRAINT = 'leave_requests_same_company';
  END IF;
  IF NEW."reviewed_by" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "users" u WHERE u."id" = NEW."reviewed_by" AND u."company_id" = NEW."company_id"
  ) THEN
    RAISE EXCEPTION 'leave_requests.reviewed_by must reference a user in the same company'
      USING ERRCODE = '23503', CONSTRAINT = 'leave_requests_same_company';
  END IF;
  IF NEW."attachment_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "attachments" a WHERE a."id" = NEW."attachment_id" AND a."company_id" = NEW."company_id"
  ) THEN
    RAISE EXCEPTION 'leave_requests.attachment_id must reference an attachment in the same company'
      USING ERRCODE = '23503', CONSTRAINT = 'leave_requests_same_company';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "leave_requests_same_company"
  BEFORE INSERT OR UPDATE OF "company_id", "employee_id", "leave_type_id", "reviewed_by", "attachment_id"
  ON "leave_requests"
  FOR EACH ROW
  EXECUTE FUNCTION "leave_requests_enforce_same_company"();

-- An attendance day written by leave belongs to that leave's employee, in the
-- same company.
CREATE OR REPLACE FUNCTION "attendance_records_enforce_leave_request"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."leave_request_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "leave_requests" l
    WHERE l."id" = NEW."leave_request_id"
      AND l."company_id" = NEW."company_id"
      AND l."employee_id" = NEW."employee_id"
  ) THEN
    RAISE EXCEPTION 'attendance_records.leave_request_id must reference this employee''s leave in the same company'
      USING ERRCODE = '23503', CONSTRAINT = 'attendance_records_same_company';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "attendance_records_leave_request"
  BEFORE INSERT OR UPDATE OF "company_id", "employee_id", "leave_request_id"
  ON "attendance_records"
  FOR EACH ROW
  EXECUTE FUNCTION "attendance_records_enforce_leave_request"();

-- ===========================================================================
-- The Requests Centre — OD-09 hybrid model, completed for Leave.
--
-- The Phase 9 function refused every leave row until this table existed. Its
-- leave clause is now the same check corrections get: the referenced leave
-- request is in this company and belongs to this employee.
-- ===========================================================================
CREATE OR REPLACE FUNCTION "requests_enforce_same_company"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "employees" e
    WHERE e."id" = NEW."employee_id" AND e."company_id" = NEW."company_id"
  ) THEN
    RAISE EXCEPTION 'requests.employee_id must reference an employee in the same company'
      USING ERRCODE = '23503', CONSTRAINT = 'requests_same_company';
  END IF;

  IF NEW."reviewed_by" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "users" u WHERE u."id" = NEW."reviewed_by" AND u."company_id" = NEW."company_id"
  ) THEN
    RAISE EXCEPTION 'requests.reviewed_by must reference a user in the same company'
      USING ERRCODE = '23503', CONSTRAINT = 'requests_same_company';
  END IF;

  IF NEW."related_type" = 'task' AND NOT EXISTS (
    SELECT 1 FROM "tasks" t WHERE t."id" = NEW."related_id" AND t."company_id" = NEW."company_id"
  ) THEN
    RAISE EXCEPTION 'requests.related_id must reference a task in the same company'
      USING ERRCODE = '23503', CONSTRAINT = 'requests_same_company';
  END IF;

  IF NEW."related_type" = 'attendance_correction_request' AND NOT EXISTS (
    SELECT 1 FROM "attendance_correction_requests" c
    WHERE c."id" = NEW."related_id"
      AND c."company_id" = NEW."company_id"
      AND c."employee_id" = NEW."employee_id"
  ) THEN
    RAISE EXCEPTION 'requests.related_id must reference this employee''s correction in the same company'
      USING ERRCODE = '23503', CONSTRAINT = 'requests_same_company';
  END IF;

  IF NEW."related_type" = 'leave_request' AND NOT EXISTS (
    SELECT 1 FROM "leave_requests" l
    WHERE l."id" = NEW."related_id"
      AND l."company_id" = NEW."company_id"
      AND l."employee_id" = NEW."employee_id"
  ) THEN
    RAISE EXCEPTION 'requests.related_id must reference this employee''s leave request in the same company'
      USING ERRCODE = '23503', CONSTRAINT = 'requests_same_company';
  END IF;

  RETURN NEW;
END
$$;

-- The leave record is the source of truth; its inbox row is derived from it
-- in the same transaction, exactly as for corrections (Phase 9). A cancelled
-- request keeps no review time on its inbox row (the `requests` CHECK ties a
-- review time to approved/rejected); the leave record itself keeps the full
-- decision history.
CREATE OR REPLACE FUNCTION "leave_request_index_request"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO "requests" (
      "id", "company_id", "employee_id", "category", "related_type", "related_id",
      "status", "reviewed_by", "reviewed_at", "admin_response", "created_at"
    ) VALUES (
      "requests_new_id"(), NEW."company_id", NEW."employee_id", 'leave',
      'leave_request', NEW."id",
      NEW."status"::text::"request_status", NEW."reviewed_by",
      CASE WHEN NEW."status" IN ('approved', 'rejected') THEN NEW."reviewed_at" END,
      NEW."review_note", NEW."created_at"
    );
  ELSE
    UPDATE "requests"
    SET "status" = NEW."status"::text::"request_status",
        "reviewed_by" = NEW."reviewed_by",
        "reviewed_at" = CASE WHEN NEW."status" IN ('approved', 'rejected') THEN NEW."reviewed_at" END,
        "admin_response" = NEW."review_note"
    WHERE "related_type" = 'leave_request' AND "related_id" = NEW."id";
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "leave_request_index_insert"
  AFTER INSERT ON "leave_requests"
  FOR EACH ROW
  EXECUTE FUNCTION "leave_request_index_request"();

CREATE TRIGGER "leave_request_index_update"
  AFTER UPDATE OF "status", "reviewed_by", "reviewed_at", "review_note"
  ON "leave_requests"
  FOR EACH ROW
  EXECUTE FUNCTION "leave_request_index_request"();

-- ===========================================================================
-- Seeded leave types — DOCUMENT 16 "Leave types (seeded, fully configurable)".
-- Starting configuration only: allowances 0 (approved decision), Unpaid is
-- unpaid, Sick requires an attachment ("typically sick leave", rule 9). Every
-- value is editable; no calculation keys off a name.
-- ===========================================================================
CREATE OR REPLACE FUNCTION "leave_types_seed_for_company"(company UUID)
RETURNS VOID
LANGUAGE sql
AS $$
  INSERT INTO "leave_types" ("id", "company_id", "name_ar", "name_en", "is_paid", "requires_attachment")
  VALUES
    ("requests_new_id"(), company, 'إجازة سنوية',  'Annual',    true,  false),
    ("requests_new_id"(), company, 'إجازة مرضية', 'Sick',      true,  true),
    ("requests_new_id"(), company, 'إجازة طارئة', 'Emergency', true,  false),
    ("requests_new_id"(), company, 'إجازة بدون أجر', 'Unpaid', false, false),
    ("requests_new_id"(), company, 'أخرى',          'Other',     true,  false)
$$;

SELECT "leave_types_seed_for_company"(c."id") FROM "companies" c;

-- New companies: written by the database, like `performance_config` (Phase 8).
-- SECURITY DEFINER because the company row is created under the platform
-- context, before any tenant is bound.
CREATE OR REPLACE FUNCTION "companies_seed_leave_types"()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM "leave_types_seed_for_company"(NEW."id");
  RETURN NEW;
END
$$;

CREATE TRIGGER "companies_seed_leave_types"
  AFTER INSERT ON "companies"
  FOR EACH ROW
  EXECUTE FUNCTION "companies_seed_leave_types"();

-- ===========================================================================
-- Approved leave cancelled by an ADMIN (DOCUMENT 16 rule 15).
--
-- DOCUMENT 16 says the generated attendance records are deleted; DOCUMENT 06
-- §6 and DOCUMENT 12 say attendance is never hard-deleted, and the app role
-- has no DELETE (Phase 6). Reconciled narrowly: a day that has already ended
-- is history and is kept, reverted by an audited update; a day that has not
-- yet happened is not history — it is a projection the leave wrote — and only
-- such a row may be removed, through this function and nothing else. It
-- refuses anything that is not that leave's own system-written, never-worked
-- future day.
-- ===========================================================================
CREATE OR REPLACE FUNCTION "attendance_remove_future_leave_day"(record UUID, leave UUID, today DATE)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  removed INTEGER;
BEGIN
  DELETE FROM "attendance_records" r
  WHERE r."id" = record
    AND r."leave_request_id" = leave
    AND r."company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid
    AND r."source" = 'system'
    AND r."check_in_at" IS NULL
    AND r."date" >= today;
  GET DIAGNOSTICS removed = ROW_COUNT;
  IF removed <> 1 THEN
    RAISE EXCEPTION 'attendance record % is not a future day written by leave %', record, leave
      USING ERRCODE = '42501';
  END IF;
END
$$;

REVOKE ALL ON FUNCTION "attendance_remove_future_leave_day"(UUID, UUID, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "attendance_remove_future_leave_day"(UUID, UUID, DATE) TO "ufuq_app";

-- ===========================================================================
-- Attachments — the store gains its third consumer.
-- ===========================================================================
ALTER TABLE "attachments" DROP CONSTRAINT "attachments_related_type_known";
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_related_type_known"
  CHECK ("related_type" IN ('task', 'request', 'leave_request'));

-- ===========================================================================
-- Least privilege — DOCUMENT 20 §3. Phase 3's default privileges grant
-- DELETE on every new table, so the REVOKEs are what do the work:
--
--   * leave_types — soft delete only (DOCUMENT 16 "Soft delete on leave types").
--   * leave_balances — history of entitlement; adjusted, never deleted.
--   * leave_requests — history; cancelled, never deleted.
-- ===========================================================================
GRANT SELECT, INSERT, UPDATE ON "leave_types" TO "ufuq_app";
REVOKE DELETE ON "leave_types" FROM "ufuq_app";
GRANT SELECT, INSERT, UPDATE ON "leave_balances" TO "ufuq_app";
REVOKE DELETE ON "leave_balances" FROM "ufuq_app";
GRANT SELECT, INSERT, UPDATE ON "leave_requests" TO "ufuq_app";
REVOKE DELETE ON "leave_requests" FROM "ufuq_app";

-- ===========================================================================
-- Row-level security — AD-03, DOCUMENT 20 §3, DOCUMENT 27 RULE 10.
-- `packages/db/test/phase10-rls.test.ts` proves every policy.
-- ===========================================================================
ALTER TABLE "leave_types" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "leave_types" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "leave_types"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

ALTER TABLE "leave_balances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "leave_balances" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "leave_balances"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

ALTER TABLE "leave_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "leave_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "leave_requests"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

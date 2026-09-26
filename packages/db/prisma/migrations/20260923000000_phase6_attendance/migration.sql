-- ===========================================================================
-- Phase 6 — attendance (DOCUMENT 06 §3.10–3.11, DOCUMENT 12, DOCUMENT 25 Phase 6)
--
-- MIGRATION IMPLICATIONS — DOCUMENT 27 RULE 31
--
--   What data exists:   neither `attendance_records` nor
--                       `attendance_correction_requests` exists yet, so there
--                       is no data to migrate and no existing table is
--                       altered. Every employee created in Phase 5 simply has
--                       no attendance history, which is the correct reading of
--                       "this company has not started recording attendance":
--                       nothing here back-fills days before deployment, and
--                       the nightly absence job only ever looks at days it is
--                       asked about.
--   In-flight records:  none. Nothing reads or writes either table until the
--                       Phase 6 endpoints are deployed alongside this file.
--   Reversibility:      reversible while both tables are empty — drop the two
--                       triggers and their functions, the two tables, and the
--                       four new types. The seven values added to
--                       `audit_action` are not reversible (PostgreSQL cannot
--                       remove an enum value); that is intentional, for the
--                       same reason as Phases 4 and 5: an audit action that
--                       has been written must stay readable forever
--                       (DOCUMENT 21, append-only).
--
-- `ALTER TYPE … ADD VALUE` is safe inside the migration transaction on
-- PostgreSQL 12+ because nothing in this file uses the new values.
--
-- Two DOCUMENT 06 columns are deliberately absent, each because it is a
-- foreign key to a table no phase has built, and an unenforced UUID is the
-- shortcut that never gets fixed (the reasoning that kept
-- `departments.manager_employee_id` out of Phase 4):
--
--   * `attendance_records.leave_request_id` → Phase 10, with `leave_requests`.
--   * `attendance_correction_requests.attachment_id` → whichever phase builds
--     DOCUMENT 08 §4.14 attachments.
--
-- See docs/PHASE-6-STATUS.md.
-- ===========================================================================

CREATE TYPE "work_mode" AS ENUM ('office', 'wfh');

CREATE TYPE "attendance_status" AS ENUM (
  'present', 'absent', 'late', 'on_leave', 'half_day', 'holiday', 'weekend', 'pending'
);

CREATE TYPE "attendance_source" AS ENUM ('self', 'admin', 'correction', 'system');

CREATE TYPE "correction_status" AS ENUM ('pending', 'approved', 'rejected', 'cancelled');

-- DOCUMENT 21 "Attendance".
ALTER TYPE "audit_action" ADD VALUE 'attendance.checked_in';
ALTER TYPE "audit_action" ADD VALUE 'attendance.checked_out';
ALTER TYPE "audit_action" ADD VALUE 'attendance.adjusted_by_admin';
ALTER TYPE "audit_action" ADD VALUE 'attendance.correction_requested';
ALTER TYPE "audit_action" ADD VALUE 'attendance.correction_approved';
ALTER TYPE "audit_action" ADD VALUE 'attendance.correction_rejected';
ALTER TYPE "audit_action" ADD VALUE 'attendance.generated_by_system';

-- ---------------------------------------------------------------------------
-- attendance_records — DOCUMENT 06 §3.10
--
-- The derived columns are stored rather than recomputed on read. DOCUMENT 12's
-- "schedule changes mid-month" edge case requires each day to keep the
-- evaluation made against the schedule in effect *on that date*; a value
-- recomputed at read time would silently restate a closed month the first
-- time somebody edits a schedule.
-- ---------------------------------------------------------------------------
CREATE TABLE "attendance_records" (
  "id"               UUID         NOT NULL,
  "company_id"       UUID         NOT NULL,
  "employee_id"      UUID         NOT NULL,
  "date"             DATE         NOT NULL,
  "work_mode"        "work_mode",
  "check_in_at"      TIMESTAMPTZ(3),
  "check_out_at"     TIMESTAMPTZ(3),
  "working_minutes"  INTEGER,
  "overtime_minutes" INTEGER,
  "late_minutes"     INTEGER,
  "status"           "attendance_status" NOT NULL,
  "source"           "attendance_source" NOT NULL,
  "note"             TEXT,
  "created_by"       UUID,
  "created_at"       TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "attendance_records_pkey" PRIMARY KEY ("id"),

  -- A check-out before the check-in is not a late record, it is a broken one.
  -- The service refuses it first (DOCUMENT 12 validation); this is what makes
  -- a forgotten check a refused write.
  CONSTRAINT "attendance_records_out_after_in" CHECK (
    "check_out_at" IS NULL OR "check_in_at" IS NULL OR "check_out_at" > "check_in_at"
  ),
  -- Derived minutes are counts, never negative. DOCUMENT 12 rule 6 already
  -- clamps overtime at zero; this keeps a future writer honest too.
  CONSTRAINT "attendance_records_minutes_non_negative" CHECK (
    ("working_minutes"  IS NULL OR "working_minutes"  >= 0) AND
    ("overtime_minutes" IS NULL OR "overtime_minutes" >= 0) AND
    ("late_minutes"     IS NULL OR "late_minutes"     >= 0)
  ),
  -- DOCUMENT 12: work mode is required on check-in. A row with a check-in and
  -- no mode would be exactly the "WFH as an afterthought" the spec rejects.
  CONSTRAINT "attendance_records_mode_with_check_in" CHECK (
    "check_in_at" IS NULL OR "work_mode" IS NOT NULL
  )
);

ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RESTRICT, not CASCADE: attendance is historical and feeds payroll
-- (DOCUMENT 06 §5, DOCUMENT 12 "never hard-deleted").
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- DOCUMENT 06 §3.10 / DOCUMENT 12 rule 1: one record per employee per day.
CREATE UNIQUE INDEX "attendance_records_employee_id_date_key"
  ON "attendance_records"("employee_id", "date");
CREATE INDEX "attendance_records_company_id_date_idx"
  ON "attendance_records"("company_id", "date");
CREATE INDEX "attendance_records_employee_id_date_idx"
  ON "attendance_records"("employee_id", "date");
CREATE INDEX "attendance_records_company_id_status_date_idx"
  ON "attendance_records"("company_id", "status", "date");

-- ---------------------------------------------------------------------------
-- attendance_correction_requests — DOCUMENT 06 §3.11
-- ---------------------------------------------------------------------------
CREATE TABLE "attendance_correction_requests" (
  "id"                   UUID NOT NULL,
  "company_id"           UUID NOT NULL,
  "employee_id"          UUID NOT NULL,
  "attendance_record_id" UUID,
  "date"                 DATE NOT NULL,
  "requested_check_in"   TIMESTAMPTZ(3),
  "requested_check_out"  TIMESTAMPTZ(3),
  "requested_work_mode"  "work_mode",
  "reason"               TEXT NOT NULL,
  "status"               "correction_status" NOT NULL DEFAULT 'pending',
  "reviewed_by"          UUID,
  "reviewed_at"          TIMESTAMPTZ(3),
  "review_note"          TEXT,
  "created_at"           TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "attendance_correction_requests_pkey" PRIMARY KEY ("id"),

  -- DOCUMENT 12 validation: "requested_check_out must be after
  -- requested_check_in".
  CONSTRAINT "attendance_corrections_out_after_in" CHECK (
    "requested_check_out" IS NULL OR "requested_check_in" IS NULL
      OR "requested_check_out" > "requested_check_in"
  ),
  -- A decided request names who decided it and when; a pending one names
  -- neither. Without this the two halves could drift apart.
  CONSTRAINT "attendance_corrections_review_consistent" CHECK (
    ("status" = 'pending'   AND "reviewed_by" IS NULL AND "reviewed_at" IS NULL) OR
    ("status" = 'cancelled' AND "reviewed_by" IS NULL AND "reviewed_at" IS NULL) OR
    ("status" IN ('approved', 'rejected') AND "reviewed_by" IS NOT NULL AND "reviewed_at" IS NOT NULL)
  ),
  -- DOCUMENT 12 validation: "rejection requires a reason".
  CONSTRAINT "attendance_corrections_rejection_has_note" CHECK (
    "status" <> 'rejected' OR ("review_note" IS NOT NULL AND btrim("review_note") <> '')
  )
);

ALTER TABLE "attendance_correction_requests" ADD CONSTRAINT "attendance_corrections_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "attendance_correction_requests" ADD CONSTRAINT "attendance_corrections_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "attendance_correction_requests" ADD CONSTRAINT "attendance_corrections_record_id_fkey"
  FOREIGN KEY ("attendance_record_id") REFERENCES "attendance_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "attendance_correction_requests" ADD CONSTRAINT "attendance_corrections_reviewed_by_fkey"
  FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "attendance_corrections_company_id_status_date_idx"
  ON "attendance_correction_requests"("company_id", "status", "date");
CREATE INDEX "attendance_corrections_employee_id_date_idx"
  ON "attendance_correction_requests"("employee_id", "date");

-- ===========================================================================
-- Same-company references — DOCUMENT 07 §9 invariant 7.
--
-- As in Phase 5: PostgreSQL checks a foreign key without applying row
-- security, so a key alone would accept another company's employee or record.
-- The service checks every reference first; these triggers are what make a
-- forgotten check a refused write instead of a cross-tenant link.
-- ===========================================================================
CREATE OR REPLACE FUNCTION "attendance_records_enforce_same_company"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "employees" e WHERE e."id" = NEW."employee_id" AND e."company_id" = NEW."company_id"
  ) THEN
    RAISE EXCEPTION 'attendance_records.employee_id must reference an employee in the same company'
      USING ERRCODE = '23503', CONSTRAINT = 'attendance_records_same_company';
  END IF;

  IF NEW."created_by" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "users" u WHERE u."id" = NEW."created_by" AND u."company_id" = NEW."company_id"
  ) THEN
    RAISE EXCEPTION 'attendance_records.created_by must reference a user in the same company'
      USING ERRCODE = '23503', CONSTRAINT = 'attendance_records_same_company';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER "attendance_records_same_company"
  BEFORE INSERT OR UPDATE OF "company_id", "employee_id", "created_by"
  ON "attendance_records"
  FOR EACH ROW
  EXECUTE FUNCTION "attendance_records_enforce_same_company"();

CREATE OR REPLACE FUNCTION "attendance_corrections_enforce_same_company"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "employees" e WHERE e."id" = NEW."employee_id" AND e."company_id" = NEW."company_id"
  ) THEN
    RAISE EXCEPTION 'attendance_correction_requests.employee_id must reference an employee in the same company'
      USING ERRCODE = '23503', CONSTRAINT = 'attendance_corrections_same_company';
  END IF;

  IF NEW."attendance_record_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "attendance_records" r
    WHERE r."id" = NEW."attendance_record_id" AND r."company_id" = NEW."company_id"
  ) THEN
    RAISE EXCEPTION 'attendance_correction_requests.attendance_record_id must reference a record in the same company'
      USING ERRCODE = '23503', CONSTRAINT = 'attendance_corrections_same_company';
  END IF;

  IF NEW."reviewed_by" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "users" u WHERE u."id" = NEW."reviewed_by" AND u."company_id" = NEW."company_id"
  ) THEN
    RAISE EXCEPTION 'attendance_correction_requests.reviewed_by must reference a user in the same company'
      USING ERRCODE = '23503', CONSTRAINT = 'attendance_corrections_same_company';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER "attendance_corrections_same_company"
  BEFORE INSERT OR UPDATE OF "company_id", "employee_id", "attendance_record_id", "reviewed_by"
  ON "attendance_correction_requests"
  FOR EACH ROW
  EXECUTE FUNCTION "attendance_corrections_enforce_same_company"();

-- ===========================================================================
-- Least privilege — DOCUMENT 20 §3.
--
-- DOCUMENT 12 "DATABASE REQUIREMENTS" says attendance is never hard-deleted,
-- and the application role is the level at which that is worth making true
-- rather than merely intended.
--
-- The REVOKE is the part that does the work. Phase 3 set
-- `ALTER DEFAULT PRIVILEGES … GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES`,
-- so every table created afterwards arrives with DELETE already granted:
-- naming only the three privileges wanted in a GRANT adds nothing and takes
-- nothing away. Proved in `packages/db/test/phase6-rls.test.ts`.
-- ===========================================================================
GRANT SELECT, INSERT, UPDATE ON "attendance_records" TO "ufuq_app";
GRANT SELECT, INSERT, UPDATE ON "attendance_correction_requests" TO "ufuq_app";
REVOKE DELETE ON "attendance_records" FROM "ufuq_app";
REVOKE DELETE ON "attendance_correction_requests" FROM "ufuq_app";

-- ===========================================================================
-- Row-level security — AD-03, DOCUMENT 20 §3, DOCUMENT 27 RULE 10.
-- `packages/db/test/phase6-rls.test.ts` proves both policies against queries
-- with no WHERE clause.
-- ===========================================================================
ALTER TABLE "attendance_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_records" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "attendance_records"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

ALTER TABLE "attendance_correction_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_correction_requests" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "attendance_correction_requests"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

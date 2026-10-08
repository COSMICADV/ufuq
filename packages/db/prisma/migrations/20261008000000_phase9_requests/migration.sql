-- ===========================================================================
-- Phase 9 — the unified Requests Centre (DOCUMENT 06 §3.20, DOCUMENT 08 §4.9,
-- DOCUMENT 04 B13 / C8–C10, DOCUMENT 25 Phase 9, OD-09 hybrid model)
--
-- MIGRATION IMPLICATIONS — DOCUMENT 27 RULE 31
--
--   What data exists:   `requests` is new. Existing `attendance_correction_
--                       requests` rows are not changed; each one gains an index
--                       row in `requests` (the OD-09 hybrid model: the
--                       specialised record stays the source of truth and the
--                       inbox row points at it through related_type /
--                       related_id). `attachments.related_type` gains the value
--                       'request'; no existing attachment changes.
--   Backfill:           one `requests` row per existing correction, carrying
--                       its status, reviewer, review time, review note (as
--                       `admin_response`) and creation time.
--   In-flight records:  none lost. From this migration on, a trigger on
--                       `attendance_correction_requests` writes and updates the
--                       index row in the same transaction as the correction
--                       itself, whichever code path writes the correction, so
--                       the index can never drift from the record it indexes.
--   Reversibility:      reversible — drop the two correction triggers and
--                       their function, the `requests` table, its triggers and
--                       functions and the two new types, and restore the
--                       attachments CHECK to ('task') (only if no 'request'
--                       attachment exists). The four values added to
--                       `audit_action` are not reversible (PostgreSQL cannot
--                       remove an enum value); as in Phases 4–8 that is
--                       intentional: a written audit action stays readable.
--
-- `ALTER TYPE … ADD VALUE` is safe inside the migration transaction on
-- PostgreSQL 12+ because nothing in this file uses the new values.
--
-- Leave (category 'leave') is in the enum because DOCUMENT 06 §3.20 names it,
-- and the CHECK below already requires a leave row to point at its
-- specialised record ('leave_request'). No such record can exist until Phase
-- 10 creates `leave_requests`, so no leave row can be written yet (DOCUMENT
-- 25, as amended in Phase 9; see docs/PHASE-9-STATUS.md, "Phase 10 Leave
-- handoff").
--
-- See docs/PHASE-9-STATUS.md.
-- ===========================================================================

CREATE TYPE "request_category" AS ENUM ('attendance', 'leave', 'salary', 'task', 'general');

CREATE TYPE "request_status" AS ENUM ('pending', 'approved', 'rejected', 'cancelled');

-- DOCUMENT 21 "Requests" (added and approved in Phase 9): the lifecycle of a
-- native request (salary / task / general) and a requester's cancellation.
-- Attendance corrections keep their canonical `attendance.correction_*`
-- actions.
ALTER TYPE "audit_action" ADD VALUE 'request.submitted';
ALTER TYPE "audit_action" ADD VALUE 'request.approved';
ALTER TYPE "audit_action" ADD VALUE 'request.rejected';
ALTER TYPE "audit_action" ADD VALUE 'request.cancelled';

-- ---------------------------------------------------------------------------
-- requests — DOCUMENT 06 §3.20
-- ---------------------------------------------------------------------------
CREATE TABLE "requests" (
    "id"             UUID               NOT NULL,
    "company_id"     UUID               NOT NULL,
    "employee_id"    UUID               NOT NULL,
    "category"       "request_category" NOT NULL,
    "subject"        VARCHAR(255),
    "description"    TEXT,
    "related_type"   VARCHAR(50),
    "related_id"     UUID,
    "status"         "request_status"   NOT NULL DEFAULT 'pending',
    "reviewed_by"    UUID,
    "reviewed_at"    TIMESTAMPTZ(3),
    "admin_response" TEXT,
    "created_at"     TIMESTAMPTZ(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "requests_pkey" PRIMARY KEY ("id"),

    -- OD-09 hybrid model. A specialised category always points at its own
    -- record; a native category (salary / task / general) carries its own
    -- subject and description, and only a task request may reference a task.
    CONSTRAINT "requests_related_pair"
      CHECK (("related_type" IS NULL) = ("related_id" IS NULL)),
    CONSTRAINT "requests_category_shape" CHECK (
      CASE "category"
        WHEN 'attendance' THEN "related_type" IS NOT DISTINCT FROM 'attendance_correction_request'
        WHEN 'leave'      THEN "related_type" IS NOT DISTINCT FROM 'leave_request'
        WHEN 'task'       THEN ("related_type" IS NULL OR "related_type" = 'task')
                               AND "subject" IS NOT NULL AND "description" IS NOT NULL
        ELSE "related_type" IS NULL
             AND "subject" IS NOT NULL AND "description" IS NOT NULL
      END
    ),
    CONSTRAINT "requests_subject_not_blank"
      CHECK ("subject" IS NULL OR length(btrim("subject")) > 0),
    CONSTRAINT "requests_description_length"
      CHECK ("description" IS NULL OR length(btrim("description")) BETWEEN 1 AND 5000),
    CONSTRAINT "requests_admin_response_length"
      CHECK ("admin_response" IS NULL OR length("admin_response") <= 1000),

    -- A decision records when it was made; an undecided request has none.
    CONSTRAINT "requests_review_consistent" CHECK (
      ("status" IN ('approved', 'rejected')) = ("reviewed_at" IS NOT NULL)
    ),
    -- "Reject requires a reason" (DOCUMENT 04 B13), held by the table itself.
    CONSTRAINT "requests_rejection_has_reason" CHECK (
      "status" <> 'rejected' OR length(btrim(coalesce("admin_response", ''))) > 0
    )
);

-- DOCUMENT 06 §3.20: the inbox's index.
CREATE INDEX "requests_company_id_status_created_at_idx"
  ON "requests"("company_id", "status", "created_at");
-- C8 "My requests": one employee's history, newest first.
CREATE INDEX "requests_employee_id_created_at_idx" ON "requests"("employee_id", "created_at");
-- One inbox row per specialised record.
CREATE UNIQUE INDEX "requests_related_type_related_id_key"
  ON "requests"("related_type", "related_id");

ALTER TABLE "requests" ADD CONSTRAINT "requests_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "requests" ADD CONSTRAINT "requests_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "requests" ADD CONSTRAINT "requests_reviewed_by_fkey"
  FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===========================================================================
-- Same-company references — DOCUMENT 07 §9 invariant 7, as in Phases 5–8.
-- `related_id` is polymorphic, so its target is checked here by type: the
-- referenced record must be in this company and, for a correction, belong to
-- the same employee.
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

  -- The leave inbox row indexes `leave_requests`, which Phase 10 creates. Until
  -- then there is nothing a leave row could correctly point at, so none may be
  -- written; Phase 10 replaces this clause with the same-company check above.
  IF NEW."related_type" = 'leave_request' THEN
    RAISE EXCEPTION 'leave requests are indexed once leave_requests exists (Phase 10)'
      USING ERRCODE = '23514', CONSTRAINT = 'requests_leave_not_yet_available';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER "requests_same_company"
  BEFORE INSERT OR UPDATE OF "company_id", "employee_id", "reviewed_by", "related_type", "related_id"
  ON "requests"
  FOR EACH ROW
  EXECUTE FUNCTION "requests_enforce_same_company"();

-- ===========================================================================
-- The hybrid index for attendance corrections (OD-09).
--
-- The correction is the source of truth; its inbox row is derived from it in
-- the same transaction, by the database, so that no code path — Phase 6's
-- `/attendance-corrections` endpoints or Phase 9's `/requests` — can write a
-- correction without its index row, or decide one without the row following.
-- The functions run as the caller (no SECURITY DEFINER), so row-level security
-- applies to the index row exactly as to the correction.
-- ===========================================================================
CREATE OR REPLACE FUNCTION "requests_new_id"()
RETURNS UUID
LANGUAGE sql
VOLATILE
AS $$
  -- OD-12 UUID v7 layout, as `performance_config_new_id()` (Phase 8) and the
  -- application's `generateId()`.
  SELECT encode(
    set_bit(
      set_bit(
        overlay(
          uuid_send(gen_random_uuid())
          PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
          FROM 1 FOR 6
        ),
        52, 1
      ),
      53, 1
    ),
    'hex'
  )::uuid
$$;

CREATE OR REPLACE FUNCTION "attendance_correction_index_request"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO "requests" (
      "id", "company_id", "employee_id", "category", "related_type", "related_id",
      "status", "reviewed_by", "reviewed_at", "admin_response", "created_at"
    ) VALUES (
      "requests_new_id"(), NEW."company_id", NEW."employee_id", 'attendance',
      'attendance_correction_request', NEW."id",
      NEW."status"::text::"request_status", NEW."reviewed_by", NEW."reviewed_at",
      NEW."review_note", NEW."created_at"
    );
  ELSE
    UPDATE "requests"
    SET "status" = NEW."status"::text::"request_status",
        "reviewed_by" = NEW."reviewed_by",
        "reviewed_at" = NEW."reviewed_at",
        "admin_response" = NEW."review_note"
    WHERE "related_type" = 'attendance_correction_request' AND "related_id" = NEW."id";
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "attendance_correction_index_insert"
  AFTER INSERT ON "attendance_correction_requests"
  FOR EACH ROW
  EXECUTE FUNCTION "attendance_correction_index_request"();

CREATE TRIGGER "attendance_correction_index_update"
  AFTER UPDATE OF "status", "reviewed_by", "reviewed_at", "review_note"
  ON "attendance_correction_requests"
  FOR EACH ROW
  EXECUTE FUNCTION "attendance_correction_index_request"();

-- Backfill: one index row per existing correction.
INSERT INTO "requests" (
  "id", "company_id", "employee_id", "category", "related_type", "related_id",
  "status", "reviewed_by", "reviewed_at", "admin_response", "created_at"
)
SELECT
  "requests_new_id"(), c."company_id", c."employee_id", 'attendance',
  'attendance_correction_request', c."id",
  -- The correction's own CHECKs already guarantee a decided row has a
  -- reviewer and a time, and a rejected one a note.
  c."status"::text::"request_status", c."reviewed_by", c."reviewed_at", c."review_note",
  c."created_at"
FROM "attendance_correction_requests" c;

-- ===========================================================================
-- Attachments — the Phase 7 store gains its second consumer.
-- ===========================================================================
ALTER TABLE "attachments" DROP CONSTRAINT "attachments_related_type_known";
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_related_type_known"
  CHECK ("related_type" IN ('task', 'request'));

-- ===========================================================================
-- Least privilege — DOCUMENT 20 §3. Requests are history (DOCUMENT 06 §6):
-- a request is cancelled, never deleted. No DELETE.
-- ===========================================================================
GRANT SELECT, INSERT, UPDATE ON "requests" TO "ufuq_app";
REVOKE DELETE ON "requests" FROM "ufuq_app";

-- ===========================================================================
-- Row-level security — AD-03, DOCUMENT 20 §3, DOCUMENT 27 RULE 10.
-- `packages/db/test/phase9-rls.test.ts` proves it with no WHERE clause.
-- ===========================================================================
ALTER TABLE "requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "requests" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "requests"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

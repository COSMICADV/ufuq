-- ===========================================================================
-- Phase 7 — tasks (DOCUMENT 06 §3.15–3.17, DOCUMENT 13, DOCUMENT 25 Phase 7)
--
-- MIGRATION IMPLICATIONS — DOCUMENT 27 RULE 31
--
--   What data exists:   none of `tasks`, `task_checklist_items` or
--                       `task_progress_updates` exists yet, so there is no
--                       data to migrate and no existing table is altered.
--   In-flight records:  none. Nothing reads or writes these tables until the
--                       Phase 7 endpoints are deployed alongside this file.
--   Reversibility:      reversible while the three tables are empty — drop the
--                       triggers and their functions, the three tables, and
--                       the two new types. The ten values added to
--                       `audit_action` are not reversible (PostgreSQL cannot
--                       remove an enum value); that is intentional, for the
--                       same reason as Phases 4–6: an audit action that has
--                       been written must stay readable forever (DOCUMENT 21,
--                       append-only).
--
-- `ALTER TYPE … ADD VALUE` is safe inside the migration transaction on
-- PostgreSQL 12+ because nothing in this file uses the new values.
--
-- One DOCUMENT 06 column is deliberately absent, because it is a foreign key
-- to a table no phase has built — the reasoning that kept
-- `attendance_records.leave_request_id` out of Phase 6:
--
--   * `tasks.goal_id` → Phase 8, with `goals` (and with it `ON DELETE SET
--     NULL`, DOCUMENT 13 "Database requirements").
--
-- Two columns are present that DOCUMENT 06 §3.17 does not name, both under
-- DOCUMENT 06 §1.6 ("where a user causes the row — created_by"):
--
--   * `task_progress_updates.created_by` — the acting user, always present.
--     `employee_id` stays, nullable, because an administrator account need
--     not have an employee record.
--
-- See docs/PHASE-7-STATUS.md.
-- ===========================================================================

CREATE TYPE "task_status" AS ENUM ('not_started', 'in_progress', 'completed', 'cancelled', 'on_hold');

CREATE TYPE "task_priority" AS ENUM ('low', 'medium', 'high', 'urgent');

-- DOCUMENT 21 "Tasks & goals" — the task half. The goal half is Phase 8's.
ALTER TYPE "audit_action" ADD VALUE 'task.created';
ALTER TYPE "audit_action" ADD VALUE 'task.updated';
ALTER TYPE "audit_action" ADD VALUE 'task.reassigned';
ALTER TYPE "audit_action" ADD VALUE 'task.deadline_changed';
ALTER TYPE "audit_action" ADD VALUE 'task.status_changed';
ALTER TYPE "audit_action" ADD VALUE 'task.cancelled';
ALTER TYPE "audit_action" ADD VALUE 'task.deleted';
ALTER TYPE "audit_action" ADD VALUE 'task.reopened';
ALTER TYPE "audit_action" ADD VALUE 'checklist.item_added';
ALTER TYPE "audit_action" ADD VALUE 'checklist.item_deleted';

-- ---------------------------------------------------------------------------
-- tasks — DOCUMENT 06 §3.15
-- ---------------------------------------------------------------------------
CREATE TABLE "tasks" (
  "id"                   UUID            NOT NULL,
  "company_id"           UUID            NOT NULL,
  "title"                VARCHAR(255)    NOT NULL,
  "description"          TEXT,
  "assignee_employee_id" UUID            NOT NULL,
  "department_id"        UUID,
  "priority"             "task_priority" NOT NULL,
  "status"               "task_status"   NOT NULL DEFAULT 'not_started',
  "start_date"           DATE,
  "deadline"             DATE,
  "completed_at"         TIMESTAMPTZ(3),
  "progress_percent"     DECIMAL(5,2)    NOT NULL DEFAULT 0,
  "created_by"           UUID            NOT NULL,
  "cancelled_reason"     TEXT,
  "created_at"           TIMESTAMPTZ(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           TIMESTAMPTZ(3)  NOT NULL,
  "deleted_at"           TIMESTAMPTZ(3),

  CONSTRAINT "tasks_pkey" PRIMARY KEY ("id"),

  -- DOCUMENT 13 validation: "Title required, 3–255 characters".
  CONSTRAINT "tasks_title_length" CHECK (char_length(btrim("title")) >= 3),
  -- DOCUMENT 13 validation: "deadline ≥ start_date when both are supplied".
  CONSTRAINT "tasks_deadline_after_start" CHECK (
    "deadline" IS NULL OR "start_date" IS NULL OR "deadline" >= "start_date"
  ),
  -- DOCUMENT 06 §2: a percentage. Derived, so a value outside 0–100 is a bug.
  CONSTRAINT "tasks_progress_range" CHECK ("progress_percent" BETWEEN 0 AND 100),
  -- A completed task says when; any other status does not. Reopening clears it.
  CONSTRAINT "tasks_completed_at_consistent" CHECK (
    ("status" = 'completed') = ("completed_at" IS NOT NULL)
  ),
  -- DOCUMENT 13 rule 7: "Cancellation requires a reason."
  CONSTRAINT "tasks_cancellation_has_reason" CHECK (
    "status" <> 'cancelled' OR ("cancelled_reason" IS NOT NULL AND btrim("cancelled_reason") <> '')
  )
);

ALTER TABLE "tasks" ADD CONSTRAINT "tasks_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RESTRICT: a task is history that reports and goals read (DOCUMENT 06 §6).
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_employee_id_fkey"
  FOREIGN KEY ("assignee_employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "tasks" ADD CONSTRAINT "tasks_department_id_fkey"
  FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- DOCUMENT 13 "Database requirements" / DOCUMENT 06 §5, each serving a query.
CREATE INDEX "tasks_company_id_status_idx" ON "tasks"("company_id", "status");
CREATE INDEX "tasks_assignee_employee_id_status_idx" ON "tasks"("assignee_employee_id", "status");
CREATE INDEX "tasks_company_id_deadline_idx" ON "tasks"("company_id", "deadline");

-- ---------------------------------------------------------------------------
-- task_checklist_items — DOCUMENT 06 §3.16
--
-- No `company_id`: DOCUMENT 06 §3.16 does not define one. Tenancy is reached
-- through the parent task, exactly as `work_schedule_days` reaches it through
-- its schedule (Phase 4).
-- ---------------------------------------------------------------------------
CREATE TABLE "task_checklist_items" (
  "id"           UUID           NOT NULL,
  "task_id"      UUID           NOT NULL,
  "title"        VARCHAR(255)   NOT NULL,
  "is_completed" BOOLEAN        NOT NULL DEFAULT false,
  "completed_at" TIMESTAMPTZ(3),
  "completed_by" UUID,
  "position"     INTEGER        NOT NULL,
  "created_at"   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "task_checklist_items_pkey" PRIMARY KEY ("id"),

  -- DOCUMENT 13 validation: "Checklist item title required, maximum 255".
  CONSTRAINT "task_checklist_items_title_present" CHECK (btrim("title") <> ''),
  CONSTRAINT "task_checklist_items_position_non_negative" CHECK ("position" >= 0),
  -- A ticked item says when; an open one does not.
  CONSTRAINT "task_checklist_items_completion_consistent" CHECK (
    "is_completed" = ("completed_at" IS NOT NULL)
  )
);

-- DOCUMENT 06 §5 / DOCUMENT 13: CASCADE, named for this table by both — the
-- items are genuinely owned by their task.
ALTER TABLE "task_checklist_items" ADD CONSTRAINT "task_checklist_items_task_id_fkey"
  FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "task_checklist_items" ADD CONSTRAINT "task_checklist_items_completed_by_fkey"
  FOREIGN KEY ("completed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "task_checklist_items_task_id_position_idx"
  ON "task_checklist_items"("task_id", "position");

-- ---------------------------------------------------------------------------
-- task_progress_updates — DOCUMENT 06 §3.17. Append-only (DOCUMENT 13 rule 9).
-- ---------------------------------------------------------------------------
CREATE TABLE "task_progress_updates" (
  "id"                       UUID           NOT NULL,
  "task_id"                  UUID           NOT NULL,
  "employee_id"              UUID,
  "note"                     TEXT           NOT NULL,
  "progress_percent_at_time" DECIMAL(5,2)   NOT NULL,
  "created_by"               UUID           NOT NULL,
  "created_at"               TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "task_progress_updates_pkey" PRIMARY KEY ("id"),

  -- DOCUMENT 13 validation: "maximum 2000 characters, and must not be empty
  -- or whitespace".
  CONSTRAINT "task_progress_updates_note_present" CHECK (btrim("note") <> ''),
  CONSTRAINT "task_progress_updates_note_length" CHECK (char_length("note") <= 2000),
  CONSTRAINT "task_progress_updates_progress_range" CHECK (
    "progress_percent_at_time" BETWEEN 0 AND 100
  )
);

-- DOCUMENT 13 "Database requirements": cascade on progress updates too. Tasks
-- are only ever soft-deleted by the application, so this fires only for an
-- audited administrative hard delete (DOCUMENT 06 §1.5).
ALTER TABLE "task_progress_updates" ADD CONSTRAINT "task_progress_updates_task_id_fkey"
  FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "task_progress_updates" ADD CONSTRAINT "task_progress_updates_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "task_progress_updates" ADD CONSTRAINT "task_progress_updates_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "task_progress_updates_task_id_created_at_idx"
  ON "task_progress_updates"("task_id", "created_at");

-- ===========================================================================
-- Same-company references — DOCUMENT 07 §9 invariant 7.
--
-- As in Phases 5 and 6: PostgreSQL checks a foreign key without applying row
-- security, so a key alone would accept another company's employee,
-- department or user. The service checks every reference first; these
-- triggers make a forgotten check a refused write instead of a cross-tenant
-- link. The child tables compare against their parent task's company.
-- ===========================================================================
CREATE OR REPLACE FUNCTION "tasks_enforce_same_company"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "employees" e
    WHERE e."id" = NEW."assignee_employee_id" AND e."company_id" = NEW."company_id"
  ) THEN
    RAISE EXCEPTION 'tasks.assignee_employee_id must reference an employee in the same company'
      USING ERRCODE = '23503', CONSTRAINT = 'tasks_same_company';
  END IF;

  IF NEW."department_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "departments" d
    WHERE d."id" = NEW."department_id" AND d."company_id" = NEW."company_id"
  ) THEN
    RAISE EXCEPTION 'tasks.department_id must reference a department in the same company'
      USING ERRCODE = '23503', CONSTRAINT = 'tasks_same_company';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "users" u WHERE u."id" = NEW."created_by" AND u."company_id" = NEW."company_id"
  ) THEN
    RAISE EXCEPTION 'tasks.created_by must reference a user in the same company'
      USING ERRCODE = '23503', CONSTRAINT = 'tasks_same_company';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER "tasks_same_company"
  BEFORE INSERT OR UPDATE OF "company_id", "assignee_employee_id", "department_id", "created_by"
  ON "tasks"
  FOR EACH ROW
  EXECUTE FUNCTION "tasks_enforce_same_company"();

CREATE OR REPLACE FUNCTION "task_checklist_items_enforce_same_company"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."completed_by" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "tasks" t JOIN "users" u ON u."company_id" = t."company_id"
    WHERE t."id" = NEW."task_id" AND u."id" = NEW."completed_by"
  ) THEN
    RAISE EXCEPTION 'task_checklist_items.completed_by must reference a user in the task''s company'
      USING ERRCODE = '23503', CONSTRAINT = 'task_checklist_items_same_company';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER "task_checklist_items_same_company"
  BEFORE INSERT OR UPDATE OF "task_id", "completed_by"
  ON "task_checklist_items"
  FOR EACH ROW
  EXECUTE FUNCTION "task_checklist_items_enforce_same_company"();

CREATE OR REPLACE FUNCTION "task_progress_updates_enforce_same_company"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."employee_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "tasks" t JOIN "employees" e ON e."company_id" = t."company_id"
    WHERE t."id" = NEW."task_id" AND e."id" = NEW."employee_id"
  ) THEN
    RAISE EXCEPTION 'task_progress_updates.employee_id must reference an employee in the task''s company'
      USING ERRCODE = '23503', CONSTRAINT = 'task_progress_updates_same_company';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "tasks" t JOIN "users" u ON u."company_id" = t."company_id"
    WHERE t."id" = NEW."task_id" AND u."id" = NEW."created_by"
  ) THEN
    RAISE EXCEPTION 'task_progress_updates.created_by must reference a user in the task''s company'
      USING ERRCODE = '23503', CONSTRAINT = 'task_progress_updates_same_company';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER "task_progress_updates_same_company"
  BEFORE INSERT
  ON "task_progress_updates"
  FOR EACH ROW
  EXECUTE FUNCTION "task_progress_updates_enforce_same_company"();

-- ===========================================================================
-- Least privilege — DOCUMENT 20 §3.
--
-- Phase 3's `ALTER DEFAULT PRIVILEGES` grants SELECT, INSERT, UPDATE and
-- DELETE on every new table, so the REVOKEs are what do the work (the
-- lesson recorded in docs/PHASE-6-STATUS.md):
--
--   * tasks — soft delete only (DOCUMENT 06 §6). No DELETE.
--   * task_checklist_items — an item is removed outright (DOCUMENT 06 §3.16
--     gives it no `deleted_at`; DOCUMENT 05 FLOW 11 "Delete → denominator
--     decreases"). Full DML.
--   * task_progress_updates — append-only (DOCUMENT 13 rule 9). No UPDATE,
--     no DELETE.
-- ===========================================================================
GRANT SELECT, INSERT, UPDATE ON "tasks" TO "ufuq_app";
REVOKE DELETE ON "tasks" FROM "ufuq_app";

GRANT SELECT, INSERT, UPDATE, DELETE ON "task_checklist_items" TO "ufuq_app";

GRANT SELECT, INSERT ON "task_progress_updates" TO "ufuq_app";
REVOKE UPDATE, DELETE ON "task_progress_updates" FROM "ufuq_app";

-- ===========================================================================
-- Row-level security — AD-03, DOCUMENT 20 §3, DOCUMENT 27 RULE 10.
-- `packages/db/test/phase7-rls.test.ts` proves every policy against queries
-- with no WHERE clause.
-- ===========================================================================
ALTER TABLE "tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tasks" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "tasks"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

-- The child tables have no tenant column of their own, so their policies walk
-- the foreign key. The subquery reads `tasks`, which is itself row-secured for
-- this role — so a child whose task belongs to another company is invisible
-- for exactly the reason its task is, and cannot be written under a task the
-- caller cannot see.
ALTER TABLE "task_checklist_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_checklist_items" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "task_checklist_items"
  USING (EXISTS (SELECT 1 FROM "tasks" t WHERE t."id" = "task_id"))
  WITH CHECK (EXISTS (SELECT 1 FROM "tasks" t WHERE t."id" = "task_id"));

ALTER TABLE "task_progress_updates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_progress_updates" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "task_progress_updates"
  USING (EXISTS (SELECT 1 FROM "tasks" t WHERE t."id" = "task_id"))
  WITH CHECK (EXISTS (SELECT 1 FROM "tasks" t WHERE t."id" = "task_id"));

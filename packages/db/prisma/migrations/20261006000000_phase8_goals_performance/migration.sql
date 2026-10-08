-- ===========================================================================
-- Phase 8 — goals and performance (DOCUMENT 06 §3.18–3.19, DOCUMENT 14,
-- DOCUMENT 25 Phase 8)
--
-- MIGRATION IMPLICATIONS — DOCUMENT 27 RULE 31
--
--   What data exists:   `goals`, `goal_progress` and `performance_config` are
--                       new, so no existing table's data is migrated. One
--                       existing table is altered: `tasks` gains a nullable
--                       `goal_id`. Every existing task gets NULL — no task was
--                       ever linked to a goal, because goals did not exist.
--   Backfill:           every existing company receives one
--                       `performance_config` row holding DOCUMENT 14's
--                       documented default model. Companies created later
--                       receive the same row from a trigger on `companies`, so
--                       the performance engine never meets a company without a
--                       configuration and never needs a default of its own.
--   In-flight records:  none. Nothing reads or writes the new tables until the
--                       Phase 8 endpoints are deployed alongside this file.
--                       Existing task writes are unaffected: `goal_id` is
--                       optional and the widened same-company trigger checks it
--                       only when it is set.
--   Reversibility:      reversible while the three tables are empty — drop
--                       `tasks.goal_id`, restore the Phase 7 trigger function,
--                       drop the company trigger, the three tables, their
--                       triggers and functions, and the three new types. The
--                       six values added to `audit_action` are not reversible
--                       (PostgreSQL cannot remove an enum value); that is
--                       intentional, as in Phases 4–7: an audit action that has
--                       been written must stay readable forever (DOCUMENT 21).
--
-- `ALTER TYPE … ADD VALUE` is safe inside the migration transaction on
-- PostgreSQL 12+ because nothing in this file uses the new values.
--
-- Columns DOCUMENT 06 does not name, each required by a documented rule:
--
--   * `goal_progress.target_value` — DOCUMENT 14 edge case "Target changed
--     mid-period: … the progress history retains the old target so the chart
--     does not lie". The history can only retain a target it stores.
--   * `goals.created_at` / `updated_at`, `goal_progress.created_at` and
--     `performance_config.updated_by` — DOCUMENT 06 §1.6 timestamps and actor.
--
-- See docs/PHASE-8-STATUS.md.
-- ===========================================================================

CREATE TYPE "goal_type" AS ENUM ('sales', 'task', 'custom');

CREATE TYPE "goal_status" AS ENUM ('active', 'achieved', 'missed', 'cancelled');

CREATE TYPE "goal_progress_source" AS ENUM ('manual', 'system');

-- DOCUMENT 21 "Tasks & goals" — the goal half — and "Settings".
ALTER TYPE "audit_action" ADD VALUE 'goal.created';
ALTER TYPE "audit_action" ADD VALUE 'goal.updated';
ALTER TYPE "audit_action" ADD VALUE 'goal.progress_updated';
ALTER TYPE "audit_action" ADD VALUE 'goal.target_changed';
ALTER TYPE "audit_action" ADD VALUE 'goal.cancelled';
ALTER TYPE "audit_action" ADD VALUE 'settings.performance_weights_changed';

-- ---------------------------------------------------------------------------
-- goals — DOCUMENT 06 §3.18
-- ---------------------------------------------------------------------------
CREATE TABLE "goals" (
  "id"              UUID           NOT NULL,
  "company_id"      UUID           NOT NULL,
  "employee_id"     UUID           NOT NULL,
  "type"            "goal_type"    NOT NULL,
  "title"           VARCHAR(255)   NOT NULL,
  "description"     TEXT,
  "target_value"    DECIMAL(15,2)  NOT NULL,
  "current_value"   DECIMAL(15,2)  NOT NULL DEFAULT 0,
  "unit"            VARCHAR(20)    NOT NULL,
  "period_start"    DATE           NOT NULL,
  "period_end"      DATE           NOT NULL,
  "status"          "goal_status"  NOT NULL DEFAULT 'active',
  "task_count_rule" JSONB,
  "created_by"      UUID           NOT NULL,
  "created_at"      TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMPTZ(3) NOT NULL,
  -- DOCUMENT 06 §6: goals are soft-deleted for reporting integrity.
  "deleted_at"      TIMESTAMPTZ(3),

  CONSTRAINT "goals_pkey" PRIMARY KEY ("id"),

  CONSTRAINT "goals_title_present" CHECK (btrim("title") <> ''),
  CONSTRAINT "goals_unit_present" CHECK (btrim("unit") <> ''),
  -- DOCUMENT 14 validation: "`target_value` > 0" — zero would divide by zero.
  CONSTRAINT "goals_target_positive" CHECK ("target_value" > 0),
  -- DOCUMENT 14 validation: "Progress value must be numeric and non-negative".
  CONSTRAINT "goals_current_non_negative" CHECK ("current_value" >= 0),
  -- DOCUMENT 14 rule 8: "`period_end` must be after `period_start`".
  CONSTRAINT "goals_period_order" CHECK ("period_end" > "period_start"),
  -- DOCUMENT 14 validation: "Task goals require a `task_count_rule`", and
  -- DOCUMENT 06 §3.18 "(task type only)".
  CONSTRAINT "goals_task_rule_matches_type" CHECK (
    ("type" = 'task') = ("task_count_rule" IS NOT NULL)
  ),
  CONSTRAINT "goals_task_rule_is_object" CHECK (
    "task_count_rule" IS NULL OR jsonb_typeof("task_count_rule") = 'object'
  )
);

ALTER TABLE "goals" ADD CONSTRAINT "goals_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RESTRICT: DOCUMENT 14 "the goal stays with the employee"; it is history.
ALTER TABLE "goals" ADD CONSTRAINT "goals_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "goals" ADD CONSTRAINT "goals_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- DOCUMENT 14 "Database requirements".
CREATE INDEX "goals_company_id_employee_id_status_idx" ON "goals"("company_id", "employee_id", "status");
CREATE INDEX "goals_company_id_period_end_idx" ON "goals"("company_id", "period_end");

-- ---------------------------------------------------------------------------
-- goal_progress — DOCUMENT 06 §3.19. Append-only (DOCUMENT 14 rules 5 and 9).
--
-- No `company_id`: DOCUMENT 06 §3.19 does not define one. Tenancy is reached
-- through the parent goal — the `task_progress_updates` pattern.
-- ---------------------------------------------------------------------------
CREATE TABLE "goal_progress" (
  "id"             UUID                   NOT NULL,
  "goal_id"        UUID                   NOT NULL,
  "value"          DECIMAL(15,2)          NOT NULL,
  -- Null only on a goal's first row: there was no value before it.
  "previous_value" DECIMAL(15,2),
  "target_value"   DECIMAL(15,2)          NOT NULL,
  "note"           TEXT,
  "source"         "goal_progress_source" NOT NULL,
  "created_by"     UUID                   NOT NULL,
  "created_at"     TIMESTAMPTZ(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "goal_progress_pkey" PRIMARY KEY ("id"),

  CONSTRAINT "goal_progress_value_non_negative" CHECK ("value" >= 0),
  CONSTRAINT "goal_progress_previous_non_negative" CHECK (
    "previous_value" IS NULL OR "previous_value" >= 0
  ),
  CONSTRAINT "goal_progress_target_positive" CHECK ("target_value" > 0),
  CONSTRAINT "goal_progress_note_present" CHECK ("note" IS NULL OR btrim("note") <> ''),
  CONSTRAINT "goal_progress_note_length" CHECK ("note" IS NULL OR char_length("note") <= 1000)
);

-- RESTRICT, not CASCADE: the history outlives anything done to its goal. Goals
-- are only ever soft-deleted, so this never fires in normal operation.
ALTER TABLE "goal_progress" ADD CONSTRAINT "goal_progress_goal_id_fkey"
  FOREIGN KEY ("goal_id") REFERENCES "goals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "goal_progress" ADD CONSTRAINT "goal_progress_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- DOCUMENT 14 "Database requirements".
CREATE INDEX "goal_progress_goal_id_created_at_idx" ON "goal_progress"("goal_id", "created_at");

-- ---------------------------------------------------------------------------
-- tasks.goal_id — DOCUMENT 06 §3.15, deferred from Phase 7.
-- DOCUMENT 13 "Database requirements": "`goal_id` is SET NULL on goal deletion".
-- ---------------------------------------------------------------------------
ALTER TABLE "tasks" ADD COLUMN "goal_id" UUID;

ALTER TABLE "tasks" ADD CONSTRAINT "tasks_goal_id_fkey"
  FOREIGN KEY ("goal_id") REFERENCES "goals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Serves Task-goal derivation ("the qualifying completed tasks linked to this
-- goal") and the `goal_id` filter on `GET /tasks` (DOCUMENT 08 §4.7).
CREATE INDEX "tasks_goal_id_status_idx" ON "tasks"("goal_id", "status");

-- ---------------------------------------------------------------------------
-- performance_config — DOCUMENT 14 "Database requirements": "stored per
-- company as structured JSON with a schema version".
-- ---------------------------------------------------------------------------
CREATE TABLE "performance_config" (
  "id"             UUID           NOT NULL,
  "company_id"     UUID           NOT NULL,
  "schema_version" INTEGER        NOT NULL,
  "config"         JSONB          NOT NULL,
  -- Null for the documented default the database wrote; set by every save.
  "updated_by"     UUID,
  "created_at"     TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "performance_config_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "performance_config_schema_version_positive" CHECK ("schema_version" >= 1),
  CONSTRAINT "performance_config_is_object" CHECK (jsonb_typeof("config") = 'object')
);

-- One configuration per company — "per-company weights" (DOCUMENT 14 "Data").
CREATE UNIQUE INDEX "performance_config_company_id_key" ON "performance_config"("company_id");

ALTER TABLE "performance_config" ADD CONSTRAINT "performance_config_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "performance_config" ADD CONSTRAINT "performance_config_updated_by_fkey"
  FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===========================================================================
-- The documented default model — DOCUMENT 14 "Default weights (a starting
-- point, fully configurable)".
--
-- This is the ONLY place the default numbers exist. They are data, written
-- once per company; the performance engine reads the company's row and holds
-- no weight, penalty or coefficient of its own (DOCUMENT 14 "Critical rule",
-- DOCUMENT 25 Phase 8 exit criterion, DOCUMENT 27 RULE 13).
-- ===========================================================================
CREATE OR REPLACE FUNCTION "performance_config_default"()
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_build_object(
    'weights', jsonb_build_object('attendance', '0.3000', 'task', '0.4000', 'goal', '0.3000'),
    'attendance', jsonb_build_object('late_penalty', '1.00', 'absence_penalty', '5.00'),
    'task', jsonb_build_object('completion_weight', '0.6000', 'on_time_weight', '0.4000')
  )
$$;

-- OD-12 asks for time-ordered UUID v7 keys. A row the database writes on its
-- own still gets one: the millisecond clock in the first 48 bits and the
-- version nibble set to 7 over an otherwise random UUID — the same layout
-- `generateId()` produces in the application.
CREATE OR REPLACE FUNCTION "performance_config_new_id"()
RETURNS UUID
LANGUAGE sql
VOLATILE
AS $$
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

INSERT INTO "performance_config" ("id", "company_id", "schema_version", "config")
SELECT "performance_config_new_id"(), c."id", 1, "performance_config_default"()
FROM "companies" c;

-- SECURITY DEFINER so that whichever role creates a company, its
-- configuration is written; `search_path` is pinned, as for every definer
-- function since the Phase 6 search-path migrations.
CREATE OR REPLACE FUNCTION "companies_create_performance_config"()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO "performance_config" ("id", "company_id", "schema_version", "config")
  VALUES ("performance_config_new_id"(), NEW."id", 1, "performance_config_default"())
  ON CONFLICT ("company_id") DO NOTHING;
  RETURN NEW;
END
$$;

CREATE TRIGGER "companies_performance_config"
  AFTER INSERT ON "companies"
  FOR EACH ROW
  EXECUTE FUNCTION "companies_create_performance_config"();

-- ===========================================================================
-- Same-company references — DOCUMENT 07 §9 invariant 7, as in Phases 5–7.
-- PostgreSQL checks a foreign key without applying row security, so a key
-- alone would accept another company's employee, user or goal.
-- ===========================================================================
CREATE OR REPLACE FUNCTION "goals_enforce_same_company"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "employees" e
    WHERE e."id" = NEW."employee_id" AND e."company_id" = NEW."company_id"
  ) THEN
    RAISE EXCEPTION 'goals.employee_id must reference an employee in the same company'
      USING ERRCODE = '23503', CONSTRAINT = 'goals_same_company';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "users" u WHERE u."id" = NEW."created_by" AND u."company_id" = NEW."company_id"
  ) THEN
    RAISE EXCEPTION 'goals.created_by must reference a user in the same company'
      USING ERRCODE = '23503', CONSTRAINT = 'goals_same_company';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER "goals_same_company"
  BEFORE INSERT OR UPDATE OF "company_id", "employee_id", "created_by"
  ON "goals"
  FOR EACH ROW
  EXECUTE FUNCTION "goals_enforce_same_company"();

CREATE OR REPLACE FUNCTION "goal_progress_enforce_same_company"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "goals" g JOIN "users" u ON u."company_id" = g."company_id"
    WHERE g."id" = NEW."goal_id" AND u."id" = NEW."created_by"
  ) THEN
    RAISE EXCEPTION 'goal_progress.created_by must reference a user in the goal''s company'
      USING ERRCODE = '23503', CONSTRAINT = 'goal_progress_same_company';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER "goal_progress_same_company"
  BEFORE INSERT
  ON "goal_progress"
  FOR EACH ROW
  EXECUTE FUNCTION "goal_progress_enforce_same_company"();

-- DOCUMENT 06 §3.19 "Append-only history. Never update in place." The REVOKE
-- below is what stops the application; this trigger also stops every other
-- role, the table owner included, so "never" holds however a row is reached.
CREATE OR REPLACE FUNCTION "goal_progress_refuse_change"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'goal_progress is append-only: % is not permitted', TG_OP
    USING ERRCODE = '42501';
END
$$;

CREATE TRIGGER "goal_progress_append_only"
  BEFORE UPDATE OR DELETE
  ON "goal_progress"
  FOR EACH ROW
  EXECUTE FUNCTION "goal_progress_refuse_change"();

-- `tasks` gains a reference, so the Phase 7 check is widened to cover it. The
-- function body is the Phase 7 one plus the goal clause; the trigger is
-- re-created to fire on `goal_id` as well.
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

  IF NEW."goal_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "goals" g WHERE g."id" = NEW."goal_id" AND g."company_id" = NEW."company_id"
  ) THEN
    RAISE EXCEPTION 'tasks.goal_id must reference a goal in the same company'
      USING ERRCODE = '23503', CONSTRAINT = 'tasks_same_company';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER "tasks_same_company" ON "tasks";

CREATE TRIGGER "tasks_same_company"
  BEFORE INSERT OR UPDATE OF "company_id", "assignee_employee_id", "department_id", "created_by", "goal_id"
  ON "tasks"
  FOR EACH ROW
  EXECUTE FUNCTION "tasks_enforce_same_company"();

CREATE OR REPLACE FUNCTION "performance_config_enforce_same_company"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."updated_by" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "users" u WHERE u."id" = NEW."updated_by" AND u."company_id" = NEW."company_id"
  ) THEN
    RAISE EXCEPTION 'performance_config.updated_by must reference a user in the same company'
      USING ERRCODE = '23503', CONSTRAINT = 'performance_config_same_company';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER "performance_config_same_company"
  BEFORE INSERT OR UPDATE OF "company_id", "updated_by"
  ON "performance_config"
  FOR EACH ROW
  EXECUTE FUNCTION "performance_config_enforce_same_company"();

-- ===========================================================================
-- Least privilege — DOCUMENT 20 §3. Phase 3's default privileges grant
-- SELECT, INSERT, UPDATE and DELETE on every new table, so the REVOKEs are
-- what do the work (the lesson recorded in docs/PHASE-6-STATUS.md):
--
--   * goals — soft delete only (DOCUMENT 06 §6). No DELETE.
--   * goal_progress — append-only (DOCUMENT 06 §3.19). No UPDATE, no DELETE.
--   * performance_config — one row per company, written by the database when
--     the company is created and only ever updated afterwards. No INSERT, no
--     DELETE.
-- ===========================================================================
GRANT SELECT, INSERT, UPDATE ON "goals" TO "ufuq_app";
REVOKE DELETE ON "goals" FROM "ufuq_app";

GRANT SELECT, INSERT ON "goal_progress" TO "ufuq_app";
REVOKE UPDATE, DELETE ON "goal_progress" FROM "ufuq_app";

GRANT SELECT, UPDATE ON "performance_config" TO "ufuq_app";
REVOKE INSERT, DELETE ON "performance_config" FROM "ufuq_app";

-- ===========================================================================
-- Row-level security — AD-03, DOCUMENT 20 §3, DOCUMENT 27 RULE 10.
-- `packages/db/test/phase8-rls.test.ts` proves every policy against queries
-- with no WHERE clause.
-- ===========================================================================
ALTER TABLE "goals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "goals" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "goals"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

-- The history has no tenant column of its own, so its policy walks the goal,
-- which is itself row-secured for this role.
ALTER TABLE "goal_progress" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "goal_progress" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "goal_progress"
  USING (EXISTS (SELECT 1 FROM "goals" g WHERE g."id" = "goal_id"))
  WITH CHECK (EXISTS (SELECT 1 FROM "goals" g WHERE g."id" = "goal_id"));

ALTER TABLE "performance_config" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "performance_config" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "performance_config"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

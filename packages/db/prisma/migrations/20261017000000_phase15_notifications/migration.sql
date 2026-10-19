-- ===========================================================================
-- Phase 15 — notifications (DOCUMENT 06 §3.34, DOCUMENT 19, DOCUMENT 25 Phase 15)
--
-- MIGRATION IMPLICATIONS — DOCUMENT 27 RULE 31
--
--   What data exists:   every source module. Nothing here touches their
--                       tables: notifications are written after a source
--                       transaction commits, from its published events.
--   Backfill:           none. Events before this migration were handed to the
--                       deferred sinks and are not replayed (no notification
--                       for history nobody was told about at the time).
--   In-flight records:  none.
--   Reversibility:      the three tables can be dropped; the enum values
--                       added to `audit_action` are not reversible, as in
--                       earlier phases.
--
-- What is added:
--
--   * `notifications` — DOCUMENT 06 §3.34 / DOCUMENT 19 "Data", both language
--     variants stored. Columns DOCUMENT 06 does not name (documented
--     amendment):
--       - `priority` (DOCUMENT 19's High / Medium / Low) and `audience`
--         (`admin` for the admin / manager table, `employee` for the employee
--         table) — which side of the product the source link opens;
--       - `event_id` — the source event the notification came from;
--       - `group_count` / `grouped_into_id` — DOCUMENT 19 rule 4: more than
--         three of one type for one user within an hour collapse into one
--         summary row; the rows it absorbed point at it and leave the feed;
--       - `handled_at` — the "Multiple approvers" edge case: the first
--         decision marks the other approvers' notifications handled;
--       - `updated_at`.
--   * `notification_events` — one row per source event processed, unique per
--     company and event key. It is what makes delivery idempotent (a retried
--     event creates nothing twice) and what DOCUMENT 19 rule 3's "once per
--     crossing / once per task" is enforced by.
--   * `company_notification_settings` — DOCUMENT 19 rule 10: per-event
--     channel preferences in company settings. A missing row is the default:
--     enabled. V1 has one channel, `in_app`.
-- ===========================================================================

-- DOCUMENT 21 "Settings & data access": catalogued, never added to the type.
ALTER TYPE "audit_action" ADD VALUE 'settings.notification_changed';

CREATE TYPE "notification_type" AS ENUM (
  -- DOCUMENT 19 "Admin / manager notifications"
  'leave_request_submitted',
  'attendance_correction_submitted',
  'request_submitted',
  'task_overdue',
  'low_stock',
  'out_of_stock',
  'goal_milestone',
  'payroll_ready',
  'employee_missing_checkout',
  'tasks_need_reassignment',
  -- DOCUMENT 19 "Employee notifications" (`goal_milestone` above serves both)
  'task_assigned',
  'task_deadline_approaching',
  'task_updated',
  'leave_approved',
  'leave_rejected',
  'correction_approved',
  'correction_rejected',
  'request_reviewed',
  'salary_finalized',
  'goal_assigned',
  'monthly_report_ready',
  'missing_checkout',
  -- DOCUMENT 18 "Performance" / "Error states": a background export's
  -- completion and failure notify the requester (Phase 12's event boundary).
  'report_export_completed',
  'report_export_failed'
);

CREATE TYPE "notification_channel" AS ENUM ('in_app', 'email', 'push');
CREATE TYPE "notification_priority" AS ENUM ('high', 'medium', 'low');

-- ---------------------------------------------------------------------------
-- notification_events — the processed-event ledger
-- ---------------------------------------------------------------------------
CREATE TABLE "notification_events" (
    "id"          UUID           NOT NULL,
    "company_id"  UUID           NOT NULL,
    "event_key"   VARCHAR(200)   NOT NULL,
    "event_type"  VARCHAR(60)    NOT NULL,
    "created_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "notification_events_company_id_event_key_key"
  ON "notification_events"("company_id", "event_key");
CREATE INDEX "notification_events_company_id_created_at_idx"
  ON "notification_events"("company_id", "created_at");
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- notifications — DOCUMENT 06 §3.34
-- ---------------------------------------------------------------------------
CREATE TABLE "notifications" (
    "id"              UUID                    NOT NULL,
    "company_id"      UUID                    NOT NULL,
    "user_id"         UUID                    NOT NULL,
    "type"            "notification_type"     NOT NULL,
    "priority"        "notification_priority" NOT NULL,
    "audience"        VARCHAR(10)             NOT NULL,
    "channel"         "notification_channel"  NOT NULL DEFAULT 'in_app',
    "title_ar"        VARCHAR(300)            NOT NULL,
    "title_en"        VARCHAR(300)            NOT NULL,
    "body_ar"         VARCHAR(1000)           NOT NULL,
    "body_en"         VARCHAR(1000)           NOT NULL,
    "related_type"    VARCHAR(40)             NOT NULL,
    "related_id"      UUID,
    "event_id"        UUID,
    "group_count"     INTEGER                 NOT NULL DEFAULT 1,
    "grouped_into_id" UUID,
    "handled_at"      TIMESTAMPTZ(3),
    "read_at"         TIMESTAMPTZ(3),
    "created_at"      TIMESTAMPTZ(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMPTZ(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notifications_audience_known" CHECK ("audience" IN ('admin', 'employee')),
    CONSTRAINT "notifications_related_type_known" CHECK ("related_type" IN (
      'request', 'task', 'goal', 'product', 'payroll_period', 'attendance_record',
      'employee', 'monthly_report', 'report_export'
    )),
    CONSTRAINT "notifications_group_count_positive" CHECK ("group_count" >= 1),
    -- DOCUMENT 19 rule 5: every notification links to its source. Only a
    -- summary (more than one item) links to the list instead of one record.
    CONSTRAINT "notifications_has_source" CHECK ("related_id" IS NOT NULL OR "group_count" > 1),
    CONSTRAINT "notifications_not_grouped_into_self" CHECK ("grouped_into_id" IS NULL OR "grouped_into_id" <> "id"),
    CONSTRAINT "notifications_content_present" CHECK (
      length("title_ar") > 0 AND length("title_en") > 0 AND length("body_ar") > 0 AND length("body_en") > 0
    )
);
-- DOCUMENT 19 "Database requirements": the unread badge and the list.
CREATE INDEX "notifications_user_id_read_at_created_at_idx"
  ON "notifications"("user_id", "read_at", "created_at");
-- The feed (newest first, summaries' absorbed rows excluded) and grouping.
CREATE INDEX "notifications_user_id_type_created_at_idx"
  ON "notifications"("user_id", "type", "created_at");
-- "Marked handled for the others" finds every approver's copy by its source.
CREATE INDEX "notifications_company_id_related_type_related_id_idx"
  ON "notifications"("company_id", "related_type", "related_id");
-- Retention (DOCUMENT 19 rule 8) deletes by age, per company.
CREATE INDEX "notifications_company_id_created_at_idx"
  ON "notifications"("company_id", "created_at");
CREATE INDEX "notifications_grouped_into_id_idx" ON "notifications"("grouped_into_id");

ALTER TABLE "notifications" ADD CONSTRAINT "notifications_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_event_id_fkey"
  FOREIGN KEY ("event_id") REFERENCES "notification_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_grouped_into_id_fkey"
  FOREIGN KEY ("grouped_into_id") REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- DOCUMENT 19 "Validation": the recipient is an active, real (not system)
-- user of the same company. Checked on INSERT only: a user deactivated after
-- the notification was stored keeps it ("Notification created just as the
-- user is deactivated: stored, never dispatched").
CREATE OR REPLACE FUNCTION "notifications_enforce_recipient"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  ok BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM "users"
     WHERE "id" = NEW."user_id" AND "company_id" = NEW."company_id"
       AND "status" = 'active' AND NOT "is_system" AND "deleted_at" IS NULL
  ) INTO ok;
  IF NOT ok THEN
    RAISE EXCEPTION 'notifications.user_id must be an active user of the same company'
      USING ERRCODE = '23503', CONSTRAINT = 'notifications_recipient_active';
  END IF;
  PERFORM "stock_assert_same_company"('notifications', 'grouped_into_id', 'notifications', NEW."grouped_into_id", NEW."company_id");
  RETURN NEW;
END
$$;
CREATE TRIGGER "notifications_enforce_recipient"
  BEFORE INSERT ON "notifications"
  FOR EACH ROW EXECUTE FUNCTION "notifications_enforce_recipient"();

-- Who a notification is for, what it is and where it points never change.
-- Reading, handling and folding into a summary are the only updates.
CREATE OR REPLACE FUNCTION "notifications_guard_update"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" <> OLD."id" OR NEW."company_id" <> OLD."company_id" OR NEW."user_id" <> OLD."user_id"
     OR NEW."type" <> OLD."type" OR NEW."audience" <> OLD."audience" OR NEW."channel" <> OLD."channel"
     OR NEW."related_type" <> OLD."related_type" THEN
    RAISE EXCEPTION 'a notification''s recipient, type and source never change'
      USING ERRCODE = '42501';
  END IF;
  IF NEW."grouped_into_id" IS NOT NULL THEN
    PERFORM "stock_assert_same_company"('notifications', 'grouped_into_id', 'notifications', NEW."grouped_into_id", NEW."company_id");
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "notifications_guard_update"
  BEFORE UPDATE ON "notifications"
  FOR EACH ROW EXECUTE FUNCTION "notifications_guard_update"();

-- ---------------------------------------------------------------------------
-- company_notification_settings — DOCUMENT 19 rule 10
-- ---------------------------------------------------------------------------
CREATE TABLE "company_notification_settings" (
    "company_id" UUID                   NOT NULL,
    "type"       "notification_type"    NOT NULL,
    "channel"    "notification_channel" NOT NULL,
    "enabled"    BOOLEAN                NOT NULL,
    "updated_by" UUID                   NOT NULL,
    "updated_at" TIMESTAMPTZ(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_notification_settings_pkey" PRIMARY KEY ("company_id", "type", "channel")
);
ALTER TABLE "company_notification_settings" ADD CONSTRAINT "company_notification_settings_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "company_notification_settings" ADD CONSTRAINT "company_notification_settings_updated_by_fkey"
  FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "company_notification_settings_enforce_same_company"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "stock_assert_same_company"('company_notification_settings', 'updated_by', 'users', NEW."updated_by", NEW."company_id");
  RETURN NEW;
END
$$;
CREATE TRIGGER "company_notification_settings_same_company"
  BEFORE INSERT OR UPDATE ON "company_notification_settings"
  FOR EACH ROW EXECUTE FUNCTION "company_notification_settings_enforce_same_company"();

-- ===========================================================================
-- Least privilege — DOCUMENT 20 §3. Notifications may be hard-deleted
-- after the retention window (DOCUMENT 06 "Deletion", DOCUMENT 19 rule 8);
-- the processed-event ledger likewise. Settings are never deleted.
-- ===========================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications" TO "ufuq_app";
GRANT SELECT, INSERT, DELETE ON "notification_events" TO "ufuq_app";
REVOKE UPDATE, TRUNCATE ON "notification_events" FROM "ufuq_app";
GRANT SELECT, INSERT, UPDATE ON "company_notification_settings" TO "ufuq_app";
REVOKE DELETE, TRUNCATE ON "company_notification_settings" FROM "ufuq_app";
REVOKE TRUNCATE ON "notifications" FROM "ufuq_app";

-- ===========================================================================
-- Row-level security — AD-03. `packages/db/test/phase15-rls.test.ts`.
-- ===========================================================================
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "notifications"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

ALTER TABLE "notification_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notification_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "notification_events"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

ALTER TABLE "company_notification_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_notification_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "company_notification_settings"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

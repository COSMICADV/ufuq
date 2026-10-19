-- ===========================================================================
-- Phase 12 — reports (DOCUMENT 06 §3.27, DOCUMENT 18, DOCUMENT 25 Phase 12)
--
-- MIGRATION IMPLICATIONS — DOCUMENT 27 RULE 31
--
--   What data exists:   every source module (attendance, tasks, goals,
--                       payroll, warehouses, inventory). Nothing here touches
--                       them: reports read the tables the modules write and
--                       never keep a parallel truth (DOCUMENT 18 "Purpose").
--   Backfill:           none. `monthly_employee_reports` starts empty; the
--                       scheduled job and the on-demand endpoints fill it.
--   In-flight records:  none.
--   Reversibility:      both new tables can be dropped while empty. The three
--                       `audit_action` values are not reversible, as in
--                       earlier phases. The indexes can be dropped freely.
--
-- What is added:
--
--   * `monthly_employee_reports` — DOCUMENT 06 §3.27, the only persisted
--     reporting snapshot in V1. Two columns DOCUMENT 06 does not name
--     (documented amendment, DOCUMENT 06 §3.27):
--       - `source_fingerprint`: SHA-256 of the snapshot's content as it was
--         computed from the sources. A read recomputes the content and
--         compares, which is how "the underlying data has changed since"
--         (DOCUMENT 18 rule 2) is proven rather than guessed from timestamps;
--       - `revision` (+ `generated_by`): every regeneration is a new
--         revision. The database refuses an UPDATE that does not raise the
--         revision by exactly one, or that moves the snapshot to another
--         employee, company or month — so a snapshot can only change through
--         the explicit regeneration path (DOCUMENT 18 rule 1).
--   * `report_exports` — the background export jobs DOCUMENT 18 "Performance"
--     requires ("long-running exports run as background jobs"). Not a
--     reporting truth: a job's status and where its finished file is.
--   * Indexes for the company-wide stock-movement report (ordered by ledger
--     sequence, filtered by date) and the undated-task window.
-- ===========================================================================

-- DOCUMENT 21 "Reports": `report.exported` was catalogued but never added to
-- the type. `report.snapshot_generated` / `report.snapshot_regenerated` are
-- the approved Phase 12 amendment (DOCUMENT 18 rule 2: regeneration is
-- audited; DOCUMENT 21 rule 8: the monthly report job leaves records).
ALTER TYPE "audit_action" ADD VALUE 'report.exported';
ALTER TYPE "audit_action" ADD VALUE 'report.snapshot_generated';
ALTER TYPE "audit_action" ADD VALUE 'report.snapshot_regenerated';

CREATE TYPE "report_export_status" AS ENUM ('queued', 'running', 'completed', 'failed');

-- ---------------------------------------------------------------------------
-- monthly_employee_reports — DOCUMENT 06 §3.27
-- ---------------------------------------------------------------------------
CREATE TABLE "monthly_employee_reports" (
    "id"                 UUID           NOT NULL,
    "company_id"         UUID           NOT NULL,
    "employee_id"        UUID           NOT NULL,
    "year"               SMALLINT       NOT NULL,
    "month"              SMALLINT       NOT NULL,
    "attendance_summary" JSONB          NOT NULL,
    "task_summary"       JSONB          NOT NULL,
    "goal_summary"       JSONB          NOT NULL,
    "salary_summary"     JSONB          NOT NULL,
    "performance_scores" JSONB          NOT NULL,
    "overall_score"      DECIMAL(5,2),
    "generated_at"       TIMESTAMPTZ(3) NOT NULL,
    "generated_by"       UUID           NOT NULL,
    "is_provisional"     BOOLEAN        NOT NULL,
    "source_fingerprint" CHAR(64)       NOT NULL,
    "revision"           INTEGER        NOT NULL DEFAULT 1,
    "created_at"         TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"         TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "monthly_employee_reports_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "monthly_employee_reports_month_valid" CHECK ("month" BETWEEN 1 AND 12),
    CONSTRAINT "monthly_employee_reports_year_valid" CHECK ("year" BETWEEN 2000 AND 2999),
    CONSTRAINT "monthly_employee_reports_overall_range"
      CHECK ("overall_score" IS NULL OR ("overall_score" >= 0 AND "overall_score" <= 100)),
    CONSTRAINT "monthly_employee_reports_fingerprint_hex" CHECK ("source_fingerprint" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "monthly_employee_reports_revision_positive" CHECK ("revision" >= 1)
);
CREATE UNIQUE INDEX "monthly_employee_reports_employee_id_year_month_key"
  ON "monthly_employee_reports"("employee_id", "year", "month");
CREATE INDEX "monthly_employee_reports_company_id_year_month_idx"
  ON "monthly_employee_reports"("company_id", "year", "month");
ALTER TABLE "monthly_employee_reports" ADD CONSTRAINT "monthly_employee_reports_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "monthly_employee_reports" ADD CONSTRAINT "monthly_employee_reports_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "monthly_employee_reports" ADD CONSTRAINT "monthly_employee_reports_generated_by_fkey"
  FOREIGN KEY ("generated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "monthly_employee_reports_enforce_same_company"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "stock_assert_same_company"('monthly_employee_reports', 'employee_id', 'employees', NEW."employee_id", NEW."company_id");
  PERFORM "stock_assert_same_company"('monthly_employee_reports', 'generated_by', 'users', NEW."generated_by", NEW."company_id");
  RETURN NEW;
END
$$;
CREATE TRIGGER "monthly_employee_reports_same_company"
  BEFORE INSERT OR UPDATE OF "company_id", "employee_id", "generated_by"
  ON "monthly_employee_reports" FOR EACH ROW EXECUTE FUNCTION "monthly_employee_reports_enforce_same_company"();

-- DOCUMENT 18 rule 1: "later edits to historical data do not silently
-- rewrite a generated report". The only legal change is a regeneration: the
-- same employee and month, the next revision, a new generation time.
CREATE OR REPLACE FUNCTION "monthly_employee_reports_guard_update"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."company_id" <> OLD."company_id" OR NEW."employee_id" <> OLD."employee_id"
     OR NEW."year" <> OLD."year" OR NEW."month" <> OLD."month" OR NEW."id" <> OLD."id" THEN
    RAISE EXCEPTION 'a monthly report snapshot cannot move to another employee or month'
      USING ERRCODE = '42501';
  END IF;
  IF NEW."revision" <> OLD."revision" + 1 OR NEW."generated_at" <= OLD."generated_at" THEN
    RAISE EXCEPTION 'a monthly report snapshot changes only by an explicit regeneration (revision % → %)',
      OLD."revision", NEW."revision"
      USING ERRCODE = '23514', CONSTRAINT = 'monthly_employee_reports_regeneration_only';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "monthly_employee_reports_guard_update"
  BEFORE UPDATE ON "monthly_employee_reports"
  FOR EACH ROW EXECUTE FUNCTION "monthly_employee_reports_guard_update"();

CREATE OR REPLACE FUNCTION "reports_no_hard_delete"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME USING ERRCODE = '42501';
END
$$;
CREATE TRIGGER "monthly_employee_reports_no_delete" BEFORE DELETE ON "monthly_employee_reports"
  FOR EACH ROW EXECUTE FUNCTION "reports_no_hard_delete"();

-- ---------------------------------------------------------------------------
-- report_exports — background CSV exports (DOCUMENT 18 "Performance")
-- ---------------------------------------------------------------------------
CREATE TABLE "report_exports" (
    "id"             UUID                   NOT NULL,
    "company_id"     UUID                   NOT NULL,
    "requested_by"   UUID                   NOT NULL,
    "report_key"     VARCHAR(40)            NOT NULL,
    "format"         VARCHAR(10)            NOT NULL,
    "filters"        JSONB                  NOT NULL,
    "scope"          JSONB                  NOT NULL,
    "locale"         VARCHAR(5)             NOT NULL,
    "status"         "report_export_status" NOT NULL DEFAULT 'queued',
    "row_count"      INTEGER,
    "storage_key"    VARCHAR(500),
    "failure_reason" TEXT,
    "created_at"     TIMESTAMPTZ(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at"     TIMESTAMPTZ(3),
    "completed_at"   TIMESTAMPTZ(3),
    "updated_at"     TIMESTAMPTZ(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_exports_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "report_exports_key_known" CHECK ("report_key" IN (
      'attendance', 'performance', 'tasks', 'goals', 'payroll', 'inventory', 'warehouse', 'stock-movements'
    )),
    CONSTRAINT "report_exports_format_known" CHECK ("format" IN ('csv')),
    CONSTRAINT "report_exports_locale_known" CHECK ("locale" IN ('ar', 'en')),
    CONSTRAINT "report_exports_completed_has_file"
      CHECK ("status" <> 'completed' OR ("storage_key" IS NOT NULL AND "row_count" IS NOT NULL)),
    CONSTRAINT "report_exports_failed_has_reason"
      CHECK ("status" <> 'failed' OR "failure_reason" IS NOT NULL)
);
CREATE INDEX "report_exports_company_id_requested_by_created_at_idx"
  ON "report_exports"("company_id", "requested_by", "created_at");
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_requested_by_fkey"
  FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "report_exports_enforce_same_company"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "stock_assert_same_company"('report_exports', 'requested_by', 'users', NEW."requested_by", NEW."company_id");
  RETURN NEW;
END
$$;
CREATE TRIGGER "report_exports_same_company"
  BEFORE INSERT OR UPDATE OF "company_id", "requested_by"
  ON "report_exports" FOR EACH ROW EXECUTE FUNCTION "report_exports_enforce_same_company"();
CREATE TRIGGER "report_exports_no_delete" BEFORE DELETE ON "report_exports"
  FOR EACH ROW EXECUTE FUNCTION "reports_no_hard_delete"();

-- ---------------------------------------------------------------------------
-- Report query indexes — DOCUMENT 18 "Performance": indexed, tenant-scoped.
-- ---------------------------------------------------------------------------
CREATE INDEX "stock_movements_company_id_sequence_idx" ON "stock_movements"("company_id", "sequence");
CREATE INDEX "stock_movements_company_id_created_at_idx" ON "stock_movements"("company_id", "created_at");
CREATE INDEX "tasks_company_id_created_at_idx" ON "tasks"("company_id", "created_at");

-- ===========================================================================
-- Least privilege — DOCUMENT 20 §3.
-- ===========================================================================
GRANT SELECT, INSERT, UPDATE ON "monthly_employee_reports" TO "ufuq_app";
REVOKE DELETE, TRUNCATE ON "monthly_employee_reports" FROM "ufuq_app";
GRANT SELECT, INSERT, UPDATE ON "report_exports" TO "ufuq_app";
REVOKE DELETE, TRUNCATE ON "report_exports" FROM "ufuq_app";

-- ===========================================================================
-- Row-level security — AD-03. `packages/db/test/phase12-rls.test.ts`.
-- ===========================================================================
ALTER TABLE "monthly_employee_reports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "monthly_employee_reports" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "monthly_employee_reports"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

ALTER TABLE "report_exports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "report_exports" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "report_exports"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

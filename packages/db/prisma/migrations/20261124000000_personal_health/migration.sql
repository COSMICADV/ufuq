-- ===========================================================================
-- 1to1OS Personal — Health, phase 1: medical documents.
--
-- MIGRATION IMPLICATIONS — DOCUMENT 27 RULE 31
--   What data exists:   none is changed. One table and one enum are added;
--                       the attachment store gains one related type.
--   In-flight records:  none.
--   Reversibility:      drop the table and type; restore the CHECK.
--
-- A health document is a record (title, category, date, notes); its pages are
-- private attachments (`related_type = 'health_document'`), served only
-- through the authorization-checked download, never by URL. Deleting moves a
-- document to the trash (`deleted_at`); after 30 days a daily job removes the
-- row and the stored bytes. Medical content is never written to logs.
-- `link_type`/`link_id` point at a medication, lab test or appointment once
-- those exist (phases 2–4).
-- ===========================================================================

CREATE TYPE "health_document_category" AS ENUM (
  'prescription', 'lab_result', 'medical_report', 'imaging', 'vaccination', 'insurance', 'other'
);

CREATE TABLE "health_documents" (
    "id"            UUID                       NOT NULL,
    "company_id"    UUID                       NOT NULL,
    "user_id"       UUID                       NOT NULL,
    "title"         VARCHAR(160)               NOT NULL,
    "category"      "health_document_category" NOT NULL,
    "document_date" DATE,
    "notes"         VARCHAR(2000),
    "link_type"     VARCHAR(20),
    "link_id"       UUID,
    "deleted_at"    TIMESTAMPTZ(3),
    "created_at"    TIMESTAMPTZ(3)             NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"    TIMESTAMPTZ(3)             NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "health_documents_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "health_documents_link_check" CHECK (("link_type" IS NULL) = ("link_id" IS NULL)),
    CONSTRAINT "health_documents_link_type_check" CHECK (
      "link_type" IS NULL OR "link_type" IN ('medication', 'lab_test', 'appointment')
    )
);
CREATE INDEX "health_documents_company_id_deleted_at_idx" ON "health_documents"("company_id", "deleted_at");
CREATE INDEX "health_documents_link_id_idx" ON "health_documents"("link_id");
ALTER TABLE "health_documents"
  ADD CONSTRAINT "health_documents_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "health_documents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE, DELETE ON "health_documents" TO "ufuq_app";

ALTER TABLE "health_documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "health_documents" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "health_documents"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

ALTER TABLE "attachments" DROP CONSTRAINT "attachments_related_type_known";
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_related_type_known"
  CHECK ("related_type" IN ('task', 'request', 'leave_request', 'product', 'finance_transaction', 'health_document'));

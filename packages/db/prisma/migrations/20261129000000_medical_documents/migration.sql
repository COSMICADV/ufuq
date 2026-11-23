-- ===========================================================================
-- 1to1OS Business — Medical, phase M1: patient documents (prescriptions, lab
-- results, imaging, reports …) with their categories.
--
-- MIGRATION IMPLICATIONS — DOCUMENT 27 RULE 31
--   What data exists:   none is changed. Two tables, five audit actions, and
--                       one more allowed attachment type.
--   In-flight records:  none.
--   Reversibility:      drop the tables; restore the previous CHECK list.
--
-- A document belongs to exactly one patient (and optionally one of that
-- patient's visits — enforced by the API and by the composite foreign key
-- below). Its pages are attachments (`related_type = 'medical_document'`),
-- private and audited on every download. The ten default categories live in
-- code; a company adds its own here. Each category has a kind — document, lab
-- or imaging — which decides the permission needed to see it.
-- Deleting a document only marks it (deleted_at): medical records are kept.
-- ===========================================================================

ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'medical_document.created';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'medical_document.updated';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'medical_document.archived';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'medical_document.deleted';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'medical_category.changed';

CREATE TABLE "medical_document_categories" (
    "id"          UUID           NOT NULL,
    "company_id"  UUID           NOT NULL,
    "name_ar"     VARCHAR(80)    NOT NULL,
    "name_en"     VARCHAR(80)    NOT NULL,
    "kind"        VARCHAR(10)    NOT NULL,
    "archived_at" TIMESTAMPTZ(3),
    "created_by"  UUID           NOT NULL,
    "created_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "medical_document_categories_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "medical_document_categories_kind_check" CHECK ("kind" IN ('document', 'lab', 'imaging'))
);
CREATE INDEX "medical_document_categories_company_id_idx" ON "medical_document_categories"("company_id");

-- Lets medical_documents point at (visit, patient) so a visit of another
-- patient can never be linked.
CREATE UNIQUE INDEX "medical_visits_id_patient_id_key" ON "medical_visits"("id", "patient_id");

CREATE TABLE "medical_documents" (
    "id"                 UUID           NOT NULL,
    "company_id"         UUID           NOT NULL,
    "patient_id"         UUID           NOT NULL,
    "visit_id"           UUID,
    "category_key"       VARCHAR(30),
    "custom_category_id" UUID,
    "title"              VARCHAR(200)   NOT NULL,
    "document_date"      DATE,
    "notes"              VARCHAR(2000),
    "source"             VARCHAR(10)    NOT NULL DEFAULT 'upload',
    "archived_at"        TIMESTAMPTZ(3),
    "deleted_at"         TIMESTAMPTZ(3),
    "created_by"         UUID           NOT NULL,
    "updated_by"         UUID,
    "created_at"         TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"         TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "medical_documents_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "medical_documents_category_check" CHECK (("category_key" IS NULL) <> ("custom_category_id" IS NULL)),
    CONSTRAINT "medical_documents_source_check" CHECK ("source" IN ('upload', 'camera'))
);
CREATE INDEX "medical_documents_patient_id_idx" ON "medical_documents"("patient_id", "deleted_at", "created_at");
CREATE INDEX "medical_documents_company_id_idx" ON "medical_documents"("company_id");
CREATE INDEX "medical_documents_visit_id_idx" ON "medical_documents"("visit_id");

ALTER TABLE "medical_document_categories"
  ADD CONSTRAINT "medical_document_categories_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "medical_document_categories_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "medical_documents"
  ADD CONSTRAINT "medical_documents_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "medical_documents_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "medical_documents_visit_patient_fkey" FOREIGN KEY ("visit_id", "patient_id") REFERENCES "medical_visits"("id", "patient_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "medical_documents_custom_category_id_fkey" FOREIGN KEY ("custom_category_id") REFERENCES "medical_document_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "medical_documents_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "medical_documents_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE ON "medical_document_categories", "medical_documents" TO "ufuq_app";

ALTER TABLE "medical_document_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "medical_document_categories" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "medical_document_categories"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);
ALTER TABLE "medical_documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "medical_documents" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "medical_documents"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

ALTER TABLE "attachments" DROP CONSTRAINT "attachments_related_type_known";
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_related_type_known"
  CHECK ("related_type" IN ('task', 'request', 'leave_request', 'product', 'finance_transaction', 'health_document', 'odometer_reading', 'medical_document'));

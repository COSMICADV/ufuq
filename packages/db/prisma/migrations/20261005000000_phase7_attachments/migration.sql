-- ===========================================================================
-- Phase 7 addendum — the generic attachment store (DOCUMENT 06 §3.36,
-- DOCUMENT 08 §4.14, DOCUMENT 20 §7, DOCUMENT 21, AD-02). Approved
-- 2026-10-05 ("Option A"): built now, with tasks as its first consumer.
--
-- MIGRATION IMPLICATIONS — DOCUMENT 27 RULE 31
--
--   What data exists:   `attachments` does not exist yet, so there is no data
--                       to migrate and no existing table is altered.
--   In-flight records:  none. Nothing reads or writes the table until the
--                       `/attachments` endpoints are deployed with this file.
--   Reversibility:      reversible while the table is empty — drop the
--                       trigger and its function, then the table. Objects
--                       already written to storage would have to be removed
--                       from the bucket separately. The three values added to
--                       `audit_action` are not reversible, for the same reason
--                       as every earlier phase: an audit action that has been
--                       written must stay readable (DOCUMENT 21, append-only).
--
-- `ALTER TYPE … ADD VALUE` is safe inside the migration transaction on
-- PostgreSQL 12+ because nothing in this file uses the new values.
--
-- The table is DOCUMENT 06 §3.36 column for column. Every rule below that can
-- be a property of the row is enforced here, so it holds however a row is
-- written:
--
--   * `mime_type` is DOCUMENT 20 §7's allowlist (PDF, PNG, JPG, WebP, DOCX,
--     XLSX) — the service also checks magic bytes, which a database cannot.
--   * `stored_path` is company-namespaced (DOCUMENT 20 §3 "Files"): it must
--     begin with the row's own company id, and it is unique.
--   * `related_type` is a closed list. Only `task` is wired in Phase 7;
--     employee photos, attendance corrections, leave and company logos add
--     themselves in their own work, each with its own authorization policy.
--   * No DELETE for the application role: DOCUMENT 08 §4.14 is a soft delete.
-- ===========================================================================

-- DOCUMENT 21 "Settings & data access".
ALTER TYPE "audit_action" ADD VALUE 'attachment.uploaded';
ALTER TYPE "audit_action" ADD VALUE 'attachment.deleted';
ALTER TYPE "audit_action" ADD VALUE 'attachment.accessed';

CREATE TABLE "attachments" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "uploaded_by" UUID NOT NULL,
    "original_name" VARCHAR(255) NOT NULL,
    "stored_path" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(127) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "checksum" CHAR(64) NOT NULL,
    "related_type" VARCHAR(50) NOT NULL,
    "related_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "attachments_original_name_not_blank" CHECK (btrim("original_name") <> ''),
    CONSTRAINT "attachments_mime_type_allowed" CHECK ("mime_type" IN (
      'application/pdf',
      'image/png',
      'image/jpeg',
      'image/webp',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )),
    CONSTRAINT "attachments_size_positive" CHECK ("size_bytes" > 0),
    -- SHA-256, lowercase hex.
    CONSTRAINT "attachments_checksum_sha256" CHECK ("checksum" ~ '^[0-9a-f]{64}$'),
    -- DOCUMENT 20 §3 "Files: company-namespaced paths".
    CONSTRAINT "attachments_stored_path_company_namespaced"
      CHECK (starts_with("stored_path", "company_id"::text || '/')),
    CONSTRAINT "attachments_related_type_known" CHECK ("related_type" IN ('task'))
);

CREATE UNIQUE INDEX "attachments_stored_path_key" ON "attachments"("stored_path");
-- The lookup every consumer makes: "the live attachments of this record".
CREATE INDEX "attachments_company_id_related_type_related_id_idx"
  ON "attachments"("company_id", "related_type", "related_id");

-- Historical: an attachment outlives nothing it belongs to being removed by
-- accident (DOCUMENT 06 §5).
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaded_by_fkey"
  FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- Same-company guard — DOCUMENT 07 §9 invariant 7. PostgreSQL checks a foreign
-- key without applying row security, and `related_id` is polymorphic (no
-- foreign key at all), so this trigger is what makes "attach to another
-- company's record" a refused write. Its lookups run as the caller and are
-- themselves row-secured.
-- ===========================================================================
CREATE OR REPLACE FUNCTION "attachments_enforce_same_company"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "users" u WHERE u."id" = NEW."uploaded_by" AND u."company_id" = NEW."company_id"
  ) THEN
    RAISE EXCEPTION 'attachments.uploaded_by must reference a user in the same company'
      USING ERRCODE = '23503', CONSTRAINT = 'attachments_same_company';
  END IF;

  IF NEW."related_type" = 'task' AND NOT EXISTS (
    SELECT 1 FROM "tasks" t WHERE t."id" = NEW."related_id" AND t."company_id" = NEW."company_id"
  ) THEN
    RAISE EXCEPTION 'attachments.related_id must reference a task in the same company'
      USING ERRCODE = '23503', CONSTRAINT = 'attachments_same_company';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER "attachments_same_company"
  BEFORE INSERT OR UPDATE OF "company_id", "uploaded_by", "related_type", "related_id"
  ON "attachments"
  FOR EACH ROW
  EXECUTE FUNCTION "attachments_enforce_same_company"();

-- ===========================================================================
-- Least privilege — DOCUMENT 20 §3. Soft delete only (DOCUMENT 08 §4.14), so
-- no DELETE; Phase 3's default privileges grant it, so the REVOKE does the
-- work.
-- ===========================================================================
GRANT SELECT, INSERT, UPDATE ON "attachments" TO "ufuq_app";
REVOKE DELETE ON "attachments" FROM "ufuq_app";

-- ===========================================================================
-- Row-level security — AD-03, DOCUMENT 20 §3. Proved in
-- `packages/db/test/phase7-attachments-rls.test.ts`.
-- ===========================================================================
ALTER TABLE "attachments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attachments" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "attachments"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

-- ===========================================================================
-- 1to1OS Business — Business Identity: the logo, names, colours and contact
-- details a business shows on its receipts, menus, documents and pages.
--
-- MIGRATION IMPLICATIONS — DOCUMENT 27 RULE 31
--   What data exists:   none is changed. One table and two audit actions.
--   In-flight records:  none.
--   Reversibility:      drop the table (enum values stay).
--
-- One row per company, created on first save; with no row the company's own
-- name is used. Logo bytes live in the private bucket under the company's own
-- prefix (companies/<id>/brand/…); this table holds only their keys, and the
-- API streams them to members of that company alone. A thermal-printer copy
-- (1-bit PNG) is kept beside the logo; `print_logo` false means receipts print
-- the business name as text instead.
-- Branch-level overrides arrive with branches (a separate table keyed by
-- branch), so this table stays one row per company.
-- ===========================================================================

ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'business_identity.updated';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'business_identity.logo_changed';

CREATE TABLE "business_identities" (
    "company_id"            UUID           NOT NULL,
    "name_ar"               VARCHAR(120),
    "name_en"               VARCHAR(120),
    "primary_color"         CHAR(7),
    "secondary_color"       CHAR(7),
    "phone"                 VARCHAR(40),
    "whatsapp"              VARCHAR(40),
    "email"                 VARCHAR(254),
    "website"               VARCHAR(300),
    "address_ar"            VARCHAR(300),
    "address_en"            VARCHAR(300),
    "instagram"             VARCHAR(300),
    "facebook"              VARCHAR(300),
    "tiktok"                VARCHAR(300),
    "logo_key"              VARCHAR(300),
    "logo_type"             VARCHAR(10),
    "logo_width"            INTEGER,
    "logo_height"           INTEGER,
    "thermal_key"           VARCHAR(300),
    "print_logo"            BOOLEAN        NOT NULL DEFAULT true,
    "logo_version"          INTEGER        NOT NULL DEFAULT 0,
    "onboarded_at"          TIMESTAMPTZ(3),
    "onboarding_skipped_at" TIMESTAMPTZ(3),
    "updated_by"            UUID,
    "created_at"            TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"            TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "business_identities_pkey" PRIMARY KEY ("company_id"),
    CONSTRAINT "business_identities_colors_check" CHECK (
      ("primary_color" IS NULL OR "primary_color" ~ '^#[0-9A-F]{6}$') AND
      ("secondary_color" IS NULL OR "secondary_color" ~ '^#[0-9A-F]{6}$')
    ),
    CONSTRAINT "business_identities_logo_check" CHECK (
      ("logo_key" IS NULL AND "logo_type" IS NULL) OR
      ("logo_key" IS NOT NULL AND "logo_type" IN ('png', 'jpeg', 'svg'))
    )
);

ALTER TABLE "business_identities"
  ADD CONSTRAINT "business_identities_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "business_identities_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE ON "business_identities" TO "ufuq_app";

ALTER TABLE "business_identities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "business_identities" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "business_identities"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

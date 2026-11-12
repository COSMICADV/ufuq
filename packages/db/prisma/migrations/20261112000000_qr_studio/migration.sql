-- QR Studio — the company's QR codes, their scans, ratings and uploaded files.
--
-- Every table is tenant-scoped like the rest of the schema (row-level security
-- on company_id). A scan arrives with no session, so the public scan page finds
-- a code's company through qr_lookup_slug / qr_lookup_file (SECURITY DEFINER,
-- like the auth_lookup_* functions) and then works inside that tenant.

CREATE TABLE "qr_codes" (
    "id"         UUID           NOT NULL,
    "company_id" UUID           NOT NULL,
    "created_by" UUID           NOT NULL,
    "slug"       VARCHAR(64)    NOT NULL,
    "name"       VARCHAR(200)   NOT NULL,
    "type"       VARCHAR(24)    NOT NULL,
    "record"     JSONB          NOT NULL,
    "scans"      INTEGER        NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qr_codes_pkey" PRIMARY KEY ("id"),
    -- The short link is a public URL path segment.
    CONSTRAINT "qr_codes_slug_format" CHECK ("slug" ~ '^[A-Za-z0-9_-]{2,64}$'),
    CONSTRAINT "qr_codes_scans_non_negative" CHECK ("scans" >= 0)
);
CREATE UNIQUE INDEX "qr_codes_slug_key" ON "qr_codes"("slug");
CREATE INDEX "qr_codes_company_id_created_at_idx" ON "qr_codes"("company_id", "created_at");
ALTER TABLE "qr_codes"
  ADD CONSTRAINT "qr_codes_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "qr_codes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "qr_scans" (
    "id"         UUID           NOT NULL,
    "company_id" UUID           NOT NULL,
    "qr_code_id" UUID           NOT NULL,
    "kind"       CHAR(1)        NOT NULL,
    "is_unique"  BOOLEAN        NOT NULL DEFAULT false,
    "os"         VARCHAR(40),
    "browser"    VARCHAR(40),
    "lang"       VARCHAR(10),
    "country"    CHAR(2),
    "city"       VARCHAR(80),
    "event"      VARCHAR(120),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qr_scans_pkey" PRIMARY KEY ("id"),
    -- s = scan, v = page visit, e = tracked click on the page.
    CONSTRAINT "qr_scans_kind_known" CHECK ("kind" IN ('s', 'v', 'e'))
);
CREATE INDEX "qr_scans_qr_code_id_created_at_idx" ON "qr_scans"("qr_code_id", "created_at");
CREATE INDEX "qr_scans_company_id_created_at_idx" ON "qr_scans"("company_id", "created_at");
ALTER TABLE "qr_scans"
  ADD CONSTRAINT "qr_scans_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "qr_scans_qr_code_id_fkey" FOREIGN KEY ("qr_code_id") REFERENCES "qr_codes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "qr_feedback" (
    "id"         UUID           NOT NULL,
    "company_id" UUID           NOT NULL,
    "qr_code_id" UUID           NOT NULL,
    "stars"      SMALLINT       NOT NULL,
    "body"       VARCHAR(1000)  NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qr_feedback_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "qr_feedback_stars_range" CHECK ("stars" BETWEEN 1 AND 5)
);
CREATE INDEX "qr_feedback_qr_code_id_created_at_idx" ON "qr_feedback"("qr_code_id", "created_at");
ALTER TABLE "qr_feedback"
  ADD CONSTRAINT "qr_feedback_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "qr_feedback_qr_code_id_fkey" FOREIGN KEY ("qr_code_id") REFERENCES "qr_codes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "qr_files" (
    "id"           UUID           NOT NULL,
    "company_id"   UUID           NOT NULL,
    "created_by"   UUID           NOT NULL,
    "storage_key"  VARCHAR(300)   NOT NULL,
    "file_name"    VARCHAR(255)   NOT NULL,
    "content_type" VARCHAR(100)   NOT NULL,
    "size_bytes"   INTEGER        NOT NULL,
    "created_at"   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qr_files_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "qr_files_size_positive" CHECK ("size_bytes" > 0)
);
CREATE UNIQUE INDEX "qr_files_storage_key_key" ON "qr_files"("storage_key");
CREATE INDEX "qr_files_company_id_created_at_idx" ON "qr_files"("company_id", "created_at");
ALTER TABLE "qr_files"
  ADD CONSTRAINT "qr_files_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "qr_files_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE, DELETE ON "qr_codes" TO "ufuq_app";
GRANT SELECT, INSERT, DELETE ON "qr_scans" TO "ufuq_app";
GRANT SELECT, INSERT, DELETE ON "qr_feedback" TO "ufuq_app";
GRANT SELECT, INSERT, DELETE ON "qr_files" TO "ufuq_app";

ALTER TABLE "qr_codes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "qr_codes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "qr_codes"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

ALTER TABLE "qr_scans" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "qr_scans" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "qr_scans"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

ALTER TABLE "qr_feedback" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "qr_feedback" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "qr_feedback"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

ALTER TABLE "qr_files" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "qr_files" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "qr_files"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

-- The public scan page: which code (and so which tenant) a short link names.
-- Only codes of active companies answer.
CREATE OR REPLACE FUNCTION qr_lookup_slug(p_slug TEXT)
RETURNS TABLE (id UUID, company_id UUID)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT q.id, q.company_id
  FROM qr_codes q
  JOIN companies c ON c.id = q.company_id
  WHERE q.slug = p_slug AND c.status = 'active';
$$;

-- A public file link: which tenant holds the file.
CREATE OR REPLACE FUNCTION qr_lookup_file(p_id UUID)
RETURNS TABLE (company_id UUID)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT f.company_id
  FROM qr_files f
  JOIN companies c ON c.id = f.company_id
  WHERE f.id = p_id AND c.status = 'active';
$$;

-- Whether a short link is already taken, by any company.
CREATE OR REPLACE FUNCTION qr_slug_taken(p_slug TEXT)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM qr_codes WHERE slug = p_slug);
$$;

REVOKE ALL ON FUNCTION qr_lookup_slug(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION qr_lookup_file(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION qr_slug_taken(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION qr_lookup_slug(TEXT) TO "ufuq_app";
GRANT EXECUTE ON FUNCTION qr_lookup_file(UUID) TO "ufuq_app";
GRANT EXECUTE ON FUNCTION qr_slug_taken(TEXT) TO "ufuq_app";

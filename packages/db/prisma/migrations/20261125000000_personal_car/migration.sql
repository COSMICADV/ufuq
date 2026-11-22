-- ===========================================================================
-- 1to1OS Personal — My Car, phase A: vehicles and odometer readings.
--
-- MIGRATION IMPLICATIONS — DOCUMENT 27 RULE 31
--   What data exists:   none is changed. Two tables and two enums are added;
--                       the attachment store gains one related type.
--   In-flight records:  none.
--   Reversibility:      drop the tables and types; restore the CHECK.
--
-- Readings are kept per vehicle, in kilometres, as entered and confirmed by
-- the person (a photo is only ever a suggestion until confirmed). An odometer
-- that is reset or replaced starts a new `segment`: distances and averages
-- are measured only within one segment, so a reset never reads as negative
-- driving. Averages and predictions are computed on read, never stored.
-- ===========================================================================

CREATE TYPE "odometer_reading_kind" AS ENUM ('normal', 'reset', 'replacement');
CREATE TYPE "odometer_reading_source" AS ENUM ('photo', 'manual', 'fuel', 'service');

CREATE TABLE "vehicles" (
    "id"          UUID           NOT NULL,
    "company_id"  UUID           NOT NULL,
    "user_id"     UUID           NOT NULL,
    "name"        VARCHAR(80)    NOT NULL,
    "make"        VARCHAR(60),
    "model"       VARCHAR(60),
    "year"        SMALLINT,
    "plate"       VARCHAR(20),
    "fuel_type"   VARCHAR(20),
    "archived_at" TIMESTAMPTZ(3),
    "created_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "vehicles_year_check" CHECK ("year" IS NULL OR "year" BETWEEN 1950 AND 2100)
);
CREATE UNIQUE INDEX "vehicles_company_id_name_key" ON "vehicles"("company_id", "name");
ALTER TABLE "vehicles"
  ADD CONSTRAINT "vehicles_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "vehicles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "odometer_readings" (
    "id"           UUID                      NOT NULL,
    "company_id"   UUID                      NOT NULL,
    "user_id"      UUID                      NOT NULL,
    "vehicle_id"   UUID                      NOT NULL,
    "reading_km"   INTEGER                   NOT NULL,
    "read_at"      TIMESTAMPTZ(3)            NOT NULL,
    "segment"      INTEGER                   NOT NULL DEFAULT 1,
    "kind"         "odometer_reading_kind"   NOT NULL DEFAULT 'normal',
    "source"       "odometer_reading_source" NOT NULL DEFAULT 'manual',
    "note"         VARCHAR(300),
    "corrected_at" TIMESTAMPTZ(3),
    "created_at"   TIMESTAMPTZ(3)            NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"   TIMESTAMPTZ(3)            NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "odometer_readings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "odometer_readings_km_check" CHECK ("reading_km" BETWEEN 0 AND 9999999),
    CONSTRAINT "odometer_readings_segment_check" CHECK ("segment" >= 1)
);
CREATE INDEX "odometer_readings_vehicle_id_read_at_idx" ON "odometer_readings"("vehicle_id", "read_at");
CREATE INDEX "odometer_readings_company_id_idx" ON "odometer_readings"("company_id");
ALTER TABLE "odometer_readings"
  ADD CONSTRAINT "odometer_readings_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "odometer_readings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "odometer_readings_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE, DELETE ON "vehicles" TO "ufuq_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "odometer_readings" TO "ufuq_app";

ALTER TABLE "vehicles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vehicles" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "vehicles"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

ALTER TABLE "odometer_readings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "odometer_readings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "odometer_readings"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

ALTER TABLE "attachments" DROP CONSTRAINT "attachments_related_type_known";
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_related_type_known"
  CHECK ("related_type" IN ('task', 'request', 'leave_request', 'product', 'finance_transaction', 'health_document', 'odometer_reading'));

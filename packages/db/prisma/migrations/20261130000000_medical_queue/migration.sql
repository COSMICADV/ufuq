-- ===========================================================================
-- 1to1OS Business — Medical, phase C1: reception and the day's queue.
--
-- MIGRATION IMPLICATIONS — DOCUMENT 27 RULE 31
--   What data exists:   visits keep every value; five nullable columns and
--                       two status values are added.
--   In-flight records:  existing visits have no queue number (they were never
--                       checked in) — correct.
--   Reversibility:      drop the columns and index (enum values stay).
--
-- Reception checks a patient in for a doctor: the visit becomes "waiting" and
-- takes the next number in that doctor's queue for the clinic's calendar day
-- (numbers restart at 1 every day). The doctor calls the patient in
-- ("in_progress"), then finishes ("completed"); a checked-in patient who
-- leaves is "no_show".
-- ===========================================================================

ALTER TYPE "medical_visit_status" ADD VALUE IF NOT EXISTS 'waiting' BEFORE 'in_progress';
ALTER TYPE "medical_visit_status" ADD VALUE IF NOT EXISTS 'no_show';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'medical_visit.checked_in';

ALTER TABLE "medical_visits"
  ADD COLUMN "queue_date"    DATE,
  ADD COLUMN "queue_number"  INTEGER,
  ADD COLUMN "checked_in_at" TIMESTAMPTZ(3),
  ADD COLUMN "called_at"     TIMESTAMPTZ(3),
  ADD COLUMN "finished_at"   TIMESTAMPTZ(3),
  ADD CONSTRAINT "medical_visits_queue_check" CHECK (
    ("queue_number" IS NULL AND "queue_date" IS NULL) OR
    ("queue_number" > 0 AND "queue_date" IS NOT NULL AND "doctor_id" IS NOT NULL)
  );

-- One number per doctor per day.
CREATE UNIQUE INDEX "medical_visits_queue_key" ON "medical_visits"("company_id", "doctor_id", "queue_date", "queue_number");
CREATE INDEX "medical_visits_company_id_queue_date_idx" ON "medical_visits"("company_id", "queue_date");

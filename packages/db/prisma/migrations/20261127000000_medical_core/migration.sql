-- ===========================================================================
-- 1to1OS Business — Medical, phase M0: patients, visits, the medical team and
-- each employee's medical permissions.
--
-- MIGRATION IMPLICATIONS — DOCUMENT 27 RULE 31
--   What data exists:   none is changed. Four tables, three enums and six
--                       audit actions are added.
--   In-flight records:  none.
--   Reversibility:      drop the tables and types (enum values stay).
--
-- Only a company whose business_activity is 'medical' uses these tables (the
-- API refuses every medical route otherwise). Clinical access is granted to
-- each employee individually by the company admin (medical_permissions);
-- nobody but the admin has clinical access by default — a receptionist or a
-- finance employee sees no clinical data until granted. Grants are scoped
-- 'all' (every patient) or 'assigned' (the employee's own patients: primary
-- doctor or care team, and their own visits).
-- ===========================================================================

ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'medical.permissions_changed';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'patient.created';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'patient.updated';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'patient.archived';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'medical_visit.created';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'medical_visit.updated';

CREATE TYPE "clinical_role" AS ENUM ('doctor', 'nurse', 'technician', 'reception', 'finance', 'administration');
CREATE TYPE "patient_gender" AS ENUM ('male', 'female');
CREATE TYPE "medical_visit_status" AS ENUM ('scheduled', 'in_progress', 'completed', 'cancelled');

-- The medical side of an employee: their clinical role and specialty.
CREATE TABLE "medical_staff" (
    "employee_id"   UUID            NOT NULL,
    "company_id"    UUID            NOT NULL,
    "clinical_role" "clinical_role" NOT NULL,
    "specialty"     VARCHAR(80),
    "created_at"    TIMESTAMPTZ(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"    TIMESTAMPTZ(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "medical_staff_pkey" PRIMARY KEY ("employee_id")
);
CREATE INDEX "medical_staff_company_id_idx" ON "medical_staff"("company_id");

-- One employee's medical permissions, one row per permission key.
CREATE TABLE "medical_permissions" (
    "company_id"  UUID           NOT NULL,
    "employee_id" UUID           NOT NULL,
    "key"         VARCHAR(50)    NOT NULL,
    "scope"       VARCHAR(10)    NOT NULL,
    "granted_by"  UUID           NOT NULL,
    "created_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "medical_permissions_pkey" PRIMARY KEY ("employee_id", "key"),
    CONSTRAINT "medical_permissions_scope_check" CHECK ("scope" IN ('all', 'assigned'))
);
CREATE INDEX "medical_permissions_company_id_idx" ON "medical_permissions"("company_id");

CREATE TABLE "patients" (
    "id"                  UUID             NOT NULL,
    "company_id"          UUID             NOT NULL,
    "file_number"         VARCHAR(20)      NOT NULL,
    "full_name"           VARCHAR(160)     NOT NULL,
    "date_of_birth"       DATE,
    "gender"              "patient_gender",
    "phone"               VARCHAR(40),
    "national_id"         VARCHAR(30),
    "notes"               VARCHAR(2000),
    "primary_doctor_id"   UUID,
    "archived_at"         TIMESTAMPTZ(3),
    "created_by"          UUID             NOT NULL,
    "created_at"          TIMESTAMPTZ(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMPTZ(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "patients_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "patients_company_id_file_number_key" ON "patients"("company_id", "file_number");
CREATE INDEX "patients_company_id_archived_at_idx" ON "patients"("company_id", "archived_at");
CREATE INDEX "patients_primary_doctor_id_idx" ON "patients"("primary_doctor_id");

-- The care team: employees who look after a patient besides the primary doctor.
CREATE TABLE "patient_care_team" (
    "patient_id"  UUID           NOT NULL,
    "employee_id" UUID           NOT NULL,
    "company_id"  UUID           NOT NULL,
    "created_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "patient_care_team_pkey" PRIMARY KEY ("patient_id", "employee_id")
);
CREATE INDEX "patient_care_team_employee_id_idx" ON "patient_care_team"("employee_id");

CREATE TABLE "medical_visits" (
    "id"          UUID                   NOT NULL,
    "company_id"  UUID                   NOT NULL,
    "patient_id"  UUID                   NOT NULL,
    "doctor_id"   UUID,
    "visit_at"    TIMESTAMPTZ(3)         NOT NULL,
    "reason"      VARCHAR(300),
    "notes"       VARCHAR(4000),
    "status"      "medical_visit_status" NOT NULL DEFAULT 'scheduled',
    "created_by"  UUID                   NOT NULL,
    "created_at"  TIMESTAMPTZ(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMPTZ(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "medical_visits_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "medical_visits_patient_id_visit_at_idx" ON "medical_visits"("patient_id", "visit_at");
CREATE INDEX "medical_visits_company_id_visit_at_idx" ON "medical_visits"("company_id", "visit_at");
CREATE INDEX "medical_visits_doctor_id_idx" ON "medical_visits"("doctor_id");

ALTER TABLE "medical_staff"
  ADD CONSTRAINT "medical_staff_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "medical_staff_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "medical_permissions"
  ADD CONSTRAINT "medical_permissions_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "medical_permissions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "medical_permissions_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "patients"
  ADD CONSTRAINT "patients_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "patients_primary_doctor_id_fkey" FOREIGN KEY ("primary_doctor_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "patients_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "patient_care_team"
  ADD CONSTRAINT "patient_care_team_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "patient_care_team_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "patient_care_team_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "medical_visits"
  ADD CONSTRAINT "medical_visits_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "medical_visits_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "medical_visits_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "medical_visits_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE, DELETE ON "medical_staff", "medical_permissions", "patient_care_team" TO "ufuq_app";
GRANT SELECT, INSERT, UPDATE ON "patients", "medical_visits" TO "ufuq_app";

ALTER TABLE "medical_staff" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "medical_staff" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "medical_staff"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);
ALTER TABLE "medical_permissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "medical_permissions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "medical_permissions"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);
ALTER TABLE "patients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patients" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "patients"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);
ALTER TABLE "patient_care_team" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patient_care_team" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "patient_care_team"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);
ALTER TABLE "medical_visits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "medical_visits" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "medical_visits"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

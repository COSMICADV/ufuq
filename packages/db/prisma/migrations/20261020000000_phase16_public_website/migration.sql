-- Phase 16: additive registration metadata only. Existing rows remain NULL.
-- Existing tenant RLS and grants protect these columns; no policies are weakened.
-- No existing records or in-flight invitations are rewritten.
-- Reversal drops only these new columns (and loses registration metadata).
ALTER TABLE companies ADD COLUMN employee_count_range varchar(20);
ALTER TABLE users ADD COLUMN display_name varchar(200), ADD COLUMN phone varchar(40);
ALTER TABLE companies ADD CONSTRAINT companies_employee_count_range CHECK (
  employee_count_range IS NULL OR employee_count_range IN ('1-10','11-50','51-200','201+')
);

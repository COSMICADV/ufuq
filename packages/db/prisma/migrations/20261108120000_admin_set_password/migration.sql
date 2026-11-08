-- ===========================================================================
-- An ADMIN can set an employee's sign-in password directly.
--
-- MIGRATION IMPLICATIONS — DOCUMENT 27 RULE 31
--
--   What data exists:   none is changed; one `audit_action` value is added.
--   In-flight records:  none.
--   Reversibility:      enum values cannot be removed in PostgreSQL; unused it
--                       is harmless.
--
-- Why: companies whose staff cannot receive invitation email hand out
-- credentials instead. `POST /employees` accepts an optional `password`, and
-- `POST /employees/:id/password` sets or replaces one; both are audited as
-- `password.set_by_admin`.
-- ===========================================================================

ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'password.set_by_admin';

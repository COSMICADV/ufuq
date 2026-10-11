-- ===========================================================================
-- Phase 10 corrective pass — attendance records are never hard-deleted
-- (DOCUMENT 06 §6, DOCUMENT 12; DOCUMENT 16 rule 15 as corrected).
--
-- The Phase 10 migration added `attendance_remove_future_leave_day`, a
-- SECURITY DEFINER function that let `ufuq_app` delete the future attendance
-- days of cancelled leave. That was a route around Phase 6's
-- `REVOKE DELETE ON attendance_records FROM ufuq_app`. Cancelling approved leave
-- now reconciles those rows in place, so the function is dropped. With it gone,
-- the Phase 6 REVOKE is again the only DELETE rule for attendance_records, and
-- it allows no delete at all.
--
-- MIGRATION IMPLICATIONS — DOCUMENT 27 RULE 31
--
--   What data exists:   none is touched. No table, column or row changes.
--   Backfill:           none.
--   In-flight records:  a deployment running the Phase 10 code still calls
--                       the function when an ADMIN cancels approved leave that
--                       has future days. Once this migration is applied, that
--                       call fails, and the cancellation rolls back whole
--                       (nothing partial). Deploy this file together with the
--                       corrected application code.
--   Reversibility:      reversible by recreating the function from the Phase
--                       10 migration. That should not be done, because it
--                       reopens a hard-delete path on attendance history.
-- ===========================================================================

DROP FUNCTION IF EXISTS "attendance_remove_future_leave_day"(UUID, UUID, DATE);

-- Restated, not new: Phase 6 already revoked DELETE on attendance_records.
-- Repeating it here keeps the rule visible next to the reason it matters.
REVOKE DELETE ON "attendance_records" FROM "ufuq_app";

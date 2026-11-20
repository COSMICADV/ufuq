-- 1to1OS Personal — Expenses, phase 2: receipts.
-- A receipt is an ordinary private attachment on a finance transaction; the
-- attachment store gains its fifth consumer. Nothing else changes.
ALTER TABLE "attachments" DROP CONSTRAINT "attachments_related_type_known";
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_related_type_known"
  CHECK ("related_type" IN ('task', 'request', 'leave_request', 'product', 'finance_transaction'));

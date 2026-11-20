-- ===========================================================================
-- 1to1OS Personal — Expenses, phase 3: budgets.
--
-- MIGRATION IMPLICATIONS — DOCUMENT 27 RULE 31
--   What data exists:   none is changed; one table and one enum are added.
--   In-flight records:  none.
--   Reversibility:      drop the table and the type.
--
-- A budget stores only its limit and its rules. What was spent is never
-- stored: it is summed from the transactions every time, so a budget can
-- never disagree with the records it measures.
--   monthly → repeats every month from `start_date` (the 1st of a month);
--             with `rollover`, what is left (or overspent) moves to the next.
--   custom  → one period, `start_date` … `end_date` inclusive.
--   category_id NULL → an overall budget over all expenses.
-- ===========================================================================

CREATE TYPE "finance_budget_period" AS ENUM ('monthly', 'custom');

CREATE TABLE "finance_budgets" (
    "id"               UUID                    NOT NULL,
    "company_id"       UUID                    NOT NULL,
    "user_id"          UUID                    NOT NULL,
    "name"             VARCHAR(80),
    "category_id"      UUID,
    "period"           "finance_budget_period" NOT NULL,
    "amount"           NUMERIC(15,2)           NOT NULL,
    "currency"         CHAR(3)                 NOT NULL DEFAULT 'EGP',
    "start_date"       DATE                    NOT NULL,
    "end_date"         DATE,
    "rollover"         BOOLEAN                 NOT NULL DEFAULT false,
    "alert_thresholds" SMALLINT[]              NOT NULL DEFAULT '{80,90,100}',
    "archived_at"      TIMESTAMPTZ(3),
    "created_at"       TIMESTAMPTZ(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"       TIMESTAMPTZ(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "finance_budgets_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "finance_budgets_amount_check" CHECK ("amount" > 0),
    CONSTRAINT "finance_budgets_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
    CONSTRAINT "finance_budgets_period_check" CHECK (
      ("period" = 'monthly' AND "end_date" IS NULL AND EXTRACT(DAY FROM "start_date") = 1)
      OR ("period" = 'custom' AND "end_date" IS NOT NULL AND "end_date" >= "start_date" AND NOT "rollover")
    ),
    CONSTRAINT "finance_budgets_thresholds_check" CHECK (
      "alert_thresholds" <@ ARRAY[50, 60, 70, 75, 80, 85, 90, 95, 100]::SMALLINT[]
    )
);
CREATE INDEX "finance_budgets_company_id_archived_at_idx" ON "finance_budgets"("company_id", "archived_at");
CREATE INDEX "finance_budgets_category_id_idx" ON "finance_budgets"("category_id");
ALTER TABLE "finance_budgets"
  ADD CONSTRAINT "finance_budgets_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "finance_budgets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "finance_budgets_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "finance_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE, DELETE ON "finance_budgets" TO "ufuq_app";

ALTER TABLE "finance_budgets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "finance_budgets" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "finance_budgets"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

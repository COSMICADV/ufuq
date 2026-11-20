-- ===========================================================================
-- 1to1OS Personal — Expenses, phase 1: accounts, categories, transactions.
--
-- MIGRATION IMPLICATIONS — DOCUMENT 27 RULE 31
--
--   What data exists:   none is changed; three tables and three enum types
--                       are added. Business tables are untouched.
--   In-flight records:  none.
--   Reversibility:      drop the three tables and types.
--
-- Money is NUMERIC(15,2), never floating point. Account balances are not
-- stored: a balance is the opening balance plus the account's transactions,
-- computed on read, so it can never drift from the records it summarises.
--   expense   → leaves `account_id`
--   income    → enters `account_id`
--   transfer  → leaves `account_id`, enters `to_account_id`; it is neither
--               income nor expense (savings contributions and credit-card
--               repayments are transfers, so nothing is counted twice).
-- A credit card is an account whose balance goes negative as it is used.
--
-- Every row carries company_id (the Personal account's one-person workspace)
-- and user_id, under the same row-level security as every tenant table.
-- ===========================================================================

CREATE TYPE "finance_account_type" AS ENUM ('cash', 'bank', 'debit_card', 'credit_card', 'ewallet', 'savings');
CREATE TYPE "finance_category_kind" AS ENUM ('expense', 'income');
CREATE TYPE "finance_transaction_type" AS ENUM ('expense', 'income', 'transfer');

CREATE TABLE "finance_accounts" (
    "id"              UUID                   NOT NULL,
    "company_id"      UUID                   NOT NULL,
    "user_id"         UUID                   NOT NULL,
    "name"            VARCHAR(120)           NOT NULL,
    "type"            "finance_account_type" NOT NULL,
    "currency"        CHAR(3)                NOT NULL DEFAULT 'EGP',
    "opening_balance" NUMERIC(15,2)          NOT NULL DEFAULT 0,
    "archived_at"     TIMESTAMPTZ(3),
    "created_at"      TIMESTAMPTZ(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMPTZ(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "finance_accounts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "finance_accounts_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$')
);
CREATE UNIQUE INDEX "finance_accounts_company_id_name_key" ON "finance_accounts"("company_id", "name");
ALTER TABLE "finance_accounts"
  ADD CONSTRAINT "finance_accounts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "finance_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "finance_categories" (
    "id"          UUID                    NOT NULL,
    "company_id"  UUID                    NOT NULL,
    "user_id"     UUID                    NOT NULL,
    "kind"        "finance_category_kind" NOT NULL,
    "parent_id"   UUID,
    -- A default category's key ('fuel', 'groceries' …); its label is translated.
    "key"         VARCHAR(40),
    -- A category the user named.
    "name"        VARCHAR(80),
    "position"    INTEGER                 NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(3),
    "created_at"  TIMESTAMPTZ(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMPTZ(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "finance_categories_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "finance_categories_label_check" CHECK ("key" IS NOT NULL OR "name" IS NOT NULL)
);
CREATE UNIQUE INDEX "finance_categories_company_id_key_key" ON "finance_categories"("company_id", "key");
CREATE INDEX "finance_categories_company_id_kind_idx" ON "finance_categories"("company_id", "kind");
ALTER TABLE "finance_categories"
  ADD CONSTRAINT "finance_categories_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "finance_categories_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "finance_categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "finance_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "finance_transactions" (
    "id"            UUID                       NOT NULL,
    "company_id"    UUID                       NOT NULL,
    "user_id"       UUID                       NOT NULL,
    "type"          "finance_transaction_type" NOT NULL,
    "amount"        NUMERIC(15,2)              NOT NULL,
    "currency"      CHAR(3)                    NOT NULL,
    "account_id"    UUID                       NOT NULL,
    "to_account_id" UUID,
    "category_id"   UUID,
    "occurred_at"   TIMESTAMPTZ(3)             NOT NULL,
    "merchant"      VARCHAR(160),
    "notes"         VARCHAR(1000),
    -- A Personal module this record also belongs to (a vehicle, the home …).
    "link_type"     VARCHAR(20),
    "link_id"       UUID,
    "created_at"    TIMESTAMPTZ(3)             NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"    TIMESTAMPTZ(3)             NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "finance_transactions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "finance_transactions_amount_check" CHECK ("amount" > 0),
    CONSTRAINT "finance_transactions_shape_check" CHECK (
      ("type" = 'transfer' AND "to_account_id" IS NOT NULL AND "to_account_id" <> "account_id" AND "category_id" IS NULL)
      OR ("type" <> 'transfer' AND "to_account_id" IS NULL)
    ),
    CONSTRAINT "finance_transactions_link_check" CHECK (("link_type" IS NULL) = ("link_id" IS NULL))
);
CREATE INDEX "finance_transactions_company_id_occurred_at_idx" ON "finance_transactions"("company_id", "occurred_at");
CREATE INDEX "finance_transactions_account_id_idx" ON "finance_transactions"("account_id");
CREATE INDEX "finance_transactions_to_account_id_idx" ON "finance_transactions"("to_account_id");
CREATE INDEX "finance_transactions_category_id_idx" ON "finance_transactions"("category_id");
ALTER TABLE "finance_transactions"
  ADD CONSTRAINT "finance_transactions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "finance_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "finance_transactions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "finance_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "finance_transactions_to_account_id_fkey" FOREIGN KEY ("to_account_id") REFERENCES "finance_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "finance_transactions_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "finance_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE, DELETE ON "finance_accounts" TO "ufuq_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "finance_categories" TO "ufuq_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "finance_transactions" TO "ufuq_app";

ALTER TABLE "finance_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "finance_accounts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "finance_accounts"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

ALTER TABLE "finance_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "finance_categories" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "finance_categories"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

ALTER TABLE "finance_transactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "finance_transactions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "finance_transactions"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

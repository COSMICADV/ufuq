-- ===========================================================================
-- Phase 14 — inventory (DOCUMENT 06 §3.29–3.33, DOCUMENT 17, DOCUMENT 25
-- Phase 14)
--
-- MIGRATION IMPLICATIONS — DOCUMENT 27 RULE 31
--
--   What data exists:   Phase 13's warehouses, products (subset), stock cache
--                       and movements. Nothing is replaced: this file extends
--                       them. `companies` gains one setting column.
--   Backfill:           new product columns take their documented defaults
--                       (min stock, cost and selling price 0). Every existing
--                       movement receives a ledger `sequence` in its physical
--                       insertion order, which for an append-only table is the
--                       order it was written in. `allow_negative_stock` is
--                       false for every company — the Phase 13 behaviour.
--   In-flight records:  none. The new CHECKs hold for every movement Phase 13
--                       could write (transfers, and the test-only seeded
--                       additions, which always carried a unit cost).
--   Reversibility:      the new tables and columns can be dropped while
--                       empty; movements are history and are never removed
--                       (DOCUMENT 17 rule 2). The added `audit_action` values
--                       are not reversible, as in earlier phases.
--
-- What changes in the ledger's protection:
--
--   * negative stock (DOCUMENT 17 rule 5): the Phase 13 CHECKs refused any
--     negative balance outright. A balance may now go below zero **only**
--     when the company's `allow_negative_stock` setting is true, and never on
--     a transfer (DOCUMENT 04 B21: a transfer is blocked when the source is
--     insufficient). The guard reads the setting at insert time;
--   * movement semantics are enforced here as well as in the service: the
--     sign of each type, a reason on `adjustment` and `damage` (rule 9), and a
--     unit cost on every inbound movement (so the weighted average can always
--     be replayed from the ledger alone);
--   * `sequence` orders the ledger exactly. Movements written in one request
--     share a timestamp, and a request's clock is read before it waits for
--     its row lock, so `created_at` alone cannot order a replay. The
--     sequence is assigned at insert, under the row lock, so per
--     (product, location) it follows the balance chain;
--   * a movement may only reference an active, non-deleted product.
-- ===========================================================================

-- DOCUMENT 21 "Inventory", plus `product_category.created` (approved
-- amendment, Phase 14: DOCUMENT 21 lacked an action for category creation).
ALTER TYPE "audit_action" ADD VALUE 'product.created';
ALTER TYPE "audit_action" ADD VALUE 'product.updated';
ALTER TYPE "audit_action" ADD VALUE 'product.deactivated';
ALTER TYPE "audit_action" ADD VALUE 'product_category.created';
ALTER TYPE "audit_action" ADD VALUE 'stock.movement_created';
ALTER TYPE "audit_action" ADD VALUE 'stock.reconciliation_run';
ALTER TYPE "audit_action" ADD VALUE 'supplier.created';
ALTER TYPE "audit_action" ADD VALUE 'supplier.updated';

CREATE TYPE "supplier_status" AS ENUM ('active', 'inactive');

-- ---------------------------------------------------------------------------
-- The setting — on `companies`, beside the other company settings, edited
-- through `PATCH /company` and audited as `settings.company_updated`.
-- ---------------------------------------------------------------------------
ALTER TABLE "companies" ADD COLUMN "allow_negative_stock" BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- product_categories — DOCUMENT 06 §3.30 (name_ar, name_en, parent_id)
-- ---------------------------------------------------------------------------
CREATE TABLE "product_categories" (
    "id"         UUID           NOT NULL,
    "company_id" UUID           NOT NULL,
    "name_ar"    VARCHAR(200)   NOT NULL,
    "name_en"    VARCHAR(200)   NOT NULL,
    "parent_id"  UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "product_categories_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "product_categories_names_not_blank"
      CHECK (length(btrim("name_ar")) > 0 AND length(btrim("name_en")) > 0),
    CONSTRAINT "product_categories_not_own_parent" CHECK ("parent_id" IS NULL OR "parent_id" <> "id")
);
CREATE INDEX "product_categories_company_id_idx" ON "product_categories"("company_id");
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_parent_id_fkey"
  FOREIGN KEY ("parent_id") REFERENCES "product_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- suppliers — DOCUMENT 06 §3.33
-- ---------------------------------------------------------------------------
CREATE TABLE "suppliers" (
    "id"             UUID              NOT NULL,
    "company_id"     UUID              NOT NULL,
    "name"           VARCHAR(200)      NOT NULL,
    "contact_person" VARCHAR(200),
    "phone"          VARCHAR(30),
    "email"          VARCHAR(254),
    "address"        TEXT,
    "status"         "supplier_status" NOT NULL DEFAULT 'active',
    "created_at"     TIMESTAMPTZ(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"     TIMESTAMPTZ(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at"     TIMESTAMPTZ(3),

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "suppliers_name_not_blank" CHECK (length(btrim("name")) > 0)
);
CREATE INDEX "suppliers_company_id_idx" ON "suppliers"("company_id");
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- products — the rest of DOCUMENT 06 §3.29
-- ---------------------------------------------------------------------------
ALTER TABLE "products"
  ADD COLUMN "category_id"   UUID,
  ADD COLUMN "min_stock"     DECIMAL(15,3) NOT NULL DEFAULT 0,
  ADD COLUMN "cost_price"    DECIMAL(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN "selling_price" DECIMAL(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN "supplier_id"   UUID,
  -- The product image is an attachment (related_type 'product'); this holds
  -- its id, so the file is served through the attachment store's own checks.
  ADD COLUMN "image_path"    VARCHAR(500),
  ADD COLUMN "description"   TEXT,
  ADD CONSTRAINT "products_min_stock_non_negative" CHECK ("min_stock" >= 0),
  ADD CONSTRAINT "products_cost_price_non_negative" CHECK ("cost_price" >= 0),
  ADD CONSTRAINT "products_selling_price_non_negative" CHECK ("selling_price" >= 0);
CREATE INDEX "products_category_id_idx" ON "products"("category_id");
CREATE INDEX "products_supplier_id_idx" ON "products"("supplier_id");
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_fkey"
  FOREIGN KEY ("category_id") REFERENCES "product_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "products" ADD CONSTRAINT "products_supplier_id_fkey"
  FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "products_enforce_same_company"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "stock_assert_same_company"('products', 'category_id', 'product_categories', NEW."category_id", NEW."company_id");
  PERFORM "stock_assert_same_company"('products', 'supplier_id', 'suppliers', NEW."supplier_id", NEW."company_id");
  RETURN NEW;
END
$$;
CREATE TRIGGER "products_same_company"
  BEFORE INSERT OR UPDATE OF "company_id", "category_id", "supplier_id"
  ON "products" FOR EACH ROW EXECUTE FUNCTION "products_enforce_same_company"();

CREATE OR REPLACE FUNCTION "product_categories_enforce_same_company"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "stock_assert_same_company"('product_categories', 'parent_id', 'product_categories', NEW."parent_id", NEW."company_id");
  RETURN NEW;
END
$$;
CREATE TRIGGER "product_categories_same_company"
  BEFORE INSERT OR UPDATE OF "company_id", "parent_id"
  ON "product_categories" FOR EACH ROW EXECUTE FUNCTION "product_categories_enforce_same_company"();

-- Products, categories and suppliers are soft-deleted only (rule 12).
CREATE OR REPLACE FUNCTION "inventory_no_hard_delete"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are never hard-deleted', TG_TABLE_NAME USING ERRCODE = '42501';
END
$$;
CREATE TRIGGER "products_no_delete" BEFORE DELETE ON "products"
  FOR EACH ROW EXECUTE FUNCTION "inventory_no_hard_delete"();
CREATE TRIGGER "product_categories_no_delete" BEFORE DELETE ON "product_categories"
  FOR EACH ROW EXECUTE FUNCTION "inventory_no_hard_delete"();
CREATE TRIGGER "suppliers_no_delete" BEFORE DELETE ON "suppliers"
  FOR EACH ROW EXECUTE FUNCTION "inventory_no_hard_delete"();

-- ---------------------------------------------------------------------------
-- stock_movements — ordering and the full movement semantics
-- ---------------------------------------------------------------------------
ALTER TABLE "stock_movements" ADD COLUMN "sequence" BIGINT GENERATED ALWAYS AS IDENTITY;
CREATE UNIQUE INDEX "stock_movements_sequence_key" ON "stock_movements"("sequence");
CREATE INDEX "stock_movements_product_warehouse_sequence_idx"
  ON "stock_movements"("product_id", "warehouse_id", "sequence");

-- Negative balances move from a blanket CHECK to the setting-aware guard below.
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_balance_non_negative";
ALTER TABLE "product_stock" DROP CONSTRAINT "product_stock_quantity_non_negative";

ALTER TABLE "stock_movements"
  -- Direction by type (DOCUMENT 17 "Movement types"); adjustment is either.
  ADD CONSTRAINT "stock_movements_direction" CHECK (
    ("type" NOT IN ('purchase', 'return', 'manual_addition', 'transfer_in') OR "quantity" > 0)
    AND ("type" NOT IN ('sale', 'damage', 'manual_removal', 'transfer_out') OR "quantity" < 0)
  ),
  -- Rule 9: adjustment and damage require a reason.
  ADD CONSTRAINT "stock_movements_reason_required" CHECK (
    "type" NOT IN ('adjustment', 'damage') OR ("reason" IS NOT NULL AND length(btrim("reason")) > 0)
  ),
  -- Every inbound movement carries the cost it arrived at, so the weighted
  -- average can be replayed from the ledger alone (rule 3).
  ADD CONSTRAINT "stock_movements_inbound_cost" CHECK ("quantity" < 0 OR "unit_cost" IS NOT NULL);

CREATE OR REPLACE FUNCTION "stock_movements_guard_insert"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  current_qty NUMERIC;
  negative_allowed BOOLEAN;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "warehouses" w
    WHERE w."id" = NEW."warehouse_id" AND w."is_active" AND w."deleted_at" IS NULL
  ) THEN
    RAISE EXCEPTION 'warehouse % is not active', NEW."warehouse_id" USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "products" p
    WHERE p."id" = NEW."product_id" AND p."status" = 'active' AND p."deleted_at" IS NULL
  ) THEN
    RAISE EXCEPTION 'product % is not active', NEW."product_id" USING ERRCODE = '42501';
  END IF;
  SELECT s."quantity" INTO current_qty FROM "product_stock" s
    WHERE s."product_id" = NEW."product_id" AND s."warehouse_id" = NEW."warehouse_id"
    FOR UPDATE;
  IF NEW."balance_after" <> COALESCE(current_qty, 0) + NEW."quantity" THEN
    RAISE EXCEPTION 'stock movement balance_after % does not follow the balance % + %',
      NEW."balance_after", COALESCE(current_qty, 0), NEW."quantity"
      USING ERRCODE = '23514', CONSTRAINT = 'stock_movements_balance_chain';
  END IF;
  -- Rule 5: below zero only when the company enables it, and never by a
  -- transfer. A movement that does not take stock away (an inbound one on an
  -- already-negative balance) is not what the rule blocks.
  IF NEW."balance_after" < 0 AND NEW."quantity" < 0 THEN
    SELECT c."allow_negative_stock" INTO negative_allowed FROM "companies" c WHERE c."id" = NEW."company_id";
    IF NEW."type" = 'transfer_out' OR NOT COALESCE(negative_allowed, false) THEN
      RAISE EXCEPTION 'stock movement would leave a negative balance %', NEW."balance_after"
        USING ERRCODE = '23514', CONSTRAINT = 'stock_movements_negative_not_allowed';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- ===========================================================================
-- Attachments — the store gains its fourth consumer (the product image).
-- ===========================================================================
ALTER TABLE "attachments" DROP CONSTRAINT "attachments_related_type_known";
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_related_type_known"
  CHECK ("related_type" IN ('task', 'request', 'leave_request', 'product'));

-- ===========================================================================
-- Least privilege — DOCUMENT 20 §3.
-- ===========================================================================
GRANT SELECT, INSERT, UPDATE ON "product_categories" TO "ufuq_app";
REVOKE DELETE, TRUNCATE ON "product_categories" FROM "ufuq_app";
GRANT SELECT, INSERT, UPDATE ON "suppliers" TO "ufuq_app";
REVOKE DELETE, TRUNCATE ON "suppliers" FROM "ufuq_app";

-- ===========================================================================
-- Row-level security — AD-03. `packages/db/test/phase14-rls.test.ts`.
-- ===========================================================================
ALTER TABLE "product_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_categories" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "product_categories"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

ALTER TABLE "suppliers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "suppliers" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "suppliers"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

-- ===========================================================================
-- Phase 13 — warehouse (DOCUMENT 06 §3.28–3.32, DOCUMENT 17, DOCUMENT 25
-- Phase 13)
--
-- MIGRATION IMPLICATIONS — DOCUMENT 27 RULE 31
--
--   What data exists:   every table here is new. No existing table or row is
--                       altered. `audit_action` gains the DOCUMENT 21
--                       warehouse and transfer actions.
--   Backfill:           none. No warehouse, product or stock is seeded.
--   In-flight records:  none. Nothing reads or writes these tables until the
--                       Phase 13 endpoints are deployed with this file.
--   Reversibility:      reversible while the tables are empty: drop the
--                       triggers, functions, tables and types. Once a movement
--                       exists it is history and must never be removed
--                       (DOCUMENT 17 rule 2). The added `audit_action` values
--                       are not reversible, as in Phases 4–11.
--
-- Scope (approved decision): the minimal shared stock foundation Phase 13
-- needs. `products` carries only the columns a transfer and a stock view
-- read (Phase 14 adds category, supplier, pricing, min stock, image and
-- description, and the catalogue itself). `stock_movements` carries every
-- DOCUMENT 06 column and type, because it is the one ledger both phases
-- write. Phase 13 itself writes only `transfer_out` / `transfer_in`.
--
-- One stock model (DOCUMENT 17 "Critical architectural rule"): an online
-- channel is a warehouse whose type is `online`. There is no second table.
--
-- The ledger is protected by the database, not only by the application:
--
--   * movements are immutable — no UPDATE, no DELETE, for any role;
--   * each movement's `balance_after` must chain from the cached balance
--     (cache + quantity), so a movement cannot misstate history;
--   * the cache (`product_stock.quantity`) must always equal the balance of
--     the latest movement for its (product, warehouse) — a quantity written
--     without a movement behind it is refused. "There is no path that writes
--     a quantity directly" (DOCUMENT 25 Phase 14 exit) holds here already;
--   * no balance may go below zero: negative stock is blocked by default
--     (DOCUMENT 17 rule 5), and no company setting enables it yet;
--   * a warehouse holding stock cannot be deactivated or deleted, and no
--     movement may touch an inactive warehouse.
-- ===========================================================================

CREATE TYPE "warehouse_type" AS ENUM ('main', 'branch', 'store', 'production', 'online');
CREATE TYPE "product_status" AS ENUM ('active', 'discontinued');
CREATE TYPE "stock_movement_type" AS ENUM (
  'purchase', 'sale', 'transfer_in', 'transfer_out', 'adjustment',
  'return', 'damage', 'manual_addition', 'manual_removal'
);

-- DOCUMENT 21 "Inventory" — the actions Phase 13 performs.
ALTER TYPE "audit_action" ADD VALUE 'warehouse.created';
ALTER TYPE "audit_action" ADD VALUE 'warehouse.updated';
ALTER TYPE "audit_action" ADD VALUE 'warehouse.deactivated';
ALTER TYPE "audit_action" ADD VALUE 'stock.transfer_executed';

-- ---------------------------------------------------------------------------
-- warehouses — DOCUMENT 06 §3.28
-- ---------------------------------------------------------------------------
CREATE TABLE "warehouses" (
    "id"         UUID             NOT NULL,
    "company_id" UUID             NOT NULL,
    "name_ar"    VARCHAR(200)     NOT NULL,
    "name_en"    VARCHAR(200)     NOT NULL,
    "type"       "warehouse_type" NOT NULL,
    "address"    TEXT,
    "is_active"  BOOLEAN          NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "warehouses_names_not_blank"
      CHECK (length(btrim("name_ar")) > 0 AND length(btrim("name_en")) > 0)
);
CREATE INDEX "warehouses_company_id_idx" ON "warehouses"("company_id");
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- products — DOCUMENT 06 §3.29, the Phase 13 subset (see the header)
-- ---------------------------------------------------------------------------
CREATE TABLE "products" (
    "id"         UUID             NOT NULL,
    "company_id" UUID             NOT NULL,
    "name_ar"    VARCHAR(200)     NOT NULL,
    "name_en"    VARCHAR(200)     NOT NULL,
    "sku"        VARCHAR(50)      NOT NULL,
    "unit"       VARCHAR(20)      NOT NULL,
    "status"     "product_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "products_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "products_names_not_blank"
      CHECK (length(btrim("name_ar")) > 0 AND length(btrim("name_en")) > 0),
    CONSTRAINT "products_sku_length" CHECK (length(btrim("sku")) BETWEEN 1 AND 50),
    CONSTRAINT "products_unit_not_blank" CHECK (length(btrim("unit")) > 0)
);
-- DOCUMENT 17 rule 10: SKU is unique per company.
CREATE UNIQUE INDEX "products_company_id_sku_key" ON "products"("company_id", "sku");
ALTER TABLE "products" ADD CONSTRAINT "products_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- product_stock — DOCUMENT 06 §3.31. A derived cache of the ledger.
-- ---------------------------------------------------------------------------
CREATE TABLE "product_stock" (
    "id"           UUID           NOT NULL,
    "company_id"   UUID           NOT NULL,
    "product_id"   UUID           NOT NULL,
    "warehouse_id" UUID           NOT NULL,
    "quantity"     DECIMAL(15,3)  NOT NULL DEFAULT 0,
    "average_cost" DECIMAL(15,2)  NOT NULL DEFAULT 0,
    "updated_at"   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_stock_pkey" PRIMARY KEY ("id"),
    -- DOCUMENT 17 rule 5: negative stock is blocked; no setting enables it yet.
    CONSTRAINT "product_stock_quantity_non_negative" CHECK ("quantity" >= 0),
    CONSTRAINT "product_stock_average_cost_non_negative" CHECK ("average_cost" >= 0)
);
CREATE UNIQUE INDEX "product_stock_product_id_warehouse_id_key"
  ON "product_stock"("product_id", "warehouse_id");
CREATE INDEX "product_stock_warehouse_id_idx" ON "product_stock"("warehouse_id");
CREATE INDEX "product_stock_company_id_idx" ON "product_stock"("company_id");
ALTER TABLE "product_stock" ADD CONSTRAINT "product_stock_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_stock" ADD CONSTRAINT "product_stock_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_stock" ADD CONSTRAINT "product_stock_warehouse_id_fkey"
  FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- stock_movements — DOCUMENT 06 §3.32. The source of truth. Immutable.
-- ---------------------------------------------------------------------------
CREATE TABLE "stock_movements" (
    "id"                UUID                  NOT NULL,
    "company_id"        UUID                  NOT NULL,
    "product_id"        UUID                  NOT NULL,
    "warehouse_id"      UUID                  NOT NULL,
    "type"              "stock_movement_type" NOT NULL,
    "quantity"          DECIMAL(15,3)         NOT NULL,
    "unit_cost"         DECIMAL(15,2),
    "balance_after"     DECIMAL(15,3)         NOT NULL,
    "reference_type"    VARCHAR(50),
    "reference_id"      UUID,
    "transfer_group_id" UUID,
    "reason"            TEXT,
    "created_by"        UUID                  NOT NULL,
    "created_at"        TIMESTAMPTZ(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id"),
    -- DOCUMENT 17 "Validation": movement quantity ≠ 0.
    CONSTRAINT "stock_movements_quantity_not_zero" CHECK ("quantity" <> 0),
    CONSTRAINT "stock_movements_balance_non_negative" CHECK ("balance_after" >= 0),
    CONSTRAINT "stock_movements_unit_cost_non_negative" CHECK ("unit_cost" IS NULL OR "unit_cost" >= 0),
    -- Transfers (rule 4): a pair sharing a group, out negative, in positive,
    -- the inbound leg with its unit cost ("unit cost required for transfer_in").
    CONSTRAINT "stock_movements_transfer_group"
      CHECK (("type" IN ('transfer_in', 'transfer_out')) = ("transfer_group_id" IS NOT NULL)),
    CONSTRAINT "stock_movements_transfer_sign" CHECK (
      ("type" <> 'transfer_out' OR "quantity" < 0) AND ("type" <> 'transfer_in' OR "quantity" > 0)
    ),
    CONSTRAINT "stock_movements_transfer_in_cost"
      CHECK ("type" <> 'transfer_in' OR "unit_cost" IS NOT NULL)
);
CREATE INDEX "stock_movements_company_id_product_id_created_at_idx"
  ON "stock_movements"("company_id", "product_id", "created_at");
CREATE INDEX "stock_movements_warehouse_id_created_at_idx"
  ON "stock_movements"("warehouse_id", "created_at");
CREATE INDEX "stock_movements_transfer_group_id_idx" ON "stock_movements"("transfer_group_id");
CREATE INDEX "stock_movements_product_warehouse_idx"
  ON "stock_movements"("product_id", "warehouse_id", "created_at", "id");
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_warehouse_id_fkey"
  FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- Same-company references — DOCUMENT 07 §9 invariant 7, DOCUMENT 17
-- "Referenced warehouse … must belong to the same company".
-- ===========================================================================
CREATE OR REPLACE FUNCTION "stock_assert_same_company"(
  tbl TEXT, col TEXT, ref_table TEXT, ref_id UUID, company UUID
) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  found BOOLEAN;
BEGIN
  IF ref_id IS NULL THEN
    RETURN;
  END IF;
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE "id" = $1 AND "company_id" = $2)', ref_table)
    INTO found USING ref_id, company;
  IF NOT found THEN
    RAISE EXCEPTION '%.% must reference a % row in the same company', tbl, col, ref_table
      USING ERRCODE = '23503', CONSTRAINT = tbl || '_same_company';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION "product_stock_enforce_same_company"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "stock_assert_same_company"('product_stock', 'product_id', 'products', NEW."product_id", NEW."company_id");
  PERFORM "stock_assert_same_company"('product_stock', 'warehouse_id', 'warehouses', NEW."warehouse_id", NEW."company_id");
  RETURN NEW;
END
$$;
CREATE TRIGGER "product_stock_same_company"
  BEFORE INSERT OR UPDATE OF "company_id", "product_id", "warehouse_id"
  ON "product_stock" FOR EACH ROW EXECUTE FUNCTION "product_stock_enforce_same_company"();

CREATE OR REPLACE FUNCTION "stock_movements_enforce_same_company"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "stock_assert_same_company"('stock_movements', 'product_id', 'products', NEW."product_id", NEW."company_id");
  PERFORM "stock_assert_same_company"('stock_movements', 'warehouse_id', 'warehouses', NEW."warehouse_id", NEW."company_id");
  PERFORM "stock_assert_same_company"('stock_movements', 'created_by', 'users', NEW."created_by", NEW."company_id");
  RETURN NEW;
END
$$;
CREATE TRIGGER "stock_movements_same_company"
  BEFORE INSERT ON "stock_movements" FOR EACH ROW EXECUTE FUNCTION "stock_movements_enforce_same_company"();

-- ===========================================================================
-- The ledger — DOCUMENT 17 rules 1–3, 5, 6.
-- ===========================================================================

-- Movements are immutable, for every role, the table owner included.
CREATE OR REPLACE FUNCTION "stock_movements_immutable"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'stock movements are immutable: correct a mistake with an opposing adjustment'
    USING ERRCODE = '42501';
END
$$;
CREATE TRIGGER "stock_movements_no_update_delete"
  BEFORE UPDATE OR DELETE ON "stock_movements"
  FOR EACH ROW EXECUTE FUNCTION "stock_movements_immutable"();
CREATE TRIGGER "stock_movements_no_truncate"
  BEFORE TRUNCATE ON "stock_movements"
  FOR EACH STATEMENT EXECUTE FUNCTION "stock_movements_immutable"();

-- A movement chains from the cached balance and only touches an active
-- warehouse. The movement is written first; the cache follows it.
CREATE OR REPLACE FUNCTION "stock_movements_guard_insert"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  current_qty NUMERIC;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "warehouses" w
    WHERE w."id" = NEW."warehouse_id" AND w."is_active" AND w."deleted_at" IS NULL
  ) THEN
    RAISE EXCEPTION 'warehouse % is not active', NEW."warehouse_id" USING ERRCODE = '42501';
  END IF;
  SELECT s."quantity" INTO current_qty FROM "product_stock" s
    WHERE s."product_id" = NEW."product_id" AND s."warehouse_id" = NEW."warehouse_id"
    FOR UPDATE;
  IF NEW."balance_after" <> COALESCE(current_qty, 0) + NEW."quantity" THEN
    RAISE EXCEPTION 'stock movement balance_after % does not follow the balance % + %',
      NEW."balance_after", COALESCE(current_qty, 0), NEW."quantity"
      USING ERRCODE = '23514', CONSTRAINT = 'stock_movements_balance_chain';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "stock_movements_insert"
  BEFORE INSERT ON "stock_movements"
  FOR EACH ROW EXECUTE FUNCTION "stock_movements_guard_insert"();

-- The cache always equals the ledger: its quantity is the sum of the pair's
-- movements (0 before any). No quantity without a movement. The sum, not the
-- "latest" balance_after, because movements written in one request share a
-- timestamp; the chain itself is enforced on insert above.
CREATE OR REPLACE FUNCTION "product_stock_guard_ledger"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  ledger_qty NUMERIC;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'product_stock rows are never deleted' USING ERRCODE = '42501';
  END IF;
  -- An insert for a pair that already has a row can never create a second
  -- one (unique constraint): it is skipped by ON CONFLICT DO NOTHING or
  -- refused. BEFORE triggers fire ahead of that check, so let it through.
  IF TG_OP = 'INSERT' AND EXISTS (
    SELECT 1 FROM "product_stock" s
    WHERE s."product_id" = NEW."product_id" AND s."warehouse_id" = NEW."warehouse_id"
  ) THEN
    RETURN NEW;
  END IF;
  SELECT SUM(m."quantity") INTO ledger_qty FROM "stock_movements" m
    WHERE m."product_id" = NEW."product_id" AND m."warehouse_id" = NEW."warehouse_id";
  IF NEW."quantity" <> COALESCE(ledger_qty, 0) THEN
    RAISE EXCEPTION 'product_stock quantity % does not match the ledger balance %',
      NEW."quantity", COALESCE(ledger_qty, 0)
      USING ERRCODE = '23514', CONSTRAINT = 'product_stock_matches_ledger';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "product_stock_ledger"
  BEFORE INSERT OR UPDATE OR DELETE ON "product_stock"
  FOR EACH ROW EXECUTE FUNCTION "product_stock_guard_ledger"();

-- A warehouse holding stock cannot be deactivated or deleted (DOCUMENT 17
-- "Warehouse deactivated with stock": blocked until transferred out).
CREATE OR REPLACE FUNCTION "warehouses_guard_stock"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'warehouses are never hard-deleted' USING ERRCODE = '42501';
  END IF;
  IF ((OLD."is_active" AND NOT NEW."is_active") OR (OLD."deleted_at" IS NULL AND NEW."deleted_at" IS NOT NULL))
     AND EXISTS (SELECT 1 FROM "product_stock" s WHERE s."warehouse_id" = OLD."id" AND s."quantity" <> 0) THEN
    RAISE EXCEPTION 'warehouse % still holds stock: transfer it out first', OLD."id"
      USING ERRCODE = '23514', CONSTRAINT = 'warehouses_empty_to_deactivate';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "warehouses_stock"
  BEFORE UPDATE OR DELETE ON "warehouses"
  FOR EACH ROW EXECUTE FUNCTION "warehouses_guard_stock"();

-- ===========================================================================
-- Least privilege — DOCUMENT 20 §3.
-- ===========================================================================
GRANT SELECT, INSERT, UPDATE ON "warehouses" TO "ufuq_app";
REVOKE DELETE, TRUNCATE ON "warehouses" FROM "ufuq_app";
GRANT SELECT, INSERT, UPDATE ON "products" TO "ufuq_app";
REVOKE DELETE, TRUNCATE ON "products" FROM "ufuq_app";
GRANT SELECT, INSERT, UPDATE ON "product_stock" TO "ufuq_app";
REVOKE DELETE, TRUNCATE ON "product_stock" FROM "ufuq_app";
GRANT SELECT, INSERT ON "stock_movements" TO "ufuq_app";
REVOKE UPDATE, DELETE, TRUNCATE ON "stock_movements" FROM "ufuq_app";

-- ===========================================================================
-- Row-level security — AD-03. `packages/db/test/phase13-rls.test.ts`.
-- ===========================================================================
ALTER TABLE "warehouses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "warehouses" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "warehouses"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "products" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "products"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

ALTER TABLE "product_stock" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_stock" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "product_stock"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

ALTER TABLE "stock_movements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_movements" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "stock_movements"
  USING ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.company_id', true), '')::uuid);

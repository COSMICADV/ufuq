-- ===========================================================================
-- 1to1OS Business — Restaurants & Cafés, phase R1: branches, the restaurant
-- team (role, branch and shift per employee), the visual menu, tables, and
-- orders from the POS through the kitchen to the waiter or the pickup counter.
--
-- MIGRATION IMPLICATIONS — DOCUMENT 27 RULE 31
--   What data exists:   none is changed. Ten tables, four enums and
--                       fourteen audit actions are added.
--   In-flight records:  none.
--   Reversibility:      drop the tables and types (enum values stay).
--
-- Only a company whose business_activity is 'food' uses these tables (the API
-- refuses every restaurant route otherwise). The company admin is the owner:
-- the only one who sets up branches, the menu, tables and the team. Every
-- other employee works in exactly one branch with one restaurant role, and
-- every branch-scoped row carries branch_id so each query narrows by it.
-- Order lines copy the item's name and prices at the time of the order: a
-- later menu change never rewrites a past order.
-- ===========================================================================

ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'restaurant_branch.created';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'restaurant_branch.updated';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'restaurant_staff.changed';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'restaurant_staff.removed';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'menu_category.changed';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'menu_item.created';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'menu_item.updated';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'menu_item.archived';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'menu_item.image_changed';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'restaurant_table.changed';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'restaurant_order.created';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'restaurant_order.status_changed';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'restaurant_order.cancelled';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'restaurant_order.waiter_changed';

CREATE TYPE "restaurant_role" AS ENUM ('cashier', 'waiter', 'kitchen', 'delivery');
CREATE TYPE "restaurant_order_type" AS ENUM ('dine_in', 'takeaway', 'delivery');
-- new → preparing → ready → served (dine in) | picked_up (take away) |
-- delivered (delivery); cancelled from new or preparing.
CREATE TYPE "restaurant_order_status" AS ENUM ('new', 'preparing', 'ready', 'served', 'picked_up', 'delivered', 'cancelled');
CREATE TYPE "menu_option_kind" AS ENUM ('extra', 'customization');

CREATE TABLE "restaurant_branches" (
    "id"                UUID           NOT NULL,
    "company_id"        UUID           NOT NULL,
    "name"              VARCHAR(120)   NOT NULL,
    "address"           VARCHAR(300),
    "phone"             VARCHAR(40),
    -- Percentages, e.g. 14.00. Service applies to dine-in orders only.
    "tax_rate"          DECIMAL(5,2)   NOT NULL DEFAULT 14.00,
    "service_rate"      DECIMAL(5,2)   NOT NULL DEFAULT 0.00,
    "next_order_number" INTEGER        NOT NULL DEFAULT 1,
    "archived_at"       TIMESTAMPTZ(3),
    "created_by"        UUID           NOT NULL,
    "created_at"        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "restaurant_branches_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "restaurant_branches_rates_check" CHECK ("tax_rate" >= 0 AND "tax_rate" <= 100 AND "service_rate" >= 0 AND "service_rate" <= 100)
);
CREATE UNIQUE INDEX "restaurant_branches_company_id_name_key" ON "restaurant_branches"("company_id", "name");

-- The restaurant side of an employee: role, branch and shift.
CREATE TABLE "restaurant_staff" (
    "employee_id"   UUID              NOT NULL,
    "company_id"    UUID              NOT NULL,
    "branch_id"     UUID              NOT NULL,
    "role"          "restaurant_role" NOT NULL,
    "job_title"     VARCHAR(80),
    -- ISO weekdays the employee works, 1 = Monday … 7 = Sunday.
    "working_days"  SMALLINT[]        NOT NULL DEFAULT '{}',
    "shift_start"   VARCHAR(5),
    "shift_end"     VARCHAR(5),
    "break_minutes" SMALLINT          NOT NULL DEFAULT 0,
    "active"        BOOLEAN           NOT NULL DEFAULT true,
    "created_at"    TIMESTAMPTZ(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"    TIMESTAMPTZ(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "restaurant_staff_pkey" PRIMARY KEY ("employee_id"),
    CONSTRAINT "restaurant_staff_shift_check" CHECK (
      ("shift_start" IS NULL OR "shift_start" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') AND
      ("shift_end" IS NULL OR "shift_end" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') AND
      "break_minutes" BETWEEN 0 AND 480
    )
);
CREATE INDEX "restaurant_staff_company_id_branch_id_idx" ON "restaurant_staff"("company_id", "branch_id");

CREATE TABLE "menu_categories" (
    "id"          UUID           NOT NULL,
    "company_id"  UUID           NOT NULL,
    "name"        VARCHAR(80)    NOT NULL,
    "sort_order"  INTEGER        NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(3),
    "created_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "menu_categories_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "menu_categories_company_id_name_key" ON "menu_categories"("company_id", "name");

CREATE TABLE "menu_items" (
    "id"                   UUID           NOT NULL,
    "company_id"           UUID           NOT NULL,
    "category_id"          UUID           NOT NULL,
    "name"                 VARCHAR(120)   NOT NULL,
    "description"          VARCHAR(600),
    -- The price when the item has no sizes; with sizes, each size has its own.
    "price"                DECIMAL(15,2)  NOT NULL,
    "ingredients"          VARCHAR(1000),
    "recipe"               VARCHAR(4000),
    "prep_instructions"    VARCHAR(2000),
    "available"            BOOLEAN        NOT NULL DEFAULT true,
    "sort_order"           INTEGER        NOT NULL DEFAULT 0,
    "image_key"            VARCHAR(300),
    "image_type"           VARCHAR(10),
    "image_version"        INTEGER        NOT NULL DEFAULT 0,
    "archived_at"          TIMESTAMPTZ(3),
    "created_by"           UUID           NOT NULL,
    "created_at"           TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"           TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "menu_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "menu_items_price_check" CHECK ("price" >= 0)
);
CREATE INDEX "menu_items_company_id_category_id_idx" ON "menu_items"("company_id", "category_id");

CREATE TABLE "menu_item_sizes" (
    "id"           UUID           NOT NULL,
    "company_id"   UUID           NOT NULL,
    "item_id"      UUID           NOT NULL,
    "name"         VARCHAR(60)    NOT NULL,
    "price"        DECIMAL(15,2)  NOT NULL,
    "sort_order"   INTEGER        NOT NULL DEFAULT 0,
    CONSTRAINT "menu_item_sizes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "menu_item_sizes_price_check" CHECK ("price" >= 0)
);
CREATE INDEX "menu_item_sizes_item_id_idx" ON "menu_item_sizes"("item_id");

-- Extras (add-ons with a price) and customizations ("no onions", usually free).
CREATE TABLE "menu_item_options" (
    "id"          UUID               NOT NULL,
    "company_id"  UUID               NOT NULL,
    "item_id"     UUID               NOT NULL,
    "kind"        "menu_option_kind" NOT NULL,
    "name"        VARCHAR(80)        NOT NULL,
    "price"       DECIMAL(15,2)      NOT NULL DEFAULT 0,
    "sort_order"  INTEGER            NOT NULL DEFAULT 0,
    CONSTRAINT "menu_item_options_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "menu_item_options_price_check" CHECK ("price" >= 0)
);
CREATE INDEX "menu_item_options_item_id_idx" ON "menu_item_options"("item_id");

CREATE TABLE "restaurant_tables" (
    "id"                UUID           NOT NULL,
    "company_id"        UUID           NOT NULL,
    "branch_id"         UUID           NOT NULL,
    "label"             VARCHAR(30)    NOT NULL,
    "seats"             SMALLINT       NOT NULL DEFAULT 4,
    "default_waiter_id" UUID,
    "archived_at"       TIMESTAMPTZ(3),
    "created_at"        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "restaurant_tables_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "restaurant_tables_seats_check" CHECK ("seats" BETWEEN 1 AND 100)
);
CREATE UNIQUE INDEX "restaurant_tables_branch_id_label_key" ON "restaurant_tables"("branch_id", "label");
CREATE INDEX "restaurant_tables_company_id_idx" ON "restaurant_tables"("company_id");

CREATE TABLE "restaurant_orders" (
    "id"               UUID                      NOT NULL,
    "company_id"       UUID                      NOT NULL,
    "branch_id"        UUID                      NOT NULL,
    "number"           INTEGER                   NOT NULL,
    "type"             "restaurant_order_type"   NOT NULL,
    "status"           "restaurant_order_status" NOT NULL DEFAULT 'new',
    "table_id"         UUID,
    "waiter_id"        UUID,
    "customer_name"    VARCHAR(120),
    "customer_phone"   VARCHAR(40),
    "delivery_address" VARCHAR(400),
    "notes"            VARCHAR(500),
    "subtotal"         DECIMAL(15,2)             NOT NULL,
    "discount"         DECIMAL(15,2)             NOT NULL DEFAULT 0,
    "tax"              DECIMAL(15,2)             NOT NULL DEFAULT 0,
    "service"          DECIMAL(15,2)             NOT NULL DEFAULT 0,
    "total"            DECIMAL(15,2)             NOT NULL,
    "tax_rate"         DECIMAL(5,2)              NOT NULL,
    "service_rate"     DECIMAL(5,2)              NOT NULL,
    -- One per tap of "Confirm": a resubmitted order returns the first one.
    "client_key"       VARCHAR(64)               NOT NULL,
    "created_by"       UUID                      NOT NULL,
    "preparing_at"     TIMESTAMPTZ(3),
    "ready_at"         TIMESTAMPTZ(3),
    "fulfilled_at"     TIMESTAMPTZ(3),
    "cancelled_at"     TIMESTAMPTZ(3),
    "cancel_reason"    VARCHAR(300),
    "created_at"       TIMESTAMPTZ(3)            NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"       TIMESTAMPTZ(3)            NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "restaurant_orders_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "restaurant_orders_amounts_check" CHECK ("subtotal" >= 0 AND "discount" >= 0 AND "discount" <= "subtotal" AND "tax" >= 0 AND "service" >= 0 AND "total" >= 0),
    CONSTRAINT "restaurant_orders_dine_in_table_check" CHECK ("type" <> 'dine_in' OR "table_id" IS NOT NULL),
    CONSTRAINT "restaurant_orders_delivery_check" CHECK ("type" <> 'delivery' OR ("customer_name" IS NOT NULL AND "customer_phone" IS NOT NULL AND "delivery_address" IS NOT NULL))
);
CREATE UNIQUE INDEX "restaurant_orders_branch_id_number_key" ON "restaurant_orders"("branch_id", "number");
CREATE UNIQUE INDEX "restaurant_orders_company_id_client_key_key" ON "restaurant_orders"("company_id", "client_key");
CREATE INDEX "restaurant_orders_branch_id_status_idx" ON "restaurant_orders"("branch_id", "status");
CREATE INDEX "restaurant_orders_branch_id_created_at_idx" ON "restaurant_orders"("branch_id", "created_at");
CREATE INDEX "restaurant_orders_table_id_idx" ON "restaurant_orders"("table_id");
CREATE INDEX "restaurant_orders_waiter_id_idx" ON "restaurant_orders"("waiter_id");

CREATE TABLE "restaurant_order_items" (
    "id"            UUID           NOT NULL,
    "company_id"    UUID           NOT NULL,
    "order_id"      UUID           NOT NULL,
    "menu_item_id"  UUID,
    "name"          VARCHAR(120)   NOT NULL,
    "size_name"     VARCHAR(60),
    -- Size (or item) price plus the selected extras, for one unit.
    "unit_price"    DECIMAL(15,2)  NOT NULL,
    "quantity"      SMALLINT       NOT NULL,
    "line_total"    DECIMAL(15,2)  NOT NULL,
    -- [{"kind":"extra","name":"Cheese","price":"10.00"}, …] as ordered.
    "options"       JSONB          NOT NULL DEFAULT '[]',
    "notes"         VARCHAR(300),
    "sort_order"    SMALLINT       NOT NULL DEFAULT 0,
    CONSTRAINT "restaurant_order_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "restaurant_order_items_quantity_check" CHECK ("quantity" BETWEEN 1 AND 999)
);
CREATE INDEX "restaurant_order_items_order_id_idx" ON "restaurant_order_items"("order_id");
CREATE INDEX "restaurant_order_items_menu_item_id_idx" ON "restaurant_order_items"("menu_item_id");

-- Every status change, by whom and when: the order's own history.
CREATE TABLE "restaurant_order_events" (
    "id"          UUID                      NOT NULL,
    "company_id"  UUID                      NOT NULL,
    "order_id"    UUID                      NOT NULL,
    "from_status" "restaurant_order_status",
    "to_status"   "restaurant_order_status" NOT NULL,
    "actor_id"    UUID                      NOT NULL,
    "note"        VARCHAR(300),
    "created_at"  TIMESTAMPTZ(3)            NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "restaurant_order_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "restaurant_order_events_order_id_idx" ON "restaurant_order_events"("order_id", "created_at");

ALTER TABLE "restaurant_branches"
  ADD CONSTRAINT "restaurant_branches_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "restaurant_branches_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "restaurant_staff"
  ADD CONSTRAINT "restaurant_staff_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "restaurant_staff_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "restaurant_staff_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "restaurant_branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "menu_categories"
  ADD CONSTRAINT "menu_categories_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "menu_items"
  ADD CONSTRAINT "menu_items_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "menu_items_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "menu_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "menu_items_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "menu_item_sizes"
  ADD CONSTRAINT "menu_item_sizes_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "menu_item_sizes_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "menu_item_options"
  ADD CONSTRAINT "menu_item_options_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "menu_item_options_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restaurant_tables"
  ADD CONSTRAINT "restaurant_tables_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "restaurant_tables_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "restaurant_branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "restaurant_tables_default_waiter_id_fkey" FOREIGN KEY ("default_waiter_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "restaurant_orders"
  ADD CONSTRAINT "restaurant_orders_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "restaurant_orders_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "restaurant_branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "restaurant_orders_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "restaurant_tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "restaurant_orders_waiter_id_fkey" FOREIGN KEY ("waiter_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "restaurant_orders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "restaurant_order_items"
  ADD CONSTRAINT "restaurant_order_items_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "restaurant_order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "restaurant_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "restaurant_order_items_menu_item_id_fkey" FOREIGN KEY ("menu_item_id") REFERENCES "menu_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "restaurant_order_events"
  ADD CONSTRAINT "restaurant_order_events_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "restaurant_order_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "restaurant_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "restaurant_order_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Sizes, options and team rows are replaced as a whole; nothing else is deleted.
GRANT SELECT, INSERT, UPDATE, DELETE ON "restaurant_staff", "menu_item_sizes", "menu_item_options" TO "ufuq_app";
GRANT SELECT, INSERT, UPDATE ON "restaurant_branches", "menu_categories", "menu_items", "restaurant_tables", "restaurant_orders" TO "ufuq_app";
GRANT SELECT, INSERT ON "restaurant_order_items", "restaurant_order_events" TO "ufuq_app";

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'restaurant_branches', 'restaurant_staff', 'menu_categories', 'menu_items',
    'menu_item_sizes', 'menu_item_options', 'restaurant_tables', 'restaurant_orders',
    'restaurant_order_items', 'restaurant_order_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY "tenant_isolation" ON %I USING ("company_id" = NULLIF(current_setting(''app.company_id'', true), '''')::uuid) WITH CHECK ("company_id" = NULLIF(current_setting(''app.company_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END $$;

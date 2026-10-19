/**
 * Inventory report — DOCUMENT 18 "Company reports": stock on hand, value by
 * product, category and location, low and out of stock.
 *
 * Phase 14's model, unchanged:
 *
 *   - quantities and averages are `product_stock`, the cache reconciliation
 *     proves equal to the `stock_movements` ledger;
 *   - value is Σ(quantity × weighted-average cost), exact, rounded **once** to
 *     the piastre — the warehouse dashboard's `stockValue` (OD-13 A), never
 *     the selling price; PostgreSQL's ROUND on NUMERIC is half away from zero,
 *     like `@ufuq/money`'s `nearest`;
 *   - a product's stock status is judged on its total across all locations
 *     (the approved Phase 14 basis): out at ≤ 0, low at ≤ `min_stock` —
 *     `stockStatus` from the inventory rules.
 *
 * It is the stock as it stands: no date range (DOCUMENT 18 "where
 * meaningful"). Rows are one per product, paginated by the database. With a
 * location filter, a row's quantity and value are that location's; the
 * status stays the product's company-wide status.
 */

import { Prisma } from '@ufuq/db';

import { stockStatus } from '../../inventory/inventory-rules.js';
import { and, count, decimalOf, numeric } from '../report-types.js';
import type { ReportQueryContext, ReportResult, ReportRow, RowWindow } from '../report-types.js';

/**
 * The products in scope with their totals. `total_quantity` is company-wide
 * (for the status); `quantity` and `value` honour the location filter. The
 * CTEs are MATERIALIZED: each is computed once per statement, never re-run
 * inside a join (measured: inlined, the location breakdown re-aggregated the
 * stock per product row at 5,000 products).
 */
function productsCte(qc: ReportQueryContext): Prisma.Sql {
  const locationFilter =
    qc.filters.warehouse_id === undefined
      ? Prisma.sql`TRUE`
      : Prisma.sql`ps."warehouse_id" = ${qc.filters.warehouse_id}::uuid`;
  const productFilters: Prisma.Sql[] = [Prisma.sql`p."deleted_at" IS NULL`];
  if (qc.filters.category_id !== undefined) {
    productFilters.push(Prisma.sql`p."category_id" = ${qc.filters.category_id}::uuid`);
  }
  if (qc.filters.product_id !== undefined) {
    productFilters.push(Prisma.sql`p."id" = ${qc.filters.product_id}::uuid`);
  }
  if (qc.filters.product_status !== undefined) {
    productFilters.push(Prisma.sql`p."status" = ${qc.filters.product_status}::"product_status"`);
  }
  if (qc.filters.warehouse_id !== undefined) {
    // A location filter lists what that location holds a balance for.
    productFilters.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "product_stock" ps
       WHERE ps."product_id" = p."id" AND ps."warehouse_id" = ${qc.filters.warehouse_id}::uuid)`);
  }
  // DOCUMENT 17 rules 7–8 on the total: out at ≤ 0, low at ≤ min_stock.
  const statusSql = Prisma.sql`CASE
      WHEN COALESCE(tot."total", 0) <= 0 THEN 'out_of_stock'
      WHEN COALESCE(tot."total", 0) <= p."min_stock" THEN 'low_stock'
      ELSE 'in_stock' END`;
  const statusFilter =
    qc.filters.status === undefined
      ? Prisma.sql`TRUE`
      : Prisma.sql`stock_status = ${qc.filters.status}`;
  return Prisma.sql`
    WITH tot AS MATERIALIZED (
      SELECT ps."product_id", SUM(ps."quantity") AS total
        FROM "product_stock" ps GROUP BY ps."product_id"
    ),
    loc AS MATERIALIZED (
      SELECT ps."product_id", SUM(ps."quantity") AS quantity,
             SUM(ps."quantity" * ps."average_cost") AS exact_value
        FROM "product_stock" ps WHERE ${locationFilter} GROUP BY ps."product_id"
    ),
    prod AS MATERIALIZED (
      SELECT * FROM (
        SELECT p."id", p."sku", p."name_ar", p."name_en", p."unit", p."status"::text AS product_status,
               p."min_stock", p."category_id", c."name_ar" AS category_name_ar,
               c."name_en" AS category_name_en,
               COALESCE(tot."total", 0) AS total_quantity,
               COALESCE(loc."quantity", 0) AS quantity,
               COALESCE(loc."exact_value", 0) AS exact_value,
               ${statusSql} AS stock_status
          FROM "products" p
          LEFT JOIN "product_categories" c ON c."id" = p."category_id"
          LEFT JOIN tot ON tot."product_id" = p."id"
          LEFT JOIN loc ON loc."product_id" = p."id"
         WHERE ${and(productFilters)}
      ) x WHERE ${statusFilter}
    )`;
}

export async function inventoryReport(
  qc: ReportQueryContext,
  window: RowWindow,
): Promise<ReportResult> {
  const cte = productsCte(qc);

  const [totals] = await qc.tx.$queryRaw<
    {
      products: bigint;
      value: Prisma.Decimal | null;
      low_stock: bigint;
      out_of_stock: bigint;
      in_stock: bigint;
    }[]
  >`${cte}
    SELECT COUNT(*) AS products,
           ROUND(SUM(exact_value), 2) AS value,
           COUNT(*) FILTER (WHERE stock_status = 'low_stock' AND product_status = 'active') AS low_stock,
           COUNT(*) FILTER (WHERE stock_status = 'out_of_stock' AND product_status = 'active') AS out_of_stock,
           COUNT(*) FILTER (WHERE stock_status = 'in_stock') AS in_stock
      FROM prod`;

  const byCategory = await qc.tx.$queryRaw<
    {
      category_id: string | null;
      category_name_ar: string | null;
      category_name_en: string | null;
      products: bigint;
      value: Prisma.Decimal | null;
    }[]
  >`${cte}
    SELECT category_id, category_name_ar, category_name_en, COUNT(*) AS products,
           ROUND(SUM(exact_value), 2) AS value
      FROM prod
     GROUP BY category_id, category_name_ar, category_name_en
     ORDER BY category_name_en NULLS LAST, category_id`;

  const byLocation = await qc.tx.$queryRaw<
    {
      warehouse_id: string;
      name_ar: string;
      name_en: string;
      type: string;
      is_active: boolean;
      products: bigint;
      quantity: Prisma.Decimal | null;
      value: Prisma.Decimal | null;
    }[]
  >`${cte}
    SELECT w."id" AS warehouse_id, w."name_ar", w."name_en", w."type"::text AS type, w."is_active",
           COUNT(*) FILTER (WHERE ps."quantity" <> 0) AS products,
           SUM(ps."quantity") AS quantity,
           ROUND(SUM(ps."quantity" * ps."average_cost"), 2) AS value
      FROM "product_stock" ps
      JOIN prod ON prod."id" = ps."product_id"
      JOIN "warehouses" w ON w."id" = ps."warehouse_id"
     WHERE ${
       qc.filters.warehouse_id === undefined
         ? Prisma.sql`TRUE`
         : Prisma.sql`ps."warehouse_id" = ${qc.filters.warehouse_id}::uuid`
     }
     GROUP BY w."id", w."name_ar", w."name_en", w."type", w."is_active", w."created_at"
     ORDER BY w."created_at", w."id"`;

  const paging =
    window === 'all' ? Prisma.empty : Prisma.sql`LIMIT ${window.limit} OFFSET ${window.offset}`;
  const products = await qc.tx.$queryRaw<
    {
      id: string;
      sku: string;
      name_ar: string;
      name_en: string;
      unit: string;
      product_status: string;
      min_stock: Prisma.Decimal;
      category_id: string | null;
      category_name_ar: string | null;
      category_name_en: string | null;
      total_quantity: Prisma.Decimal;
      quantity: Prisma.Decimal;
      value: Prisma.Decimal;
      stock_status: string;
    }[]
  >`${cte}
    SELECT "id", "sku", "name_ar", "name_en", "unit", product_status, "min_stock", category_id,
           category_name_ar, category_name_en, total_quantity, quantity,
           ROUND(exact_value, 2) AS value, stock_status
      FROM prod
     ORDER BY "sku", "id"
     ${paging}`;

  const rows: ReportRow[] = products.map((product) => {
    const total = decimalOf(product.total_quantity, 3);
    const min = decimalOf(product.min_stock, 3);
    return {
      product_id: product.id,
      sku: product.sku,
      name_ar: product.name_ar,
      name_en: product.name_en,
      unit: product.unit,
      product_status: product.product_status,
      category_id: product.category_id,
      category_name_ar: product.category_name_ar,
      category_name_en: product.category_name_en,
      quantity: numeric(product.quantity, 3),
      total_quantity: total.toString(),
      min_stock: min.toString(),
      value: numeric(product.value, 2),
      // The SQL CASE and the inventory rule must agree; the rule is the source.
      stock_status: stockStatus(total, min),
    };
  });

  const summary = totals as NonNullable<typeof totals>;
  return {
    summary: {
      products: count(summary.products),
      inventory_value: numeric(summary.value, 2),
      in_stock: count(summary.in_stock),
      low_stock: count(summary.low_stock),
      out_of_stock: count(summary.out_of_stock),
    },
    groups: {
      by_category: byCategory.map((row) => ({
        category_id: row.category_id,
        category_name_ar: row.category_name_ar,
        category_name_en: row.category_name_en,
        products: count(row.products),
        value: numeric(row.value, 2),
      })),
      by_location: byLocation.map((row) => ({
        warehouse_id: row.warehouse_id,
        name_ar: row.name_ar,
        name_en: row.name_en,
        type: row.type,
        is_active: row.is_active,
        products: count(row.products),
        quantity: numeric(row.quantity, 3),
        value: numeric(row.value, 2),
      })),
    },
    trend: [],
    rows,
    total: count(summary.products),
    provisional: false,
    provisionalReason: null,
    trendUnit: null,
  };
}

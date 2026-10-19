/**
 * Warehouse report — DOCUMENT 18 "Company reports": value and movement
 * volume by location, activity over time.
 *
 * One location model (DOCUMENT 17: an online channel is a warehouse of type
 * `online`), and Phase 13/14's own definitions, so every figure equals the
 * location list and the warehouse dashboard:
 *
 *   - **products held** / **units** / **value**: the location's non-zero
 *     balances in `product_stock`; value = Σ(quantity × average cost) rounded
 *     once to the piastre (`stockValue`). This is the stock *now*.
 *   - **movement volume** in the range: the location's `stock_movements` —
 *     their number, units in (positive quantities) and units out (negative),
 *     optionally of one movement type. Days are the company's calendar days.
 *   - **activity**: movements per day (per month for a long range).
 *
 * Aggregated by PostgreSQL; rows are one per location.
 */

import { Prisma } from '@ufuq/db';

import { instantAt } from '../../attendance/zoned-time.js';
import { trendUnit } from '../report-range.js';
import type { ReportRange } from '../report-range.js';
import { and, count, numeric, slice } from '../report-types.js';
import type { ReportQueryContext, ReportResult, ReportRow, RowWindow } from '../report-types.js';

function movementFilters(qc: ReportQueryContext, range: ReportRange): Prisma.Sql {
  const parts: Prisma.Sql[] = [
    Prisma.sql`m."created_at" >= ${instantAt(range.from, 0, qc.timeZone)}`,
    Prisma.sql`m."created_at" < ${instantAt(range.to, 24 * 60, qc.timeZone)}`,
  ];
  if (qc.filters.warehouse_id !== undefined) {
    parts.push(Prisma.sql`m."warehouse_id" = ${qc.filters.warehouse_id}::uuid`);
  }
  if (qc.filters.movement_type !== undefined) {
    parts.push(Prisma.sql`m."type" = ${qc.filters.movement_type}::"stock_movement_type"`);
  }
  return and(parts);
}

export async function warehouseReport(
  qc: ReportQueryContext,
  window: RowWindow,
): Promise<ReportResult> {
  const range = qc.range as ReportRange;
  const locationFilter =
    qc.filters.warehouse_id === undefined
      ? Prisma.sql`TRUE`
      : Prisma.sql`w."id" = ${qc.filters.warehouse_id}::uuid`;

  const locations = await qc.tx.$queryRaw<
    {
      warehouse_id: string;
      name_ar: string;
      name_en: string;
      type: string;
      is_active: boolean;
      product_count: bigint;
      total_quantity: Prisma.Decimal | null;
      stock_value: Prisma.Decimal | null;
      movements: bigint;
      inbound_quantity: Prisma.Decimal | null;
      outbound_quantity: Prisma.Decimal | null;
    }[]
  >`
    WITH stock AS (
      SELECT ps."warehouse_id", COUNT(*) AS product_count, SUM(ps."quantity") AS total_quantity,
             ROUND(SUM(ps."quantity" * ps."average_cost"), 2) AS stock_value
        FROM "product_stock" ps
       WHERE ps."quantity" <> 0
       GROUP BY ps."warehouse_id"
    ),
    moves AS (
      SELECT m."warehouse_id", COUNT(*) AS movements,
             SUM(m."quantity") FILTER (WHERE m."quantity" > 0) AS inbound_quantity,
             -SUM(m."quantity") FILTER (WHERE m."quantity" < 0) AS outbound_quantity
        FROM "stock_movements" m
       WHERE ${movementFilters(qc, range)}
       GROUP BY m."warehouse_id"
    )
    SELECT w."id" AS warehouse_id, w."name_ar", w."name_en", w."type"::text AS type, w."is_active",
           COALESCE(stock."product_count", 0) AS product_count,
           stock."total_quantity", stock."stock_value",
           COALESCE(moves."movements", 0) AS movements,
           moves."inbound_quantity", moves."outbound_quantity"
      FROM "warehouses" w
      LEFT JOIN stock ON stock."warehouse_id" = w."id"
      LEFT JOIN moves ON moves."warehouse_id" = w."id"
     WHERE w."deleted_at" IS NULL AND ${locationFilter}
     ORDER BY w."is_active" DESC, w."created_at", w."id"`;

  const [totals] = await qc.tx.$queryRaw<
    { stock_value: Prisma.Decimal | null; total_quantity: Prisma.Decimal | null }[]
  >`
    SELECT ROUND(SUM(ps."quantity" * ps."average_cost"), 2) AS stock_value,
           SUM(ps."quantity") AS total_quantity
      FROM "product_stock" ps
      JOIN "warehouses" w ON w."id" = ps."warehouse_id"
     WHERE ps."quantity" <> 0 AND w."deleted_at" IS NULL AND ${locationFilter}`;

  const unit = trendUnit(range);
  const bucket =
    unit === 'day'
      ? Prisma.sql`to_char((m."created_at" AT TIME ZONE ${qc.timeZone})::date, 'YYYY-MM-DD')`
      : Prisma.sql`to_char((m."created_at" AT TIME ZONE ${qc.timeZone})::date, 'YYYY-MM')`;
  const trend = await qc.tx.$queryRaw<
    {
      period: string;
      movements: bigint;
      inbound_quantity: Prisma.Decimal | null;
      outbound_quantity: Prisma.Decimal | null;
    }[]
  >`
    SELECT ${bucket} AS period, COUNT(*) AS movements,
           SUM(m."quantity") FILTER (WHERE m."quantity" > 0) AS inbound_quantity,
           -SUM(m."quantity") FILTER (WHERE m."quantity" < 0) AS outbound_quantity
      FROM "stock_movements" m
     WHERE ${movementFilters(qc, range)}
     GROUP BY 1 ORDER BY 1`;

  const rows: ReportRow[] = locations.map((row) => ({
    warehouse_id: row.warehouse_id,
    name_ar: row.name_ar,
    name_en: row.name_en,
    type: row.type,
    is_active: row.is_active,
    product_count: count(row.product_count),
    total_quantity: numeric(row.total_quantity, 3),
    stock_value: numeric(row.stock_value, 2),
    movements: count(row.movements),
    inbound_quantity: numeric(row.inbound_quantity, 3),
    outbound_quantity: numeric(row.outbound_quantity, 3),
  }));

  const summaryTotals = totals as NonNullable<typeof totals>;
  return {
    summary: {
      locations: rows.length,
      active_locations: rows.filter((row) => row.is_active === true).length,
      total_quantity: numeric(summaryTotals.total_quantity, 3),
      inventory_value: numeric(summaryTotals.stock_value, 2),
      movements: rows.reduce((sum, row) => sum + (row.movements as number), 0),
    },
    groups: {},
    trend: trend.map((row) => ({
      period: row.period,
      values: {
        movements: count(row.movements),
        inbound_quantity: numeric(row.inbound_quantity, 3),
        outbound_quantity: numeric(row.outbound_quantity, 3),
      },
    })),
    rows: slice(rows, window),
    total: rows.length,
    provisional: false,
    provisionalReason: null,
    trendUnit: unit,
  };
}

/**
 * Stock movement report — DOCUMENT 18 "Company reports": the full movement
 * ledger with filters (product, location, movement type, date range, user).
 *
 * The immutable `stock_movements` rows, read as written: quantities, unit
 * costs and balances are their exact DECIMAL strings (`movementPayload`, the
 * ledger's own wire form). Nothing is derived or edited. The filters are the
 * ledger endpoint's own (`movementLedgerWhere`), so the report and
 * `GET /stock-movements` always agree.
 *
 * A ledger grows without bound (DOCUMENT 26's worst case: 200,000 movements),
 * so rows are always paginated by the database, newest first by the ledger
 * `sequence`, and an export walks it in keyset batches
 * (`movementBatches`) — never one unbounded read.
 */

import type { Prisma, TenantClient } from '@ufuq/db';

import {
  MOVEMENT_INCLUDE,
  movementLedgerWhere,
  movementPayload,
} from '../../warehouse/warehouse.service.js';
import type { MovementPayload } from '../../warehouse/warehouse.service.js';
import type { ReportRange } from '../report-range.js';
import { count, numeric } from '../report-types.js';
import type { ReportQueryContext, ReportResult, ReportRow, RowWindow } from '../report-types.js';

function where(qc: ReportQueryContext): Prisma.StockMovementWhereInput {
  const range = qc.range as ReportRange;
  return movementLedgerWhere(
    {
      product_id: qc.filters.product_id,
      warehouse_id: qc.filters.warehouse_id,
      type: qc.filters.movement_type,
      created_by: qc.filters.user_id,
      from: range.fromKey,
      to: range.toKey,
    },
    qc.timeZone,
  );
}

/** A ledger row as a report row: the movement's own wire form, flattened. */
export function movementRow(movement: MovementPayload): ReportRow {
  return {
    movement_id: movement.id,
    created_at: movement.created_at,
    type: movement.type,
    product_id: movement.product.id,
    sku: movement.product.sku,
    product_name_ar: movement.product.name_ar,
    product_name_en: movement.product.name_en,
    unit: movement.product.unit,
    warehouse_id: movement.warehouse.id,
    warehouse_name_ar: movement.warehouse.name_ar,
    warehouse_name_en: movement.warehouse.name_en,
    quantity: movement.quantity,
    unit_cost: movement.unit_cost,
    balance_after: movement.balance_after,
    reason: movement.reason,
    transfer_group_id: movement.transfer_group_id,
    created_by: movement.created_by.email,
    created_by_id: movement.created_by.id,
  };
}

export async function movementsReport(
  qc: ReportQueryContext,
  window: RowWindow,
): Promise<ReportResult> {
  if (window === 'all') {
    throw new Error('The movement ledger is exported in batches (movementBatches), never whole');
  }
  const filter = where(qc);
  const [rows, byType, byUser] = await Promise.all([
    qc.tx.stockMovement.findMany({
      where: filter,
      include: MOVEMENT_INCLUDE,
      orderBy: [{ sequence: 'desc' }],
      skip: window.offset,
      take: window.limit,
    }),
    qc.tx.stockMovement.groupBy({
      by: ['type'],
      where: filter,
      _count: { _all: true },
      _sum: { quantity: true },
      orderBy: { type: 'asc' },
    }),
    // Who recorded the movements — also the options of the "recorded by" filter.
    qc.tx.stockMovement.groupBy({ by: ['createdBy'], where: filter, _count: { _all: true } }),
  ]);
  const users = await qc.tx.user.findMany({
    where: { id: { in: byUser.map((group) => group.createdBy) } },
    select: { id: true, email: true },
  });
  const emailOf = new Map(users.map((user) => [user.id, user.email]));
  const total = byType.reduce((sum, group) => sum + count(group._count._all), 0);
  return {
    summary: {
      movements: total,
      // Units across products are not added up: a metre and a piece are not one number.
      types: byType.length,
    },
    groups: {
      by_type: byType.map((group) => ({
        type: group.type,
        movements: count(group._count._all),
        quantity: numeric(group._sum.quantity, 3),
      })),
      by_user: byUser
        .map((group) => ({
          user_id: group.createdBy,
          email: emailOf.get(group.createdBy) ?? null,
          movements: count(group._count._all),
        }))
        .sort((a, b) => b.movements - a.movements),
    },
    trend: [],
    rows: rows.map((row) => movementRow(movementPayload(row))),
    total,
    provisional: false,
    provisionalReason: null,
    trendUnit: null,
  };
}

/** Runs one read in a tenant transaction — the caller's, or a fresh one per batch. */
export type TenantRun = <T>(fn: (tx: TenantClient) => Promise<T>) => Promise<T>;

/**
 * The whole filtered ledger, newest first, `size` rows at a time by keyset on
 * the ledger sequence — constant memory per batch, no OFFSET scan. Each batch
 * runs through `run`, so a background export holds no long transaction: the
 * ledger is append-only and ordered by `sequence`, so walking down from the
 * first batch's top is a consistent view however long the export takes.
 */
export async function* movementBatches(
  qc: ReportQueryContext,
  size: number,
  run: TenantRun,
): AsyncGenerator<readonly ReportRow[]> {
  const filter = where(qc);
  let before: bigint | null = null;
  for (;;) {
    const cursor: Prisma.StockMovementWhereInput =
      before === null ? filter : { AND: [filter, { sequence: { lt: before } }] };
    const rows = await run((tx) =>
      tx.stockMovement.findMany({
        where: cursor,
        include: MOVEMENT_INCLUDE,
        orderBy: [{ sequence: 'desc' }],
        take: size,
      }),
    );
    if (rows.length === 0) return;
    yield rows.map((row) => movementRow(movementPayload(row)));
    if (rows.length < size) return;
    before = (rows[rows.length - 1] as (typeof rows)[number]).sequence;
  }
}

/**
 * Stock reconciliation — DOCUMENT 17 rule 3 ("`product_stock` … must be
 * fully rebuildable from `stock_movements`, and a reconciliation job proves
 * this") and "Cache and ledger disagree" ("flags it, rebuilds from movements,
 * and raises an alert. Never silently corrects without a record").
 *
 *   - **The ledger is the truth.** For every (product, location) the
 *     quantity is rebuilt as the sum of its movements and the average cost by
 *     replaying rule 11 over the inbound movements at their recorded costs,
 *     in ledger order (`replay`). Each stored `balance_after` is checked
 *     against the running balance too; a break there is reported (movements
 *     are immutable, so it cannot be "fixed" — only investigated).
 *   - **Compare, then (optionally) rebuild.** `rebuild: false` reports; `true`
 *     writes the rebuilt quantity and average into every mismatched cache row
 *     (through the database's own cache-equals-ledger check). A cache row
 *     missing for a pair with movements is recreated.
 *   - **Never silent.** Every run is audited `stock.reconciliation_run` with
 *     its mode, counts and each mismatch (before and after values), and a run
 *     that finds a mismatch publishes `stock_reconciliation_mismatch`.
 *   - **Safe under concurrent activity.** Each product is reconciled in its
 *     own short transaction: its row is locked `FOR UPDATE` (as every movement
 *     locks it), then each balance row `FOR UPDATE` before that pair's
 *     movements are read — a movement can only be written while holding that
 *     balance lock, so none can land between the read and the comparison.
 *     The rest of the company keeps working while one product is checked.
 *   - **Tenant-safe**: every transaction is the company's own (RLS).
 *   - **Idempotent**: a second rebuild of a reconciled ledger finds nothing.
 */

import { Inject, Injectable } from '@nestjs/common';
import { generateId, withTenant } from '@ufuq/db';
import type { PrismaClient } from '@ufuq/db';

import { AuditDispatcher } from '../auth/audit-dispatcher.js';
import type { AuthContext } from '../auth/auth-context.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import type { RequestOrigin } from '../common/request-context.js';
import { StockLedgerService } from '../warehouse/stock-ledger.service.js';
import { money, quantity } from '../warehouse/warehouse-rules.js';

import { requireCompany } from './inventory-access.js';
import { InventoryEventPublisher } from './inventory-events.js';
import { replay } from './inventory-rules.js';

/** Mismatches listed in full in one audit record; the counts are always complete. */
export const AUDITED_MISMATCHES_MAX = 100;

export interface ReconciliationMismatch {
  readonly product_id: string;
  readonly sku: string;
  readonly warehouse_id: string;
  /** Null when the cache row was missing altogether. */
  readonly cached_quantity: string | null;
  readonly ledger_quantity: string;
  readonly cached_average_cost: string | null;
  readonly ledger_average_cost: string;
  readonly repaired: boolean;
}

export interface ReconciliationReport {
  readonly run_id: string;
  readonly mode: 'check' | 'rebuild';
  readonly products_checked: number;
  readonly balances_checked: number;
  readonly mismatches: readonly ReconciliationMismatch[];
  readonly repaired: number;
  /** Movements whose stored balance_after does not follow the ledger (reported, never rewritten). */
  readonly chain_breaks: readonly string[];
  readonly started_at: string;
  readonly finished_at: string;
}

@Injectable()
export class ReconciliationService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(AuditDispatcher) private readonly audit: AuditDispatcher,
    @Inject(StockLedgerService) private readonly ledger: StockLedgerService,
    @Inject(InventoryEventPublisher) private readonly events: InventoryEventPublisher,
  ) {}

  /** POST /inventory/reconciliation — ADMIN, `stock.movement_create` (approved decision). */
  async runForAdmin(
    ctx: AuthContext,
    rebuild: boolean,
    origin: RequestOrigin,
  ): Promise<ReconciliationReport> {
    requireCompany(ctx, 'stock.movement_create');
    return this.run(ctx.companyId, ctx.userId, rebuild, origin);
  }

  async run(
    companyId: string,
    actorUserId: string,
    rebuild: boolean,
    origin: RequestOrigin | null,
    now: () => Date = () => new Date(),
  ): Promise<ReconciliationReport> {
    const runId = generateId();
    const startedAt = now();
    const productIds = await withTenant(this.prisma, companyId, async (tx) =>
      (await tx.product.findMany({ select: { id: true }, orderBy: { id: 'asc' } })).map(
        (p) => p.id,
      ),
    );
    const mismatches: ReconciliationMismatch[] = [];
    const chainBreaks: string[] = [];
    let balancesChecked = 0;

    for (const productId of productIds) {
      await withTenant(this.prisma, companyId, async (tx) => {
        await this.ledger.lockProducts(tx, [productId]);
        const product = await tx.product.findFirstOrThrow({
          where: { id: productId },
          select: { sku: true },
        });
        const fromCache = await tx.productStock.findMany({
          where: { productId },
          select: { warehouseId: true },
        });
        const fromLedger = await tx.stockMovement.findMany({
          where: { productId },
          distinct: ['warehouseId'],
          select: { warehouseId: true },
        });
        const warehouseIds = [
          ...new Set([...fromCache, ...fromLedger].map((row) => row.warehouseId)),
        ].sort();
        for (const warehouseId of warehouseIds) {
          balancesChecked += 1;
          const rows = await tx.$queryRaw<
            { quantity: { toString(): string }; average_cost: { toString(): string } }[]
          >`
            SELECT quantity, average_cost FROM product_stock
            WHERE product_id = ${productId}::uuid AND warehouse_id = ${warehouseId}::uuid
            FOR UPDATE`;
          const cached = rows[0];
          const movements = await tx.stockMovement.findMany({
            where: { productId, warehouseId },
            orderBy: { sequence: 'asc' },
            select: { id: true, quantity: true, unitCost: true, balanceAfter: true },
          });
          const rebuilt = replay(
            movements.map((m) => ({
              id: m.id,
              quantity: quantity(m.quantity),
              unitCost: m.unitCost === null ? null : money(m.unitCost),
              balanceAfter: quantity(m.balanceAfter),
            })),
          );
          chainBreaks.push(...rebuilt.chainBreaks);
          const cachedQty = cached === undefined ? null : quantity(cached.quantity);
          const cachedAvg = cached === undefined ? null : money(cached.average_cost);
          const matches =
            cachedQty !== null &&
            cachedAvg !== null &&
            cachedQty.equals(rebuilt.quantity) &&
            cachedAvg.equals(rebuilt.averageCost);
          if (matches) continue;
          if (rebuild) {
            if (cached === undefined) {
              await tx.productStock.create({
                data: {
                  id: generateId(),
                  companyId,
                  productId,
                  warehouseId,
                  quantity: rebuilt.quantity.toString(),
                  averageCost: rebuilt.averageCost.toString(),
                },
              });
            } else {
              await tx.productStock.update({
                where: { productId_warehouseId: { productId, warehouseId } },
                data: {
                  quantity: rebuilt.quantity.toString(),
                  averageCost: rebuilt.averageCost.toString(),
                },
              });
            }
          }
          mismatches.push({
            product_id: productId,
            sku: product.sku,
            warehouse_id: warehouseId,
            cached_quantity: cachedQty?.toString() ?? null,
            ledger_quantity: rebuilt.quantity.toString(),
            cached_average_cost: cachedAvg?.toString() ?? null,
            ledger_average_cost: rebuilt.averageCost.toString(),
            repaired: rebuild,
          });
        }
      });
    }

    const finishedAt = now();
    const report: ReconciliationReport = {
      run_id: runId,
      mode: rebuild ? 'rebuild' : 'check',
      products_checked: productIds.length,
      balances_checked: balancesChecked,
      mismatches,
      repaired: rebuild ? mismatches.length : 0,
      chain_breaks: chainBreaks,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
    };
    await this.audit.dispatch([
      {
        companyId,
        userId: actorUserId,
        action: 'STOCK_RECONCILIATION_RUN',
        entityType: 'stock_reconciliation',
        entityId: runId,
        newValues: {
          mode: report.mode,
          products_checked: report.products_checked,
          balances_checked: report.balances_checked,
          mismatch_count: mismatches.length,
          repaired: report.repaired,
          chain_break_count: chainBreaks.length,
          mismatches: mismatches.slice(0, AUDITED_MISMATCHES_MAX).map((m) => ({ ...m })),
          ...(chainBreaks.length === 0
            ? {}
            : { chain_breaks: chainBreaks.slice(0, AUDITED_MISMATCHES_MAX) }),
        },
        ipAddress: origin?.ipAddress ?? null,
        userAgent: origin?.userAgent ?? null,
      },
    ]);
    if (mismatches.length > 0 || chainBreaks.length > 0) {
      await this.events.publish([
        {
          type: 'stock_reconciliation_mismatch',
          companyId,
          productId: null,
          warehouseId: null,
          movementId: null,
          occurredAt: finishedAt,
        },
      ]);
    }
    return report;
  }
}

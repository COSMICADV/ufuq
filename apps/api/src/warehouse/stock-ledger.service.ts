/**
 * The stock ledger — the one writer of `stock_movements` and `product_stock`
 * (DOCUMENT 06 §3.31: "only the stock-movement service writes this table,
 * inside the same transaction as the movement").
 *
 * The shared foundation Phase 13 needs and Phase 14 extends: Phase 13's
 * transfers are its only caller in the product; Phase 14 adds the other
 * movement types on top of the same method. It takes the caller's
 * transaction and never opens one, so a movement and its cache update commit
 * or roll back together.
 *
 *   - **Locking** (DOCUMENT 17 "Concurrent movements"): every `product_stock`
 *     row a write touches is created if missing and locked `FOR UPDATE`, in
 *     one fixed order (product, then warehouse), before anything is read. Two
 *     writers on the same row serialize; two writers on overlapping rows
 *     cannot deadlock.
 *   - **Order of writes:** the movement first, with `balance_after` = the
 *     locked balance + its quantity; then the cache. The database checks both
 *     (the movement must chain, the cache must equal the latest movement), so
 *     a bug here fails loudly rather than drifting.
 *   - **No quantity is ever set** other than as the result of a movement.
 *     There is no method that writes a quantity on its own.
 */

import { Injectable } from '@nestjs/common';
import { generateId } from '@ufuq/db';
import type { TenantClient } from '@ufuq/db';
import type { Decimal } from '@ufuq/money';

import { AppException } from '../common/app-exception.js';
import { ERROR_CODES } from '../common/errors.js';

import { isSufficient, money, quantity, weightedAverage } from './warehouse-rules.js';

export type LedgerMovementType =
  | 'purchase'
  | 'sale'
  | 'transfer_in'
  | 'transfer_out'
  | 'adjustment'
  | 'return'
  | 'damage'
  | 'manual_addition'
  | 'manual_removal';

export interface LedgerEntry {
  readonly productId: string;
  readonly warehouseId: string;
  readonly type: LedgerMovementType;
  /** Signed: negative leaves the location, positive arrives. */
  readonly quantity: Decimal;
  /** Required inbound (it moves the average); recorded on outbound when known. */
  readonly unitCost: Decimal | null;
  readonly transferGroupId?: string;
  readonly reason?: string | null;
  readonly referenceType?: string | null;
  readonly referenceId?: string | null;
}

export interface LockedBalance {
  readonly productId: string;
  readonly warehouseId: string;
  readonly quantity: Decimal;
  readonly averageCost: Decimal;
}

export interface WrittenMovement {
  readonly id: string;
  readonly productId: string;
  readonly warehouseId: string;
  readonly type: LedgerMovementType;
  readonly quantity: string;
  readonly unitCost: string | null;
  readonly balanceAfter: string;
}

function key(productId: string, warehouseId: string): string {
  return `${productId}|${warehouseId}`;
}

@Injectable()
export class StockLedgerService {
  /**
   * Create (if missing) and lock the cache rows for these pairs, in a fixed
   * order, and return their balances.
   */
  async lock(
    tx: TenantClient,
    companyId: string,
    pairs: readonly { readonly productId: string; readonly warehouseId: string }[],
  ): Promise<Map<string, LockedBalance>> {
    const unique = [
      ...new Map(pairs.map((p) => [key(p.productId, p.warehouseId), p])).values(),
    ].sort((a, b) =>
      a.productId === b.productId
        ? a.warehouseId.localeCompare(b.warehouseId)
        : a.productId.localeCompare(b.productId),
    );
    const balances = new Map<string, LockedBalance>();
    for (const pair of unique) {
      // A row that does not exist yet has had no movement, so its balance is
      // 0 — which is what the database's ledger check expects.
      await tx.$executeRaw`
        INSERT INTO product_stock (id, company_id, product_id, warehouse_id)
        VALUES (${generateId()}::uuid, ${companyId}::uuid, ${pair.productId}::uuid, ${pair.warehouseId}::uuid)
        ON CONFLICT (product_id, warehouse_id) DO NOTHING`;
      const rows = await tx.$queryRaw<
        { quantity: { toString(): string }; average_cost: { toString(): string } }[]
      >`
        SELECT quantity, average_cost FROM product_stock
        WHERE product_id = ${pair.productId}::uuid AND warehouse_id = ${pair.warehouseId}::uuid
        FOR UPDATE`;
      const row = rows[0];
      if (row === undefined) {
        throw new Error('product_stock row vanished under its own lock');
      }
      balances.set(key(pair.productId, pair.warehouseId), {
        productId: pair.productId,
        warehouseId: pair.warehouseId,
        quantity: quantity(row.quantity),
        averageCost: money(row.average_cost),
      });
    }
    return balances;
  }

  /**
   * Write movements against balances the caller locked with `lock`, in the
   * order given. Outbound beyond the balance is refused (422
   * `STOCK_INSUFFICIENT`, naming what is available) — no setting enables
   * negative stock yet (DOCUMENT 17 rule 5).
   */
  async post(
    tx: TenantClient,
    companyId: string,
    userId: string,
    locked: Map<string, LockedBalance>,
    entries: readonly LedgerEntry[],
    now: Date,
  ): Promise<WrittenMovement[]> {
    const written: WrittenMovement[] = [];
    for (const entry of entries) {
      const pair = key(entry.productId, entry.warehouseId);
      const balance = locked.get(pair);
      if (balance === undefined) {
        throw new Error(`Ledger write on an unlocked balance: ${pair}`);
      }
      const outbound = entry.quantity.isNegative();
      if (outbound && !isSufficient(balance.quantity, entry.quantity.abs())) {
        throw new AppException(ERROR_CODES.STOCK_INSUFFICIENT, 422, {
          fields: {
            product_id: [entry.productId],
            warehouse_id: [entry.warehouseId],
            available: [balance.quantity.toString()],
            requested: [entry.quantity.abs().toString()],
          },
        });
      }
      if (!outbound && entry.unitCost === null) {
        throw new Error('An inbound movement needs a unit cost.');
      }
      const after = balance.quantity.add(entry.quantity);
      const average = outbound
        ? balance.averageCost
        : weightedAverage({
            oldQuantity: balance.quantity,
            oldAverage: balance.averageCost,
            inQuantity: entry.quantity,
            inCost: entry.unitCost as Decimal,
          });
      const id = generateId();
      await tx.stockMovement.create({
        data: {
          id,
          companyId,
          productId: entry.productId,
          warehouseId: entry.warehouseId,
          type: entry.type,
          quantity: entry.quantity.toString(),
          unitCost: entry.unitCost === null ? null : entry.unitCost.toString(),
          balanceAfter: after.toString(),
          transferGroupId: entry.transferGroupId ?? null,
          reason: entry.reason ?? null,
          referenceType: entry.referenceType ?? null,
          referenceId: entry.referenceId ?? null,
          createdBy: userId,
          createdAt: now,
        },
      });
      await tx.productStock.update({
        where: {
          productId_warehouseId: { productId: entry.productId, warehouseId: entry.warehouseId },
        },
        data: { quantity: after.toString(), averageCost: average.toString() },
      });
      locked.set(pair, { ...balance, quantity: after, averageCost: average });
      written.push({
        id,
        productId: entry.productId,
        warehouseId: entry.warehouseId,
        type: entry.type,
        quantity: entry.quantity.toString(),
        unitCost: entry.unitCost === null ? null : entry.unitCost.toString(),
        balanceAfter: after.toString(),
      });
    }
    return written;
  }
}

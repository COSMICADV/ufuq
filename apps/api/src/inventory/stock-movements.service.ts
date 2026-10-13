/**
 * Stock movements — `POST /stock-movements` (DOCUMENT 05 FLOW 18, DOCUMENT
 * 17 rules 1–9, 11, 14) and the movement product creation writes for its
 * initial stock (FLOW 17).
 *
 * One transaction per movement, in this order (each step proved in
 * `test/inventory.e2e.test.ts`):
 *
 *   1. the location is locked `FOR SHARE` (it cannot be deactivated
 *      mid-movement) and must be active;
 *   2. the product is locked `FOR UPDATE` and must be active — its total
 *      across locations is read under that lock, so a low-stock crossing is
 *      decided exactly once even under concurrency;
 *   3. the balance is created if missing and locked `FOR UPDATE`;
 *   4. the movement is validated against it: outbound beyond the balance is
 *      422 `STOCK_INSUFFICIENT` when the company's `allow_negative_stock` is
 *      off, and 409 `STOCK_NEGATIVE_WARNING` when it is on but the Admin has
 *      not sent `acknowledge_negative_stock: true`;
 *   5. the immutable movement is appended with its exact `balance_after`;
 *   6. the cache's quantity and (inbound) weighted average are updated;
 *   7. commit; then `stock.movement_created` is audited and the crossing
 *      events (`low_stock`, `out_of_stock`, `negative_stock`) are published.
 *
 * Any failure before commit leaves nothing — no movement, no cache change, no
 * audit, no event. `Idempotency-Key` is required: the same key and request
 * return the same movement; a different request with the key is 422.
 */

import { Inject, Injectable } from '@nestjs/common';
import { generateId } from '@ufuq/db';
import type { PrismaClient, TenantClient } from '@ufuq/db';

import { AuditDispatcher } from '../auth/audit-dispatcher.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AppException } from '../common/app-exception.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import { ERROR_CODES } from '../common/errors.js';
import { IdempotencyService, isUniqueViolation } from '../common/idempotency.js';
import type { IdempotencyRequest } from '../common/idempotency.js';
import type { RequestOrigin } from '../common/request-context.js';
import { notFound, TenantScopedService } from '../company-structure/tenant-scoped.service.js';
import { StockLedgerService } from '../warehouse/stock-ledger.service.js';
import { MOVEMENT_INCLUDE, movementPayload } from '../warehouse/warehouse.service.js';
import type { MovementPayload } from '../warehouse/warehouse.service.js';
import { quantity } from '../warehouse/warehouse-rules.js';

import type { CreateMovementDto } from './dto/inventory.dto.js';
import { InventoryEventPublisher } from './inventory-events.js';
import type { InventoryEvent } from './inventory-events.js';
import { crossings, resolveInboundCost, validateMovement } from './inventory-rules.js';
import type { ValidMovement } from './inventory-rules.js';
import { requireCompany } from './inventory-access.js';

export interface CreatedMovementPayload extends MovementPayload {
  /** The movement left the location below zero (allowed by the company's setting, acknowledged). */
  readonly negative_stock: boolean;
}

export interface ApplyInput {
  readonly productId: string;
  readonly warehouseId: string;
  readonly movement: ValidMovement;
  readonly acknowledgeNegative: boolean;
  /** The movement's id, when the caller has already promised it. */
  readonly movementId?: string;
  /** Field names to report problems under (they differ for a product's initial stock). */
  readonly fields: { readonly product: string; readonly warehouse: string };
}

export interface Applied {
  readonly movementId: string;
  readonly events: InventoryEvent[];
}

export function createdPayload(payload: MovementPayload): CreatedMovementPayload {
  return { ...payload, negative_stock: payload.balance_after.startsWith('-') };
}

@Injectable()
export class StockMovementService extends TenantScopedService {
  constructor(
    @Inject(PRISMA_CLIENT) prisma: PrismaClient,
    @Inject(AuditDispatcher) private readonly audit: AuditDispatcher,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(StockLedgerService) private readonly ledger: StockLedgerService,
    @Inject(InventoryEventPublisher) private readonly events: InventoryEventPublisher,
  ) {
    super(prisma, audit);
  }

  /**
   * Steps 1–6 and the audit record, inside the caller's transaction (opened
   * by `AuditDispatcher.withTenant`). Returns the events to publish after
   * commit.
   */
  async apply(
    tx: TenantClient,
    ctx: AuthContext,
    input: ApplyInput,
    origin: RequestOrigin,
    now: Date,
  ): Promise<Applied> {
    const { movement } = input;
    const warehouses = await tx.$queryRaw<{ id: string; is_active: boolean }[]>`
      SELECT id, is_active FROM warehouses
      WHERE id = ${input.warehouseId}::uuid AND deleted_at IS NULL
      FOR SHARE`;
    const warehouse = warehouses[0];
    if (warehouse === undefined) {
      throw new AppException(ERROR_CODES.VALIDATION_FAILED, 422, {
        fields: { [input.fields.warehouse]: ['not_found'] },
      });
    }
    if (!warehouse.is_active) {
      throw new AppException(ERROR_CODES.WAREHOUSE_INACTIVE, 409, {
        fields: { warehouse_id: [warehouse.id] },
      });
    }
    const product = (await this.ledger.lockProducts(tx, [input.productId])).get(input.productId);
    if (product === undefined) {
      throw new AppException(ERROR_CODES.VALIDATION_FAILED, 422, {
        fields: { [input.fields.product]: ['not_found'] },
      });
    }
    if (!product.active) {
      throw new AppException(ERROR_CODES.VALIDATION_FAILED, 422, {
        fields: { [input.fields.product]: ['not_active'] },
      });
    }
    const company = await tx.company.findFirstOrThrow({ select: { allowNegativeStock: true } });
    const totals = await tx.productStock.aggregate({
      where: { productId: input.productId },
      _sum: { quantity: true },
    });
    const totalBefore = quantity(totals._sum.quantity ?? 0);

    const locked = await this.ledger.lock(tx, ctx.companyId, [
      { productId: input.productId, warehouseId: input.warehouseId },
    ]);
    const balance = locked.get(`${input.productId}|${input.warehouseId}`);
    if (balance === undefined) throw new Error('Balance not locked');

    const outbound = movement.quantity.isNegative();
    const after = balance.quantity.add(movement.quantity);
    const goesNegative = outbound && after.isNegative();
    if (goesNegative) {
      const fields = {
        product_id: [input.productId],
        warehouse_id: [input.warehouseId],
        available: [balance.quantity.toString()],
        requested: [movement.quantity.abs().toString()],
        resulting_balance: [after.toString()],
      };
      if (!company.allowNegativeStock) {
        throw new AppException(ERROR_CODES.STOCK_INSUFFICIENT, 422, { fields });
      }
      if (!input.acknowledgeNegative) {
        throw new AppException(ERROR_CODES.STOCK_NEGATIVE_WARNING, 409, { fields });
      }
    }
    const unitCost = outbound
      ? balance.averageCost
      : resolveInboundCost({
          sent: movement.unitCost,
          locationQuantity: balance.quantity,
          locationAverage: balance.averageCost,
          costPrice: product.costPrice,
        });

    const [written] = await this.ledger.post(
      tx,
      ctx.companyId,
      ctx.userId,
      locked,
      [
        {
          ...(input.movementId === undefined ? {} : { id: input.movementId }),
          productId: input.productId,
          warehouseId: input.warehouseId,
          type: movement.type,
          quantity: movement.quantity,
          unitCost,
          reason: movement.reason,
        },
      ],
      now,
      goesNegative ? 'allow' : 'refuse',
    );
    if (written === undefined) throw new Error('No movement written');

    await this.audit.record(tx, {
      companyId: ctx.companyId,
      userId: ctx.userId,
      action: 'STOCK_MOVEMENT_CREATED',
      entityType: 'stock_movement',
      entityId: written.id,
      newValues: {
        product_id: input.productId,
        warehouse_id: input.warehouseId,
        type: movement.type,
        quantity: written.quantity,
        unit_cost: written.unitCost,
        balance_before: written.balanceBefore,
        balance_after: written.balanceAfter,
        ...(movement.reason === null ? {} : { reason: movement.reason }),
        // DOCUMENT 17 rule 5: "always warned and recorded".
        ...(goesNegative ? { negative_stock: true, negative_stock_acknowledged: true } : {}),
      },
      ipAddress: origin.ipAddress,
      userAgent: origin.userAgent,
    });

    const totalAfter = totalBefore.add(movement.quantity);
    const crossed = crossings(totalBefore, totalAfter, product.minStock);
    const base = {
      companyId: ctx.companyId,
      productId: input.productId,
      warehouseId: input.warehouseId,
      movementId: written.id,
      occurredAt: now,
    };
    const events: InventoryEvent[] = [];
    if (crossed.lowStock) events.push({ ...base, type: 'low_stock' });
    if (crossed.outOfStock) events.push({ ...base, type: 'out_of_stock' });
    if (goesNegative) events.push({ ...base, type: 'negative_stock' });
    return { movementId: written.id, events };
  }

  async create(
    ctx: AuthContext,
    dto: CreateMovementDto,
    idempotency: IdempotencyRequest | null,
    origin: RequestOrigin,
    now: Date = new Date(),
  ): Promise<CreatedMovementPayload> {
    requireCompany(ctx, 'stock.movement_create');
    if (idempotency === null) {
      throw new AppException(ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED, 422, {
        fields: { 'Idempotency-Key': ['required'] },
      });
    }
    const { issues, movement } = validateMovement(dto);
    if (movement === null) {
      throw new AppException(ERROR_CODES.VALIDATION_FAILED, 422, { fields: issues });
    }
    const movementId = generateId();
    let id: string;
    let events: InventoryEvent[] = [];
    try {
      id = await this.tenant(ctx, async (tx) => {
        const prior = await this.idempotency.replay(tx, ctx, idempotency, now);
        if (prior !== null) return prior;
        await this.idempotency.claim(tx, ctx, idempotency, movementId, now);
        const applied = await this.apply(
          tx,
          ctx,
          {
            productId: dto.product_id,
            warehouseId: dto.warehouse_id,
            movement,
            acknowledgeNegative: dto.acknowledge_negative_stock === true,
            movementId,
            fields: { product: 'product_id', warehouse: 'warehouse_id' },
          },
          origin,
          now,
        );
        events = applied.events;
        return applied.movementId;
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const prior = await this.tenant(ctx, (tx) =>
        this.idempotency.replay(tx, ctx, idempotency, now),
      );
      if (prior === null) throw error;
      id = prior;
      events = [];
    }
    await this.events.publish(events);
    return this.get(ctx, id);
  }

  async get(ctx: AuthContext, id: string): Promise<CreatedMovementPayload> {
    requireCompany(ctx, 'stock.view');
    return this.tenant(ctx, async (tx) => {
      const row = await tx.stockMovement.findFirst({ where: { id }, include: MOVEMENT_INCLUDE });
      if (row === null) throw notFound();
      return createdPayload(movementPayload(row));
    });
  }
}

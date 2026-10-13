/**
 * Warehouses, per-location stock and transfers — DOCUMENT 17, DOCUMENT 08
 * §4.11, DOCUMENT 04 B19–B21, DOCUMENT 05 FLOW 18 (transfer).
 *
 * Guarantees, each proved in `test/warehouse.e2e.test.ts`:
 *
 *   - **One stock model.** An online channel is a warehouse of type
 *     `online`; nothing else about it differs.
 *   - **ADMIN only in V1** (DOCUMENT 17 "Users", DOCUMENT 02): every call
 *     needs a company-scope warehouse or stock permission; MANAGER and
 *     EMPLOYEE hold none. Another company's warehouse is 404, and a
 *     reference to one in a request is `not_found`, never a confirmation.
 *   - **A transfer is one transaction** (rule 4): both warehouses are locked
 *     `FOR SHARE` (so neither can be deactivated mid-transfer), every touched
 *     balance is locked `FOR UPDATE` in a fixed order, and for each line the
 *     `transfer_out` and `transfer_in` legs — one `transfer_group_id` — are
 *     written through the ledger with their cache updates. Any failure writes
 *     nothing.
 *   - **Value is preserved:** both legs carry the source's average cost; the
 *     destination's average follows rule 11, rounded once.
 *   - **A warehouse holding stock cannot be deactivated** (409
 *     `WAREHOUSE_HAS_STOCK`), checked under the warehouse's row lock; the
 *     database refuses it too.
 *   - **Audit after commit** (`AuditDispatcher`): `warehouse.created`,
 *     `warehouse.updated`, `warehouse.deactivated`, `stock.transfer_executed`.
 *     A transfer is idempotent under `Idempotency-Key`.
 */

import { Inject, Injectable } from '@nestjs/common';
import { generateId } from '@ufuq/db';
import type { Prisma, PrismaClient, TenantClient } from '@ufuq/db';
import { Decimal } from '@ufuq/money';

import {
  calendarDateIn,
  formatCalendarDate,
  instantAt,
  parseCalendarDate,
} from '../attendance/zoned-time.js';
import type { CalendarDate } from '../attendance/zoned-time.js';
import { AuditDispatcher } from '../auth/audit-dispatcher.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AppException } from '../common/app-exception.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import { ERROR_CODES } from '../common/errors.js';
import { IdempotencyService, isUniqueViolation } from '../common/idempotency.js';
import type { IdempotencyRequest } from '../common/idempotency.js';
import type { RequestOrigin } from '../common/request-context.js';
import { resolvePage } from '../company-structure/dto/pagination.dto.js';
import { notFound, TenantScopedService } from '../company-structure/tenant-scoped.service.js';

import type {
  CreateTransferDto,
  CreateWarehouseDto,
  ListMovementsQueryDto,
  ListWarehousesQueryDto,
  UpdateWarehouseDto,
} from './dto/warehouse.dto.js';
import { StockLedgerService } from './stock-ledger.service.js';
import type { LedgerEntry } from './stock-ledger.service.js';
import { money, quantity, stockValue, validateTransfer } from './warehouse-rules.js';

/** DOCUMENT 04 B19: "recent movements (last 20)". */
export const RECENT_MOVEMENTS = 20;
/** The activity trend's window, in days. */
export const TREND_DAYS = 30;

export interface WarehouseSummary {
  readonly product_count: number;
  readonly total_quantity: string;
  readonly stock_value: string;
}

export interface WarehousePayload extends WarehouseSummary {
  readonly id: string;
  readonly name_ar: string;
  readonly name_en: string;
  readonly type: string;
  readonly address: string | null;
  readonly is_active: boolean;
  readonly created_at: string;
}

export interface StockRowPayload {
  readonly product: {
    readonly id: string;
    readonly sku: string;
    readonly name_ar: string;
    readonly name_en: string;
    readonly unit: string;
    readonly status: string;
  };
  readonly quantity: string;
  readonly average_cost: string;
  readonly stock_value: string;
}

export interface MovementPayload {
  readonly id: string;
  readonly type: string;
  readonly product: {
    readonly id: string;
    readonly sku: string;
    readonly name_ar: string;
    readonly name_en: string;
    readonly unit: string;
  };
  readonly warehouse: {
    readonly id: string;
    readonly name_ar: string;
    readonly name_en: string;
    readonly type: string;
  };
  readonly quantity: string;
  readonly unit_cost: string | null;
  readonly balance_after: string;
  readonly transfer_group_id: string | null;
  readonly reason: string | null;
  readonly created_by: { readonly id: string; readonly email: string };
  readonly created_at: string;
}

export interface TransferPayload {
  readonly transfer_group_id: string;
  readonly source: {
    readonly id: string;
    readonly name_ar: string;
    readonly name_en: string;
    readonly type: string;
  };
  readonly destination: {
    readonly id: string;
    readonly name_ar: string;
    readonly name_en: string;
    readonly type: string;
  };
  readonly lines: readonly {
    readonly product: MovementPayload['product'];
    readonly quantity: string;
    readonly unit_cost: string | null;
    readonly out_movement_id: string;
    readonly in_movement_id: string;
    readonly source_balance_after: string;
    readonly destination_balance_after: string;
  }[];
  readonly note: string | null;
  readonly value: string;
  readonly created_by: { readonly id: string; readonly email: string };
  readonly created_at: string;
}

export interface WarehouseDashboard {
  readonly kpis: {
    readonly locations_total: number;
    readonly locations_active: number;
    readonly products_in_stock: number;
    readonly total_stock_units: string;
    readonly total_inventory_value: string;
  };
  readonly by_location: readonly WarehousePayload[];
  readonly recent_movements: readonly MovementPayload[];
  /** Movements per day, oldest first, in the company's timezone. */
  readonly activity_trend: readonly { readonly date: string; readonly movements: number }[];
  /** DOCUMENT 04 B19 elements that need Phase 14's catalogue (min stock, product count). */
  readonly deferred: readonly string[];
}

const MOVEMENT_INCLUDE = {
  product: { select: { id: true, sku: true, nameAr: true, nameEn: true, unit: true } },
  warehouse: { select: { id: true, nameAr: true, nameEn: true, type: true } },
  creator: { select: { id: true, email: true } },
} as const;

type MovementRow = Prisma.StockMovementGetPayload<{ include: typeof MOVEMENT_INCLUDE }>;

function movementPayload(row: MovementRow): MovementPayload {
  return {
    id: row.id,
    type: row.type,
    product: {
      id: row.product.id,
      sku: row.product.sku,
      name_ar: row.product.nameAr,
      name_en: row.product.nameEn,
      unit: row.product.unit,
    },
    warehouse: {
      id: row.warehouse.id,
      name_ar: row.warehouse.nameAr,
      name_en: row.warehouse.nameEn,
      type: row.warehouse.type,
    },
    quantity: quantity(row.quantity).toString(),
    unit_cost: row.unitCost === null ? null : money(row.unitCost).toString(),
    balance_after: quantity(row.balanceAfter).toString(),
    transfer_group_id: row.transferGroupId,
    reason: row.reason,
    created_by: row.creator,
    created_at: row.createdAt.toISOString(),
  };
}

function forbidden(): AppException {
  return new AppException(ERROR_CODES.FORBIDDEN, 403);
}

/** ADMIN-only in V1: a company scope, nothing narrower (DOCUMENT 17 "Users"). */
function requireCompany(ctx: AuthContext, permission: string): void {
  const scope = ctx.permissions.get(permission);
  if (scope !== 'company' && scope !== 'platform') throw forbidden();
}

type WarehouseRow = Prisma.WarehouseGetPayload<object>;

function ref(row: { id: string; nameAr: string; nameEn: string; type: string }) {
  return { id: row.id, name_ar: row.nameAr, name_en: row.nameEn, type: row.type };
}

@Injectable()
export class WarehouseService extends TenantScopedService {
  constructor(
    @Inject(PRISMA_CLIENT) prisma: PrismaClient,
    @Inject(AuditDispatcher) private readonly audit: AuditDispatcher,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(StockLedgerService) private readonly ledger: StockLedgerService,
  ) {
    super(prisma, audit);
  }

  // -- Warehouses ---------------------------------------------------------------

  private async summaries(
    tx: TenantClient,
    warehouseIds: readonly string[],
  ): Promise<Map<string, WarehouseSummary>> {
    const rows = await tx.productStock.findMany({
      where: { warehouseId: { in: [...warehouseIds] }, quantity: { not: 0 } },
      select: { warehouseId: true, quantity: true, averageCost: true },
    });
    const out = new Map<string, WarehouseSummary>();
    for (const id of warehouseIds) {
      const own = rows
        .filter((row) => row.warehouseId === id)
        .map((row) => ({ quantity: quantity(row.quantity), averageCost: money(row.averageCost) }));
      out.set(id, {
        product_count: own.length,
        total_quantity: Decimal.sum(
          own.map((r) => r.quantity),
          3,
        ).toString(),
        stock_value: stockValue(own).toString(),
      });
    }
    return out;
  }

  private payload(row: WarehouseRow, summary: WarehouseSummary): WarehousePayload {
    return {
      id: row.id,
      name_ar: row.nameAr,
      name_en: row.nameEn,
      type: row.type,
      address: row.address,
      is_active: row.isActive,
      created_at: row.createdAt.toISOString(),
      ...summary,
    };
  }

  async list(
    ctx: AuthContext,
    query: ListWarehousesQueryDto,
  ): Promise<{ readonly items: readonly WarehousePayload[]; readonly total: number }> {
    requireCompany(ctx, 'warehouse.view');
    const page = resolvePage(query);
    const where: Prisma.WarehouseWhereInput = {
      deletedAt: null,
      ...(query.type === undefined ? {} : { type: query.type }),
      ...(query.is_active === undefined ? {} : { isActive: query.is_active === 'true' }),
    };
    return this.tenant(ctx, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.warehouse.findMany({
          where,
          orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
          skip: page.skip,
          take: page.take,
        }),
        tx.warehouse.count({ where }),
      ]);
      const summaries = await this.summaries(
        tx,
        rows.map((row) => row.id),
      );
      return {
        items: rows.map((row) => this.payload(row, summaries.get(row.id) as WarehouseSummary)),
        total,
      };
    });
  }

  async get(ctx: AuthContext, id: string): Promise<WarehousePayload> {
    requireCompany(ctx, 'warehouse.view');
    return this.tenant(ctx, async (tx) => {
      const row = await tx.warehouse.findFirst({ where: { id, deletedAt: null } });
      if (row === null) throw notFound();
      return this.payload(row, (await this.summaries(tx, [id])).get(id) as WarehouseSummary);
    });
  }

  async create(
    ctx: AuthContext,
    dto: CreateWarehouseDto,
    origin: RequestOrigin,
  ): Promise<WarehousePayload> {
    requireCompany(ctx, 'warehouse.manage');
    const id = generateId();
    await this.tenant(ctx, async (tx) => {
      await tx.warehouse.create({
        data: {
          id,
          companyId: ctx.companyId,
          nameAr: dto.name_ar,
          nameEn: dto.name_en,
          type: dto.type,
          address: dto.address ?? null,
        },
      });
      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'WAREHOUSE_CREATED',
        entityType: 'warehouse',
        entityId: id,
        newValues: {
          name_ar: dto.name_ar,
          name_en: dto.name_en,
          type: dto.type,
          address: dto.address ?? null,
          is_active: true,
        },
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });
    });
    return this.get(ctx, id);
  }

  async update(
    ctx: AuthContext,
    id: string,
    dto: UpdateWarehouseDto,
    origin: RequestOrigin,
  ): Promise<WarehousePayload> {
    requireCompany(ctx, 'warehouse.manage');
    await this.tenant(ctx, async (tx) => {
      // The row lock serializes with a transfer holding it FOR SHARE.
      await tx.$queryRaw`SELECT id FROM warehouses WHERE id = ${id}::uuid AND deleted_at IS NULL FOR UPDATE`;
      const before = await tx.warehouse.findFirst({ where: { id, deletedAt: null } });
      if (before === null) throw notFound();
      const deactivating = dto.is_active === false && before.isActive;
      if (deactivating) {
        const holding = await tx.productStock.count({
          where: { warehouseId: id, quantity: { not: 0 } },
        });
        if (holding > 0) {
          throw new AppException(ERROR_CODES.WAREHOUSE_HAS_STOCK, 409, {
            fields: { product_count: [String(holding)] },
          });
        }
      }
      const next = {
        name_ar: dto.name_ar ?? before.nameAr,
        name_en: dto.name_en ?? before.nameEn,
        type: dto.type ?? before.type,
        address: dto.address === undefined ? before.address : dto.address,
        is_active: dto.is_active ?? before.isActive,
      };
      const previous = {
        name_ar: before.nameAr,
        name_en: before.nameEn,
        type: before.type,
        address: before.address,
        is_active: before.isActive,
      };
      const changed = (Object.keys(next) as (keyof typeof next)[]).filter(
        (key) => next[key] !== previous[key],
      );
      if (changed.length === 0) return;
      await tx.warehouse.update({
        where: { id },
        data: {
          nameAr: next.name_ar,
          nameEn: next.name_en,
          type: next.type,
          address: next.address,
          isActive: next.is_active,
        },
      });
      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: deactivating ? 'WAREHOUSE_DEACTIVATED' : 'WAREHOUSE_UPDATED',
        entityType: 'warehouse',
        entityId: id,
        oldValues: Object.fromEntries(changed.map((key) => [key, previous[key]])),
        newValues: Object.fromEntries(changed.map((key) => [key, next[key]])),
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });
    });
    return this.get(ctx, id);
  }

  // -- Stock at a location --------------------------------------------------------

  /** GET /warehouses/{id}/stock — every product held here (non-zero balances). Read-only. */
  async stock(
    ctx: AuthContext,
    id: string,
    query: { page?: number; per_page?: number },
  ): Promise<{ readonly items: readonly StockRowPayload[]; readonly total: number }> {
    requireCompany(ctx, 'stock.view');
    const page = resolvePage(query);
    return this.tenant(ctx, async (tx) => {
      const warehouse = await tx.warehouse.findFirst({
        where: { id, deletedAt: null },
        select: { id: true },
      });
      if (warehouse === null) throw notFound();
      const where: Prisma.ProductStockWhereInput = { warehouseId: id, quantity: { not: 0 } };
      const [rows, total] = await Promise.all([
        tx.productStock.findMany({
          where,
          include: {
            product: {
              select: { id: true, sku: true, nameAr: true, nameEn: true, unit: true, status: true },
            },
          },
          orderBy: [{ product: { sku: 'asc' } }, { id: 'asc' }],
          skip: page.skip,
          take: page.take,
        }),
        tx.productStock.count({ where }),
      ]);
      return {
        items: rows.map((row) => {
          const qty = quantity(row.quantity);
          const avg = money(row.averageCost);
          return {
            product: {
              id: row.product.id,
              sku: row.product.sku,
              name_ar: row.product.nameAr,
              name_en: row.product.nameEn,
              unit: row.product.unit,
              status: row.product.status,
            },
            quantity: qty.toString(),
            average_cost: avg.toString(),
            stock_value: stockValue([{ quantity: qty, averageCost: avg }]).toString(),
          };
        }),
        total,
      };
    });
  }

  // -- Movements (read-only) -------------------------------------------------------

  /** GET /stock-movements — the ledger, newest first, with DOCUMENT 08 §4.11's filters. */
  async movements(
    ctx: AuthContext,
    query: ListMovementsQueryDto,
  ): Promise<{ readonly items: readonly MovementPayload[]; readonly total: number }> {
    requireCompany(ctx, 'stock.view');
    const page = resolvePage(query);
    return this.tenant(ctx, async (tx) => {
      const company = await tx.company.findFirstOrThrow({ select: { timezone: true } });
      // A date filter is read in the company's timezone (DOCUMENT 11 §9).
      const dayStart = (date: string, offsetDays = 0): Date => {
        const parsed = parseCalendarDate(date) as CalendarDate;
        const day = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + offsetDays));
        return instantAt(
          { year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate() },
          0,
          company.timezone,
        );
      };
      const where: Prisma.StockMovementWhereInput = {
        ...(query.product_id === undefined ? {} : { productId: query.product_id }),
        ...(query.warehouse_id === undefined ? {} : { warehouseId: query.warehouse_id }),
        ...(query.type === undefined ? {} : { type: query.type }),
        ...(query.created_by === undefined ? {} : { createdBy: query.created_by }),
        ...(query.from === undefined && query.to === undefined
          ? {}
          : {
              createdAt: {
                ...(query.from === undefined ? {} : { gte: dayStart(query.from) }),
                ...(query.to === undefined ? {} : { lt: dayStart(query.to, 1) }),
              },
            }),
      };
      const [rows, total] = await Promise.all([
        tx.stockMovement.findMany({
          where,
          include: MOVEMENT_INCLUDE,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: page.skip,
          take: page.take,
        }),
        tx.stockMovement.count({ where }),
      ]);
      return { items: rows.map(movementPayload), total };
    });
  }

  // -- Dashboard --------------------------------------------------------------------

  /** GET /warehouses/dashboard — DOCUMENT 04 B19, the parts Phase 13's data answers. */
  async dashboard(ctx: AuthContext, now: Date = new Date()): Promise<WarehouseDashboard> {
    requireCompany(ctx, 'warehouse.view');
    return this.tenant(ctx, async (tx) => {
      const company = await tx.company.findFirstOrThrow({ select: { timezone: true } });
      const warehouses = await tx.warehouse.findMany({
        where: { deletedAt: null },
        orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
      });
      const summaries = await this.summaries(
        tx,
        warehouses.map((w) => w.id),
      );
      const balances = await tx.productStock.findMany({
        where: { quantity: { not: 0 } },
        select: { productId: true, quantity: true, averageCost: true },
      });
      const exact = balances.map((b) => ({
        quantity: quantity(b.quantity),
        averageCost: money(b.averageCost),
      }));
      const recent = await tx.stockMovement.findMany({
        include: MOVEMENT_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: RECENT_MOVEMENTS,
      });
      const since = new Date(now.getTime() - TREND_DAYS * 24 * 60 * 60 * 1000);
      const window = await tx.stockMovement.findMany({
        where: { createdAt: { gte: since } },
        select: { createdAt: true },
      });
      const counts = new Map<string, number>();
      for (let i = TREND_DAYS - 1; i >= 0; i--) {
        const day = formatCalendarDate(
          calendarDateIn(new Date(now.getTime() - i * 24 * 60 * 60 * 1000), company.timezone),
        );
        counts.set(day, 0);
      }
      for (const row of window) {
        const day = formatCalendarDate(calendarDateIn(row.createdAt, company.timezone));
        if (counts.has(day)) counts.set(day, (counts.get(day) ?? 0) + 1);
      }
      return {
        kpis: {
          locations_total: warehouses.length,
          locations_active: warehouses.filter((w) => w.isActive).length,
          products_in_stock: new Set(balances.map((b) => b.productId)).size,
          total_stock_units: Decimal.sum(
            exact.map((b) => b.quantity),
            3,
          ).toString(),
          total_inventory_value: stockValue(exact).toString(),
        },
        by_location: warehouses.map((w) =>
          this.payload(w, summaries.get(w.id) as WarehouseSummary),
        ),
        recent_movements: recent.map(movementPayload),
        activity_trend: [...counts].map(([date, movements]) => ({ date, movements })),
        deferred: ['total_products', 'low_stock_count', 'out_of_stock_count', 'low_stock_table'],
      };
    });
  }

  // -- Transfers ----------------------------------------------------------------------

  private async transferPayload(
    tx: TenantClient,
    groupId: string,
  ): Promise<TransferPayload | null> {
    const rows = await tx.stockMovement.findMany({
      where: { transferGroupId: groupId },
      include: MOVEMENT_INCLUDE,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const outs = rows.filter((row) => row.type === 'transfer_out');
    const ins = rows.filter((row) => row.type === 'transfer_in');
    const first = outs[0];
    const firstIn = ins[0];
    if (first === undefined || firstIn === undefined) return null;
    const lines = outs.map((out) => {
      const inbound = ins.find((row) => row.productId === out.productId) as MovementRow;
      return {
        product: movementPayload(out).product,
        quantity: quantity(out.quantity).abs().toString(),
        unit_cost: out.unitCost === null ? null : money(out.unitCost).toString(),
        out_movement_id: out.id,
        in_movement_id: inbound.id,
        source_balance_after: quantity(out.balanceAfter).toString(),
        destination_balance_after: quantity(inbound.balanceAfter).toString(),
      };
    });
    return {
      transfer_group_id: groupId,
      source: ref(first.warehouse),
      destination: ref(firstIn.warehouse),
      lines,
      note: first.reason,
      value: stockValue(
        ins.map((row) => ({
          quantity: quantity(row.quantity),
          averageCost: money(row.unitCost ?? 0),
        })),
      ).toString(),
      created_by: first.creator,
      created_at: first.createdAt.toISOString(),
    };
  }

  /** GET /warehouses/transfers — newest first, one entry per transfer group. */
  async listTransfers(
    ctx: AuthContext,
    query: { page?: number; per_page?: number },
  ): Promise<{ readonly items: readonly TransferPayload[]; readonly total: number }> {
    requireCompany(ctx, 'stock.view');
    const page = resolvePage(query);
    return this.tenant(ctx, async (tx) => {
      const groups = await tx.stockMovement.findMany({
        where: { type: 'transfer_out' },
        distinct: ['transferGroupId'],
        select: { transferGroupId: true, createdAt: true },
        orderBy: [{ createdAt: 'desc' }, { transferGroupId: 'desc' }],
      });
      const total = groups.length;
      const slice = groups.slice(page.skip, page.skip + page.take);
      const items: TransferPayload[] = [];
      for (const group of slice) {
        const payload = await this.transferPayload(tx, group.transferGroupId as string);
        if (payload !== null) items.push(payload);
      }
      return { items, total };
    });
  }

  async getTransfer(ctx: AuthContext, groupId: string): Promise<TransferPayload> {
    requireCompany(ctx, 'stock.view');
    return this.tenant(ctx, async (tx) => {
      const payload = await this.transferPayload(tx, groupId);
      if (payload === null) throw notFound();
      return payload;
    });
  }

  /** POST /warehouses/transfers — DOCUMENT 17 rule 4. */
  async transfer(
    ctx: AuthContext,
    dto: CreateTransferDto,
    idempotency: IdempotencyRequest | null,
    origin: RequestOrigin,
    now: Date = new Date(),
  ): Promise<TransferPayload> {
    requireCompany(ctx, 'stock.transfer');
    const { issues, quantities } = validateTransfer(dto);
    if (Object.keys(issues).length > 0) {
      throw new AppException(ERROR_CODES.VALIDATION_FAILED, 422, { fields: issues });
    }
    const groupId = generateId();
    let id = groupId;
    try {
      id = await this.tenant(ctx, async (tx) => {
        if (idempotency !== null) {
          const prior = await this.idempotency.replay(tx, ctx, idempotency, now);
          if (prior !== null) return prior;
          await this.idempotency.claim(tx, ctx, idempotency, groupId, now);
        }
        // Both locations exist here, are active, and stay so until commit.
        const warehouses = await tx.$queryRaw<{ id: string; is_active: boolean }[]>`
          SELECT id, is_active FROM warehouses
          WHERE id IN (${dto.source_warehouse_id}::uuid, ${dto.destination_warehouse_id}::uuid)
            AND deleted_at IS NULL
          ORDER BY id
          FOR SHARE`;
        const fields: Record<string, string[]> = {};
        for (const [field, wid] of [
          ['source_warehouse_id', dto.source_warehouse_id],
          ['destination_warehouse_id', dto.destination_warehouse_id],
        ] as const) {
          if (!warehouses.some((w) => w.id === wid)) fields[field] = ['not_found'];
        }
        if (Object.keys(fields).length > 0) {
          throw new AppException(ERROR_CODES.VALIDATION_FAILED, 422, { fields });
        }
        const inactive = warehouses.filter((w) => !w.is_active).map((w) => w.id);
        if (inactive.length > 0) {
          throw new AppException(ERROR_CODES.WAREHOUSE_INACTIVE, 409, {
            fields: { warehouse_id: inactive },
          });
        }
        const productIds = dto.lines.map((line) => line.product_id);
        const products = await tx.product.findMany({
          where: { id: { in: productIds }, deletedAt: null },
          select: { id: true },
        });
        const missing = dto.lines
          .map((line, index) => ({ line, index }))
          .filter(({ line }) => !products.some((p) => p.id === line.product_id));
        if (missing.length > 0) {
          throw new AppException(ERROR_CODES.VALIDATION_FAILED, 422, {
            fields: Object.fromEntries(
              missing.map(({ index }) => [`lines.${String(index)}.product_id`, ['not_found']]),
            ),
          });
        }

        const locked = await this.ledger.lock(
          tx,
          ctx.companyId,
          productIds.flatMap((productId) => [
            { productId, warehouseId: dto.source_warehouse_id },
            { productId, warehouseId: dto.destination_warehouse_id },
          ]),
        );
        const entries: LedgerEntry[] = dto.lines.flatMap((line, index) => {
          const qty = quantities[index] as Decimal;
          const source = locked.get(`${line.product_id}|${dto.source_warehouse_id}`);
          const cost = source?.averageCost ?? Decimal.zero(2);
          return [
            {
              productId: line.product_id,
              warehouseId: dto.source_warehouse_id,
              type: 'transfer_out' as const,
              quantity: qty.negate(),
              unitCost: cost,
              transferGroupId: groupId,
              reason: dto.note ?? null,
            },
            {
              productId: line.product_id,
              warehouseId: dto.destination_warehouse_id,
              type: 'transfer_in' as const,
              quantity: qty,
              unitCost: cost,
              transferGroupId: groupId,
              reason: dto.note ?? null,
            },
          ];
        });
        const written = await this.ledger.post(tx, ctx.companyId, ctx.userId, locked, entries, now);

        await this.audit.record(tx, {
          companyId: ctx.companyId,
          userId: ctx.userId,
          action: 'STOCK_TRANSFER_EXECUTED',
          entityType: 'stock_transfer',
          entityId: groupId,
          newValues: {
            source_warehouse_id: dto.source_warehouse_id,
            destination_warehouse_id: dto.destination_warehouse_id,
            lines: dto.lines.map((line, index) => ({
              product_id: line.product_id,
              quantity: (quantities[index] as Decimal).toString(),
              unit_cost: (entries[index * 2]?.unitCost as Decimal).toString(),
            })),
            movement_ids: written.map((m) => m.id),
            ...(dto.note === undefined ? {} : { note: dto.note }),
          },
          ipAddress: origin.ipAddress,
          userAgent: origin.userAgent,
        });
        return groupId;
      });
    } catch (error) {
      if (!(idempotency !== null && isUniqueViolation(error))) throw error;
      const prior = await this.tenant(ctx, (tx) =>
        this.idempotency.replay(tx, ctx, idempotency, now),
      );
      if (prior === null) throw error;
      id = prior;
    }
    return this.getTransfer(ctx, id);
  }
}

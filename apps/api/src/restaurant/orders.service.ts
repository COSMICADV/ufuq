/**
 * 1to1OS Business — Restaurants & Cafés: orders, from the POS through the
 * kitchen to the waiter, the pickup counter or delivery.
 *
 *   - Confirming an order prices it on the server from the menu as it is now
 *     (the screen's prices are never trusted), numbers it per branch, and
 *     tells every screen of that branch at once (restaurant-events.ts).
 *   - A repeated "Confirm" (double tap, retry after a dropped connection)
 *     carries the same client_key and gets the first order back.
 *   - Status changes lock the order row, so two screens tapping at once
 *     cannot both move it; every change is kept in the order's own history
 *     and in the audit log.
 *   - Kitchen staff receive orders without any prices or totals.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { generateId, Prisma } from '@ufuq/db';
import type { PrismaClient, TenantClient } from '@ufuq/db';
import { Decimal } from '@ufuq/money';

import { AuditDispatcher } from '../auth/audit-dispatcher.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AppException } from '../common/app-exception.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import { ERROR_CODES } from '../common/errors.js';
import type { RequestOrigin } from '../common/request-context.js';
import {
  fieldError,
  notFound,
  TenantScopedService,
} from '../company-structure/tenant-scoped.service.js';
import { calendarDateIn, instantAt } from '../attendance/zoned-time.js';

import { can, requireAction, resolveAccess, resolveBranch } from './restaurant-access.js';
import type { RestaurantAccess } from './restaurant-access.js';
import { RestaurantEvents } from './restaurant-events.js';
import type { OrderEvent } from './restaurant-events.js';
import type { CreateOrderDto, OrdersQueryDto, OrderView } from './restaurant.dto.js';
import {
  ACTIVE_STATUSES,
  cancellable,
  money,
  MONEY_SCALE,
  orderTotals,
  priceLine,
  transitionAction,
} from './restaurant-rules.js';
import type { OrderStatus, OrderType } from './restaurant-rules.js';

export interface OrderOptionLine {
  readonly kind: 'extra' | 'customization';
  readonly name: string;
  /** Absent for kitchen staff. */
  readonly price?: string;
}

export interface OrderLinePayload {
  readonly id: string;
  readonly menu_item_id: string | null;
  readonly name: string;
  readonly size_name: string | null;
  readonly quantity: number;
  readonly options: readonly OrderOptionLine[];
  readonly notes: string | null;
  readonly image_version: number | null;
  readonly unit_price?: string;
  readonly line_total?: string;
}

export interface OrderPayload {
  readonly id: string;
  readonly branch: { readonly id: string; readonly name: string };
  readonly number: number;
  readonly type: OrderType;
  readonly status: OrderStatus;
  readonly table: { readonly id: string; readonly label: string } | null;
  readonly waiter: { readonly id: string; readonly name: string } | null;
  readonly customer_name: string | null;
  readonly customer_phone: string | null;
  readonly delivery_address: string | null;
  readonly notes: string | null;
  readonly items: readonly OrderLinePayload[];
  readonly created_by: string;
  readonly created_at: string;
  readonly preparing_at: string | null;
  readonly ready_at: string | null;
  readonly fulfilled_at: string | null;
  readonly cancelled_at: string | null;
  readonly cancel_reason: string | null;
  /** Absent for kitchen staff. */
  readonly totals?: {
    readonly subtotal: string;
    readonly discount: string;
    readonly service: string;
    readonly tax: string;
    readonly total: string;
    readonly tax_rate: string;
    readonly service_rate: string;
  };
  readonly history?: readonly {
    readonly from: OrderStatus | null;
    readonly to: OrderStatus;
    readonly at: string;
    readonly by: string;
    readonly note: string | null;
  }[];
}

const ORDER_INCLUDE = {
  branch: { select: { id: true, name: true } },
  table: { select: { id: true, label: true } },
  waiter: { select: { id: true, firstName: true, lastName: true } },
  items: {
    orderBy: { sortOrder: 'asc' },
    include: { menuItem: { select: { imageKey: true, imageVersion: true } } },
  },
} as const satisfies Prisma.RestaurantOrderInclude;

type OrderRow = Prisma.RestaurantOrderGetPayload<{ include: typeof ORDER_INCLUDE }>;

interface StoredOption {
  readonly kind: 'extra' | 'customization';
  readonly name: string;
  readonly price: string;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function orderPayload(row: OrderRow, prices: boolean, creator: string): OrderPayload {
  return {
    id: row.id,
    branch: row.branch,
    number: row.number,
    type: row.type,
    status: row.status,
    table: row.table,
    waiter: row.waiter
      ? { id: row.waiter.id, name: `${row.waiter.firstName} ${row.waiter.lastName}`.trim() }
      : null,
    customer_name: row.customerName,
    customer_phone: row.customerPhone,
    delivery_address: row.deliveryAddress,
    notes: row.notes,
    items: row.items.map((line) => {
      const options = (Array.isArray(line.options)
        ? line.options
        : []) as unknown as StoredOption[];
      return {
        id: line.id,
        menu_item_id: line.menuItemId,
        name: line.name,
        size_name: line.sizeName,
        quantity: line.quantity,
        options: options.map((o) =>
          prices ? { kind: o.kind, name: o.name, price: o.price } : { kind: o.kind, name: o.name },
        ),
        notes: line.notes,
        image_version: line.menuItem?.imageKey ? line.menuItem.imageVersion : null,
        ...(prices
          ? {
              unit_price: money(line.unitPrice).toString(),
              line_total: money(line.lineTotal).toString(),
            }
          : {}),
      };
    }),
    created_by: creator,
    created_at: row.createdAt.toISOString(),
    preparing_at: iso(row.preparingAt),
    ready_at: iso(row.readyAt),
    fulfilled_at: iso(row.fulfilledAt),
    cancelled_at: iso(row.cancelledAt),
    cancel_reason: row.cancelReason,
    ...(prices
      ? {
          totals: {
            subtotal: money(row.subtotal).toString(),
            discount: money(row.discount).toString(),
            service: money(row.service).toString(),
            tax: money(row.tax).toString(),
            total: money(row.total).toString(),
            tax_rate: money(row.taxRate).toString(),
            service_rate: money(row.serviceRate).toString(),
          },
        }
      : {}),
  };
}

function invalidTransition(): AppException {
  return new AppException(ERROR_CODES.INVALID_STATUS_TRANSITION, 409);
}

@Injectable()
export class RestaurantOrdersService extends TenantScopedService {
  private readonly logger = new Logger(RestaurantOrdersService.name);

  constructor(
    @Inject(PRISMA_CLIENT) prisma: PrismaClient,
    @Inject(AuditDispatcher) private readonly audit: AuditDispatcher,
    @Inject(RestaurantEvents) private readonly events: RestaurantEvents,
  ) {
    super(prisma, audit);
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  async create(
    ctx: AuthContext,
    dto: CreateOrderDto,
    origin: RequestOrigin,
  ): Promise<OrderPayload> {
    let event: OrderEvent | null = null;
    let result: OrderPayload;
    try {
      result = await this.tenant(ctx, async (tx) => {
        const access = await resolveAccess(tx, ctx);
        requireAction(access, 'orders.create');
        const existing = await tx.restaurantOrder.findFirst({
          where: { clientKey: dto.client_key },
          select: { id: true },
        });
        if (existing) return this.load(tx, ctx, access, existing.id);

        const branchId = await resolveBranch(tx, access, dto.branch_id);
        const branch = await tx.restaurantBranch.findFirstOrThrow({ where: { id: branchId } });

        // The table and the waiter, for dine-in.
        let tableId: string | null = null;
        let waiterId: string | null = null;
        if (dto.type === 'dine_in') {
          const table = await tx.restaurantTable.findFirst({
            where: { id: dto.table_id ?? '', branchId, archivedAt: null },
            select: { id: true, defaultWaiterId: true },
          });
          if (!table) throw fieldError({ table_id: ['not_found'] });
          tableId = table.id;
          waiterId = dto.waiter_id !== undefined ? dto.waiter_id : table.defaultWaiterId;
          if (waiterId) {
            const waiter = await tx.restaurantStaff.findFirst({
              where: {
                employeeId: waiterId,
                branchId,
                role: 'waiter',
                active: true,
                employee: { status: 'active' },
              },
              select: { employeeId: true },
            });
            // A default waiter who has since left the branch is simply not assigned.
            if (!waiter) {
              if (dto.waiter_id) throw fieldError({ waiter_id: ['invalid'] });
              waiterId = null;
            }
          }
        }

        // Price every line from the menu as it is now.
        const itemIds = [...new Set(dto.items.map((l) => l.menu_item_id))];
        const menuItems = await tx.menuItem.findMany({
          where: { id: { in: itemIds }, archivedAt: null, category: { archivedAt: null } },
          include: { sizes: true, options: true },
        });
        const byId = new Map(menuItems.map((m) => [m.id, m]));
        const lines = dto.items.map((line, index) => {
          const item = byId.get(line.menu_item_id);
          if (!item) throw fieldError({ [`items.${String(index)}.menu_item_id`]: ['not_found'] });
          if (!item.available)
            throw fieldError({ [`items.${String(index)}.menu_item_id`]: ['not_active'] });
          let basePrice = money(item.price);
          let sizeName: string | null = null;
          if (item.sizes.length > 0) {
            const size = item.sizes.find((s) => s.id === line.size_id);
            if (!size) throw fieldError({ [`items.${String(index)}.size_id`]: ['required'] });
            basePrice = money(size.price);
            sizeName = size.name;
          } else if (line.size_id) {
            throw fieldError({ [`items.${String(index)}.size_id`]: ['invalid'] });
          }
          const optionIds = [...new Set(line.option_ids ?? [])];
          const options = optionIds.map((optionId) => {
            const option = item.options.find((o) => o.id === optionId);
            if (!option) throw fieldError({ [`items.${String(index)}.option_ids`]: ['invalid'] });
            return option;
          });
          const priced = priceLine({
            basePrice,
            optionPrices: options.map((o) => money(o.price)),
            quantity: line.quantity,
          });
          return {
            item,
            sizeName,
            quantity: line.quantity,
            notes: line.notes ?? null,
            options: options.map(
              (o): StoredOption => ({
                kind: o.kind,
                name: o.name,
                price: money(o.price).toString(),
              }),
            ),
            ...priced,
          };
        });

        const totals = orderTotals({
          lines: lines.map((l) => l.lineTotal),
          discount: dto.discount ? money(dto.discount) : Decimal.zero(MONEY_SCALE),
          type: dto.type,
          taxRate: money(branch.taxRate),
          serviceRate: money(branch.serviceRate),
        });
        if (totals === 'discount_too_large') throw fieldError({ discount: ['invalid'] });

        // The branch row is locked by this update until commit, so numbers never repeat.
        const counter = await tx.restaurantBranch.update({
          where: { id: branchId },
          data: { nextOrderNumber: { increment: 1 } },
          select: { nextOrderNumber: true },
        });
        const number = counter.nextOrderNumber - 1;
        const id = generateId();
        await tx.restaurantOrder.create({
          data: {
            id,
            companyId: ctx.companyId,
            branchId,
            number,
            type: dto.type,
            tableId,
            waiterId,
            customerName: dto.customer_name ?? null,
            customerPhone: dto.customer_phone ?? null,
            deliveryAddress: dto.type === 'delivery' ? (dto.delivery_address ?? null) : null,
            notes: dto.notes ?? null,
            subtotal: totals.subtotal.toString(),
            discount: totals.discount.toString(),
            tax: totals.tax.toString(),
            service: totals.service.toString(),
            total: totals.total.toString(),
            taxRate: branch.taxRate,
            serviceRate: branch.serviceRate,
            clientKey: dto.client_key,
            createdBy: ctx.userId,
          },
        });
        await tx.restaurantOrderItem.createMany({
          data: lines.map((l, index) => ({
            id: generateId(),
            companyId: ctx.companyId,
            orderId: id,
            menuItemId: l.item.id,
            name: l.item.name,
            sizeName: l.sizeName,
            unitPrice: l.unitPrice.toString(),
            quantity: l.quantity,
            lineTotal: l.lineTotal.toString(),
            options: l.options as unknown as Prisma.InputJsonValue,
            notes: l.notes,
            sortOrder: index,
          })),
        });
        await tx.restaurantOrderEvent.create({
          data: {
            id: generateId(),
            companyId: ctx.companyId,
            orderId: id,
            fromStatus: null,
            toStatus: 'new',
            actorId: ctx.userId,
          },
        });
        await this.audit.record(tx, {
          companyId: ctx.companyId,
          userId: ctx.userId,
          action: 'RESTAURANT_ORDER_CREATED',
          entityType: 'restaurant_order',
          entityId: id,
          newValues: {
            branch_id: branchId,
            number,
            type: dto.type,
            total: totals.total.toString(),
            lines: lines.length,
          },
          ipAddress: origin.ipAddress,
          userAgent: origin.userAgent,
        });
        event = this.event('created', ctx.companyId, {
          id,
          branchId,
          number,
          type: dto.type,
          status: 'new',
          waiterId,
        });
        return this.load(tx, ctx, access, id);
      });
    } catch (error) {
      // Two taps raced past the check above: the unique key kept one order; return it.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const retry = await this.tenant(ctx, async (tx) => {
          const access = await resolveAccess(tx, ctx);
          const existing = await tx.restaurantOrder.findFirst({
            where: { clientKey: dto.client_key },
            select: { id: true },
          });
          return existing ? this.load(tx, ctx, access, existing.id) : null;
        });
        if (retry) return retry;
      }
      throw error;
    }
    if (event) await this.events.publish(event);
    return result;
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  list(ctx: AuthContext, query: OrdersQueryDto): Promise<OrderPayload[]> {
    return this.tenant(ctx, async (tx) => {
      const access = await resolveAccess(tx, ctx);
      const where = await this.viewWhere(tx, ctx, access, query.view);
      const branchId = await resolveBranch(tx, access, query.branch_id);
      const history = query.view === 'history';
      const rows = await tx.restaurantOrder.findMany({
        where: { branchId, ...where },
        include: ORDER_INCLUDE,
        orderBy: history ? { createdAt: 'desc' } : { createdAt: 'asc' },
        take: query.limit ?? (history ? 100 : 200),
      });
      const prices = can(access, 'orders.prices');
      const creators = await this.creatorNames(
        tx,
        rows.map((r) => r.createdBy),
      );
      return rows.map((row) => orderPayload(row, prices, creators.get(row.createdBy) ?? ''));
    });
  }

  /** Which orders a view holds, and who may open it. */
  private async viewWhere(
    tx: TenantClient,
    ctx: AuthContext,
    access: RestaurantAccess,
    view: OrderView,
  ): Promise<Prisma.RestaurantOrderWhereInput> {
    switch (view) {
      case 'active':
        requireAction(access, 'orders.view');
        return { status: { in: [...ACTIVE_STATUSES] } };
      case 'kitchen':
        requireAction(access, 'kitchen.view');
        return { status: { in: [...ACTIVE_STATUSES] } };
      case 'waiter':
        requireAction(access, 'waiter.view');
        return { type: 'dine_in', status: { in: [...ACTIVE_STATUSES] } };
      case 'pickup':
        if (!can(access, 'pickup') && !can(access, 'deliver')) requireAction(access, 'pickup');
        return { type: { in: ['takeaway', 'delivery'] }, status: { in: [...ACTIVE_STATUSES] } };
      case 'history': {
        if (
          !can(access, 'orders.view') &&
          !can(access, 'kitchen.view') &&
          !can(access, 'waiter.view')
        ) {
          requireAction(access, 'orders.view');
        }
        const since = await this.startOfToday(tx, ctx);
        const finished: OrderStatus[] = ['served', 'picked_up', 'delivered', 'cancelled'];
        if (can(access, 'orders.view'))
          return { createdAt: { gte: since }, status: { in: finished } };
        // The kitchen's "done" list, and a waiter's served tables.
        if (can(access, 'kitchen.view'))
          return { readyAt: { gte: since }, status: { in: ['served', 'picked_up', 'delivered'] } };
        return { type: 'dine_in', fulfilledAt: { gte: since }, status: 'served' };
      }
    }
  }

  private async startOfToday(tx: TenantClient, ctx: AuthContext): Promise<Date> {
    const company = await tx.company.findUnique({
      where: { id: ctx.companyId },
      select: { timezone: true },
    });
    const zone = company?.timezone ?? 'Africa/Cairo';
    return instantAt(calendarDateIn(new Date(), zone), 0, zone);
  }

  get(ctx: AuthContext, id: string): Promise<OrderPayload> {
    return this.tenant(ctx, async (tx) => {
      const access = await resolveAccess(tx, ctx);
      return this.load(tx, ctx, access, id, true);
    });
  }

  /** One order the caller may see — in their branch, through one of their views — else 404. */
  private async load(
    tx: TenantClient,
    _ctx: AuthContext,
    access: RestaurantAccess,
    id: string,
    withHistory = false,
  ): Promise<OrderPayload> {
    if (!access.enabled) throw notFound();
    const row = await tx.restaurantOrder.findFirst({
      where: { id, ...(access.owner ? {} : { branchId: access.branchId ?? '' }) },
      include: ORDER_INCLUDE,
    });
    if (!row) throw notFound();
    const visible =
      can(access, 'orders.view') ||
      can(access, 'kitchen.view') ||
      (can(access, 'waiter.view') && row.type === 'dine_in') ||
      ((can(access, 'pickup') || can(access, 'deliver')) && row.type !== 'dine_in');
    if (!visible) throw notFound();
    const prices = can(access, 'orders.prices');
    const creators = await this.creatorNames(tx, [row.createdBy]);
    const payload = orderPayload(row, prices, creators.get(row.createdBy) ?? '');
    if (!withHistory) return payload;
    const events = await tx.restaurantOrderEvent.findMany({
      where: { orderId: id },
      orderBy: { createdAt: 'asc' },
    });
    const actors = await this.creatorNames(
      tx,
      events.map((e) => e.actorId),
    );
    return {
      ...payload,
      history: events.map((e) => ({
        from: e.fromStatus,
        to: e.toStatus,
        at: e.createdAt.toISOString(),
        by: actors.get(e.actorId) ?? '',
        note: e.note,
      })),
    };
  }

  /** Display names of the users who created or changed orders. */
  private async creatorNames(
    tx: TenantClient,
    userIds: readonly string[],
  ): Promise<Map<string, string>> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return new Map();
    const users = await tx.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, email: true, employee: { select: { firstName: true, lastName: true } } },
    });
    return new Map(
      users.map((u) => [
        u.id,
        u.employee ? `${u.employee.firstName} ${u.employee.lastName}`.trim() : u.email,
      ]),
    );
  }

  // -------------------------------------------------------------------------
  // Change
  // -------------------------------------------------------------------------

  async setStatus(
    ctx: AuthContext,
    id: string,
    to: OrderStatus,
    origin: RequestOrigin,
  ): Promise<OrderPayload> {
    let event: OrderEvent | null = null;
    const result = await this.tenant(ctx, async (tx) => {
      const access = await resolveAccess(tx, ctx);
      if (!access.enabled) throw notFound();
      const row = await this.lock(tx, access, id);
      const action = transitionAction(row.type, row.status, to);
      if (!action) throw invalidTransition();
      requireAction(access, action);
      const now = new Date();
      const data: Prisma.RestaurantOrderUpdateInput = { status: to };
      if (to === 'preparing' && !row.preparingAt) data.preparingAt = now;
      if (to === 'ready') data.readyAt = now;
      if (row.status === 'ready' && to === 'preparing') data.readyAt = null;
      if (to === 'new') data.preparingAt = null;
      if (to === 'served' || to === 'picked_up' || to === 'delivered') data.fulfilledAt = now;
      await tx.restaurantOrder.update({ where: { id }, data });
      await tx.restaurantOrderEvent.create({
        data: {
          id: generateId(),
          companyId: ctx.companyId,
          orderId: id,
          fromStatus: row.status,
          toStatus: to,
          actorId: ctx.userId,
        },
      });
      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'RESTAURANT_ORDER_STATUS_CHANGED',
        entityType: 'restaurant_order',
        entityId: id,
        oldValues: { status: row.status },
        newValues: { status: to },
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });
      event = this.event('status', ctx.companyId, { ...row, status: to });
      return this.load(tx, ctx, access, id, true);
    });
    if (event) await this.events.publish(event);
    return result;
  }

  async cancel(
    ctx: AuthContext,
    id: string,
    reason: string,
    origin: RequestOrigin,
  ): Promise<OrderPayload> {
    let event: OrderEvent | null = null;
    const result = await this.tenant(ctx, async (tx) => {
      const access = await resolveAccess(tx, ctx);
      requireAction(access, 'orders.cancel');
      const row = await this.lock(tx, access, id);
      if (!cancellable(row.status)) throw invalidTransition();
      await tx.restaurantOrder.update({
        where: { id },
        data: { status: 'cancelled', cancelledAt: new Date(), cancelReason: reason },
      });
      await tx.restaurantOrderEvent.create({
        data: {
          id: generateId(),
          companyId: ctx.companyId,
          orderId: id,
          fromStatus: row.status,
          toStatus: 'cancelled',
          actorId: ctx.userId,
          note: reason,
        },
      });
      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'RESTAURANT_ORDER_CANCELLED',
        entityType: 'restaurant_order',
        entityId: id,
        oldValues: { status: row.status },
        newValues: { status: 'cancelled' },
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });
      event = this.event('status', ctx.companyId, { ...row, status: 'cancelled' });
      return this.load(tx, ctx, access, id, true);
    });
    if (event) await this.events.publish(event);
    return result;
  }

  async setWaiter(
    ctx: AuthContext,
    id: string,
    waiterId: string | null,
    origin: RequestOrigin,
  ): Promise<OrderPayload> {
    let event: OrderEvent | null = null;
    const result = await this.tenant(ctx, async (tx) => {
      const access = await resolveAccess(tx, ctx);
      requireAction(access, 'waiter.assign');
      const row = await this.lock(tx, access, id);
      if (row.type !== 'dine_in' || !ACTIVE_STATUSES.includes(row.status))
        throw invalidTransition();
      if (waiterId) {
        const waiter = await tx.restaurantStaff.findFirst({
          where: { employeeId: waiterId, branchId: row.branchId, role: 'waiter', active: true },
          select: { employeeId: true },
        });
        if (!waiter) throw fieldError({ waiter_id: ['invalid'] });
      }
      await tx.restaurantOrder.update({ where: { id }, data: { waiterId } });
      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'RESTAURANT_ORDER_WAITER_CHANGED',
        entityType: 'restaurant_order',
        entityId: id,
        oldValues: { waiter_id: row.waiterId },
        newValues: { waiter_id: waiterId },
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });
      event = this.event('updated', ctx.companyId, { ...row, waiterId });
      return this.load(tx, ctx, access, id, true);
    });
    if (event) await this.events.publish(event);
    return result;
  }

  /** The order, locked until commit, if it is in the caller's branch — else 404. */
  private async lock(
    tx: TenantClient,
    access: RestaurantAccess,
    id: string,
  ): Promise<{
    id: string;
    branchId: string;
    number: number;
    type: OrderType;
    status: OrderStatus;
    waiterId: string | null;
    preparingAt: Date | null;
  }> {
    await tx.$executeRaw`SELECT 1 FROM restaurant_orders WHERE id = ${id}::uuid FOR UPDATE`;
    const row = await tx.restaurantOrder.findFirst({
      where: { id, ...(access.owner ? {} : { branchId: access.branchId ?? '' }) },
      select: {
        id: true,
        branchId: true,
        number: true,
        type: true,
        status: true,
        waiterId: true,
        preparingAt: true,
      },
    });
    if (!row) throw notFound();
    return row;
  }

  private event(
    kind: OrderEvent['kind'],
    companyId: string,
    row: {
      id: string;
      branchId: string;
      number: number;
      type: OrderType;
      status: OrderStatus;
      waiterId: string | null;
    },
  ): OrderEvent {
    return {
      kind,
      company_id: companyId,
      branch_id: row.branchId,
      order_id: row.id,
      number: row.number,
      type: row.type,
      status: row.status,
      waiter_id: row.waiterId,
      at: new Date().toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Live stream — which events a screen may hear
  // -------------------------------------------------------------------------

  /** The caller's access and branch for the live stream, checked once when it opens. */
  streamScope(
    ctx: AuthContext,
    branchId: string | undefined,
  ): Promise<{ branchId: string; access: RestaurantAccess }> {
    return this.tenant(ctx, async (tx) => {
      const access = await resolveAccess(tx, ctx);
      if (!access.enabled) throw notFound();
      const anyView = ['orders.view', 'kitchen.view', 'waiter.view', 'pickup'] as const;
      if (!anyView.some((action) => can(access, action))) requireAction(access, 'orders.view');
      return { branchId: await resolveBranch(tx, access, branchId), access };
    });
  }

  /** Whether this screen hears this event (it then asks the API for what it may see). */
  hears(access: RestaurantAccess, event: OrderEvent): boolean {
    if (can(access, 'orders.view') || can(access, 'kitchen.view')) return true;
    if (can(access, 'waiter.view') && event.type === 'dine_in') return true;
    if ((can(access, 'pickup') || can(access, 'deliver')) && event.type !== 'dine_in') return true;
    return false;
  }

  logStreamError(error: unknown): void {
    this.logger.warn(`Live order stream: ${(error as Error).message}`);
  }
}

/**
 * The product catalogue — DOCUMENT 17 "Data", rules 10–13, DOCUMENT 04
 * B22–B23, DOCUMENT 05 FLOW 17, DOCUMENT 08 §4.11.
 *
 *   - **No quantity is ever written here.** A product has no quantity field;
 *     its stock is read from the cache the ledger maintains. FLOW 17's
 *     optional initial stock is a `manual_addition` movement written by
 *     `StockMovementService.apply` inside the same transaction as the
 *     product, never a direct write.
 *   - **SKU is unique per company** (rule 10): a duplicate is a field error
 *     naming the existing product.
 *   - **Category and supplier belong to the same company** (DOCUMENT 17
 *     "Validation"); another company's is `not_found`, never a confirmation.
 *   - **Soft lifecycle only** (rule 12): a product is deactivated with
 *     `status: "discontinued"` (audited `product.deactivated`); its stock and
 *     history remain, and it takes no new movement until reactivated.
 *   - **Valuation** (rule 13): Σ over locations of quantity × average cost,
 *     exact, rounded once. Never the selling price.
 */

import { Inject, Injectable } from '@nestjs/common';
import { generateId } from '@ufuq/db';
import type { Prisma, PrismaClient, TenantClient } from '@ufuq/db';
import { Decimal } from '@ufuq/money';

import { AuditDispatcher } from '../auth/audit-dispatcher.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AppException } from '../common/app-exception.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import { ERROR_CODES } from '../common/errors.js';
import type { RequestOrigin } from '../common/request-context.js';
import { resolvePage } from '../company-structure/dto/pagination.dto.js';
import {
  isUniqueViolation,
  notFound,
  TenantScopedService,
} from '../company-structure/tenant-scoped.service.js';
import { MOVEMENT_INCLUDE, movementPayload } from '../warehouse/warehouse.service.js';
import type { MovementPayload } from '../warehouse/warehouse.service.js';
import { money, parseQuantity, quantity, stockValue } from '../warehouse/warehouse-rules.js';

import type {
  CreateProductDto,
  ListProductsQueryDto,
  UpdateProductDto,
} from './dto/inventory.dto.js';
import { requireCompany } from './inventory-access.js';
import { InventoryEventPublisher } from './inventory-events.js';
import type { InventoryEvent } from './inventory-events.js';
import { parseAmount, parseNonNegativeQuantity, stockStatus } from './inventory-rules.js';
import type { StockStatus } from './inventory-rules.js';
import { StockMovementService } from './stock-movements.service.js';

export interface ProductPayload {
  readonly id: string;
  readonly name_ar: string;
  readonly name_en: string;
  readonly sku: string;
  readonly unit: string;
  readonly category: {
    readonly id: string;
    readonly name_ar: string;
    readonly name_en: string;
  } | null;
  readonly supplier: { readonly id: string; readonly name: string } | null;
  readonly min_stock: string;
  readonly cost_price: string;
  readonly selling_price: string;
  readonly image_attachment_id: string | null;
  readonly description: string | null;
  readonly status: string;
  /** Σ over locations (DOCUMENT 04 B22 "total quantity across locations"). */
  readonly total_quantity: string;
  /** Σ over locations of quantity × average cost (rule 13). */
  readonly stock_value: string;
  readonly stock_status: StockStatus;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ProductStockPayload {
  readonly warehouse: {
    readonly id: string;
    readonly name_ar: string;
    readonly name_en: string;
    readonly type: string;
    readonly is_active: boolean;
  };
  readonly quantity: string;
  readonly average_cost: string;
  readonly stock_value: string;
}

export interface ProductDetailPayload extends ProductPayload {
  readonly stock: readonly ProductStockPayload[];
}

export interface AlertPayload {
  readonly product: ProductPayload;
  readonly alert: 'low_stock' | 'out_of_stock';
}

const PRODUCT_INCLUDE = {
  category: { select: { id: true, nameAr: true, nameEn: true } },
  supplier: { select: { id: true, name: true } },
} as const;

type ProductRow = Prisma.ProductGetPayload<{ include: typeof PRODUCT_INCLUDE }>;

interface Holding {
  readonly total: Decimal;
  readonly value: Decimal;
}

function fieldError(fields: Record<string, string[]>): AppException {
  return new AppException(ERROR_CODES.VALIDATION_FAILED, 422, { fields });
}

@Injectable()
export class ProductsService extends TenantScopedService {
  constructor(
    @Inject(PRISMA_CLIENT) prisma: PrismaClient,
    @Inject(AuditDispatcher) private readonly audit: AuditDispatcher,
    @Inject(StockMovementService) private readonly movements: StockMovementService,
    @Inject(InventoryEventPublisher) private readonly events: InventoryEventPublisher,
  ) {
    super(prisma, audit);
  }

  // -- Reading -------------------------------------------------------------------

  private async holdings(
    tx: TenantClient,
    productIds: readonly string[],
  ): Promise<Map<string, Holding>> {
    const rows = await tx.productStock.findMany({
      where: { productId: { in: [...productIds] }, quantity: { not: 0 } },
      select: { productId: true, quantity: true, averageCost: true },
    });
    const out = new Map<string, Holding>();
    for (const id of productIds) {
      const own = rows
        .filter((row) => row.productId === id)
        .map((row) => ({ quantity: quantity(row.quantity), averageCost: money(row.averageCost) }));
      out.set(id, {
        total: Decimal.sum(
          own.map((row) => row.quantity),
          3,
        ),
        value: stockValue(own),
      });
    }
    return out;
  }

  private payload(row: ProductRow, holding: Holding): ProductPayload {
    const min = quantity(row.minStock);
    return {
      id: row.id,
      name_ar: row.nameAr,
      name_en: row.nameEn,
      sku: row.sku,
      unit: row.unit,
      category:
        row.category === null
          ? null
          : { id: row.category.id, name_ar: row.category.nameAr, name_en: row.category.nameEn },
      supplier: row.supplier === null ? null : { id: row.supplier.id, name: row.supplier.name },
      min_stock: min.toString(),
      cost_price: money(row.costPrice).toString(),
      selling_price: money(row.sellingPrice).toString(),
      image_attachment_id: row.imagePath,
      description: row.description,
      status: row.status,
      total_quantity: holding.total.toString(),
      stock_value: holding.value.toString(),
      stock_status: stockStatus(holding.total, min),
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    };
  }

  /**
   * GET /products — DOCUMENT 04 B22. Filters category, supplier, location
   * (holding stock there), product status and stock status; search on name
   * and SKU; sort on name, SKU, creation or total quantity.
   *
   * Stock status and total quantity are derived from the cache, so they are
   * filtered and sorted after the totals are known; pagination is applied
   * last, to the filtered list.
   */
  async list(
    ctx: AuthContext,
    query: ListProductsQueryDto,
  ): Promise<{ readonly items: readonly ProductPayload[]; readonly total: number }> {
    requireCompany(ctx, 'product.view');
    const page = resolvePage(query);
    const search = query.search?.trim();
    const where: Prisma.ProductWhereInput = {
      deletedAt: null,
      ...(query.category_id === undefined ? {} : { categoryId: query.category_id }),
      ...(query.supplier_id === undefined ? {} : { supplierId: query.supplier_id }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.warehouse_id === undefined
        ? {}
        : { stock: { some: { warehouseId: query.warehouse_id, quantity: { not: 0 } } } }),
      ...(search === undefined || search === ''
        ? {}
        : {
            OR: [
              { nameAr: { contains: search, mode: 'insensitive' } },
              { nameEn: { contains: search, mode: 'insensitive' } },
              { sku: { contains: search, mode: 'insensitive' } },
            ],
          }),
    };
    return this.tenant(ctx, async (tx) => {
      const rows = await tx.product.findMany({ where, include: PRODUCT_INCLUDE });
      const holdings = await this.holdings(
        tx,
        rows.map((row) => row.id),
      );
      let items = rows.map((row) => this.payload(row, holdings.get(row.id) as Holding));
      if (query.stock_status !== undefined) {
        items = items.filter((item) => item.stock_status === query.stock_status);
      }
      const direction = query.order === 'desc' ? -1 : 1;
      const sort = query.sort ?? 'name';
      const byName = (a: ProductPayload, b: ProductPayload): number =>
        a.name_en.localeCompare(b.name_en) || a.sku.localeCompare(b.sku);
      items.sort((a, b) => {
        const primary =
          sort === 'sku'
            ? a.sku.localeCompare(b.sku)
            : sort === 'created_at'
              ? a.created_at.localeCompare(b.created_at)
              : sort === 'total_quantity'
                ? quantity(a.total_quantity).compare(quantity(b.total_quantity))
                : byName(a, b);
        return direction * (primary || a.id.localeCompare(b.id));
      });
      return { items: items.slice(page.skip, page.skip + page.take), total: items.length };
    });
  }

  private async detail(tx: TenantClient, id: string): Promise<ProductDetailPayload | null> {
    const row = await tx.product.findFirst({
      where: { id, deletedAt: null },
      include: PRODUCT_INCLUDE,
    });
    if (row === null) return null;
    const stock = await tx.productStock.findMany({
      where: { productId: id, quantity: { not: 0 } },
      include: {
        warehouse: { select: { id: true, nameAr: true, nameEn: true, type: true, isActive: true } },
      },
      orderBy: [{ warehouse: { createdAt: 'asc' } }, { id: 'asc' }],
    });
    const holding = (await this.holdings(tx, [id])).get(id) as Holding;
    return {
      ...this.payload(row, holding),
      stock: stock.map((s) => {
        const qty = quantity(s.quantity);
        const avg = money(s.averageCost);
        return {
          warehouse: {
            id: s.warehouse.id,
            name_ar: s.warehouse.nameAr,
            name_en: s.warehouse.nameEn,
            type: s.warehouse.type,
            is_active: s.warehouse.isActive,
          },
          quantity: qty.toString(),
          average_cost: avg.toString(),
          stock_value: stockValue([{ quantity: qty, averageCost: avg }]).toString(),
        };
      }),
    };
  }

  async get(ctx: AuthContext, id: string): Promise<ProductDetailPayload> {
    requireCompany(ctx, 'product.view');
    return this.tenant(ctx, async (tx) => {
      const found = await this.detail(tx, id);
      if (found === null) throw notFound();
      return found;
    });
  }

  /** GET /products/{id}/stock — the per-location breakdown (DOCUMENT 08 §4.11). Read-only. */
  async stock(ctx: AuthContext, id: string): Promise<readonly ProductStockPayload[]> {
    requireCompany(ctx, 'stock.view');
    return this.tenant(ctx, async (tx) => {
      const found = await this.detail(tx, id);
      if (found === null) throw notFound();
      return found.stock;
    });
  }

  /** GET /products/{id}/movements — this product's ledger, newest first. Read-only. */
  async movementHistory(
    ctx: AuthContext,
    id: string,
    query: { page?: number; per_page?: number; warehouse_id?: string },
  ): Promise<{ readonly items: readonly MovementPayload[]; readonly total: number }> {
    requireCompany(ctx, 'stock.view');
    const page = resolvePage(query);
    return this.tenant(ctx, async (tx) => {
      const product = await tx.product.findFirst({
        where: { id, deletedAt: null },
        select: { id: true },
      });
      if (product === null) throw notFound();
      const where: Prisma.StockMovementWhereInput = {
        productId: id,
        ...(query.warehouse_id === undefined ? {} : { warehouseId: query.warehouse_id }),
      };
      const [rows, total] = await Promise.all([
        tx.stockMovement.findMany({
          where,
          include: MOVEMENT_INCLUDE,
          orderBy: [{ sequence: 'desc' }],
          skip: page.skip,
          take: page.take,
        }),
        tx.stockMovement.count({ where }),
      ]);
      return { items: rows.map(movementPayload), total };
    });
  }

  /** GET /inventory/alerts — DOCUMENT 08 §4.11 "low and out of stock", lowest total first. */
  async alerts(
    ctx: AuthContext,
    query: { page?: number; per_page?: number; type?: 'low_stock' | 'out_of_stock' },
  ): Promise<{ readonly items: readonly AlertPayload[]; readonly total: number }> {
    requireCompany(ctx, 'stock.view');
    const page = resolvePage(query);
    return this.tenant(ctx, async (tx) => {
      const rows = await tx.product.findMany({
        where: { deletedAt: null, status: 'active' },
        include: PRODUCT_INCLUDE,
      });
      const holdings = await this.holdings(
        tx,
        rows.map((row) => row.id),
      );
      const items = rows
        .map((row) => this.payload(row, holdings.get(row.id) as Holding))
        .filter((p) => p.stock_status !== 'in_stock')
        .filter((p) => query.type === undefined || p.stock_status === query.type)
        .sort(
          (a, b) =>
            quantity(a.total_quantity).compare(quantity(b.total_quantity)) ||
            a.sku.localeCompare(b.sku),
        )
        .map((product) => ({ product, alert: product.stock_status as AlertPayload['alert'] }));
      return { items: items.slice(page.skip, page.skip + page.take), total: items.length };
    });
  }

  // -- Writing ---------------------------------------------------------------------

  /** Decimal fields and references, checked exactly; every problem named by its field. */
  private async checkFields(
    tx: TenantClient,
    dto: CreateProductDto | UpdateProductDto,
    productId: string | null,
  ): Promise<{
    readonly minStock?: Decimal;
    readonly costPrice?: Decimal;
    readonly sellingPrice?: Decimal;
  }> {
    const fields: Record<string, string[]> = {};
    const out: { minStock?: Decimal; costPrice?: Decimal; sellingPrice?: Decimal } = {};
    if (dto.min_stock !== undefined) {
      const parsed = parseNonNegativeQuantity(dto.min_stock);
      if (parsed === null) fields.min_stock = ['invalid'];
      else out.minStock = parsed;
    }
    for (const [key, target] of [
      ['cost_price', 'costPrice'],
      ['selling_price', 'sellingPrice'],
    ] as const) {
      const value = dto[key];
      if (value === undefined) continue;
      const parsed = parseAmount(value);
      if (parsed === null) fields[key] = ['invalid'];
      else out[target] = parsed;
    }
    if (dto.category_id !== undefined && dto.category_id !== null) {
      const category = await tx.productCategory.findFirst({
        where: { id: dto.category_id, deletedAt: null },
        select: { id: true },
      });
      if (category === null) fields.category_id = ['not_found'];
    }
    if (dto.supplier_id !== undefined && dto.supplier_id !== null) {
      const supplier = await tx.supplier.findFirst({
        where: { id: dto.supplier_id, deletedAt: null },
        select: { status: true },
      });
      if (supplier === null) fields.supplier_id = ['not_found'];
      else if (supplier.status !== 'active') fields.supplier_id = ['not_active'];
    }
    if (
      'image_attachment_id' in dto &&
      dto.image_attachment_id !== undefined &&
      dto.image_attachment_id !== null
    ) {
      const attachment = await tx.attachment.findFirst({
        where: {
          id: dto.image_attachment_id,
          relatedType: 'product',
          relatedId: productId ?? '',
          deletedAt: null,
        },
        select: { mimeType: true },
      });
      if (attachment === null) fields.image_attachment_id = ['not_found'];
      else if (!attachment.mimeType.startsWith('image/'))
        fields.image_attachment_id = ['unsupported_type'];
    }
    if (Object.keys(fields).length > 0) throw fieldError(fields);
    return out;
  }

  /** Rule 10's field error, naming the product that already has the SKU. */
  private async duplicateSku(tx: TenantClient, sku: string, except: string | null): Promise<void> {
    const existing = await tx.product.findFirst({
      where: { sku, ...(except === null ? {} : { id: { not: except } }) },
      select: { id: true, nameAr: true, nameEn: true },
    });
    if (existing !== null) {
      throw fieldError({
        sku: ['already_taken'],
        existing_product_id: [existing.id],
        existing_product_name_ar: [existing.nameAr],
        existing_product_name_en: [existing.nameEn],
      });
    }
  }

  /** POST /products — FLOW 17, one transaction with the optional initial stock. */
  async create(
    ctx: AuthContext,
    dto: CreateProductDto,
    origin: RequestOrigin,
    now: Date = new Date(),
  ): Promise<ProductDetailPayload> {
    requireCompany(ctx, 'product.create');
    let initial = null;
    if (dto.initial_stock !== undefined) {
      requireCompany(ctx, 'stock.movement_create');
      const qty = parseQuantity(dto.initial_stock.quantity);
      const cost =
        dto.initial_stock.unit_cost === undefined ? null : parseAmount(dto.initial_stock.unit_cost);
      const fields: Record<string, string[]> = {};
      if (qty === null) fields['initial_stock.quantity'] = ['invalid'];
      if (dto.initial_stock.unit_cost !== undefined && cost === null) {
        fields['initial_stock.unit_cost'] = ['invalid'];
      }
      if (Object.keys(fields).length > 0) throw fieldError(fields);
      initial = {
        warehouseId: dto.initial_stock.warehouse_id,
        quantity: qty as Decimal,
        unitCost: cost,
      };
    }
    const id = generateId();
    let events: InventoryEvent[] = [];
    try {
      await this.tenant(ctx, async (tx) => {
        const checked = await this.checkFields(tx, dto, null);
        await this.duplicateSku(tx, dto.sku, null);
        await tx.product.create({
          data: {
            id,
            companyId: ctx.companyId,
            nameAr: dto.name_ar,
            nameEn: dto.name_en,
            sku: dto.sku,
            unit: dto.unit,
            categoryId: dto.category_id ?? null,
            supplierId: dto.supplier_id ?? null,
            minStock: (checked.minStock ?? Decimal.zero(3)).toString(),
            costPrice: (checked.costPrice ?? Decimal.zero(2)).toString(),
            sellingPrice: (checked.sellingPrice ?? Decimal.zero(2)).toString(),
            description: dto.description ?? null,
          },
        });
        await this.audit.record(tx, {
          companyId: ctx.companyId,
          userId: ctx.userId,
          action: 'PRODUCT_CREATED',
          entityType: 'product',
          entityId: id,
          newValues: {
            name_ar: dto.name_ar,
            name_en: dto.name_en,
            sku: dto.sku,
            unit: dto.unit,
            category_id: dto.category_id ?? null,
            supplier_id: dto.supplier_id ?? null,
            min_stock: (checked.minStock ?? Decimal.zero(3)).toString(),
            cost_price: (checked.costPrice ?? Decimal.zero(2)).toString(),
            selling_price: (checked.sellingPrice ?? Decimal.zero(2)).toString(),
            description: dto.description ?? null,
            status: 'active',
          },
          ipAddress: origin.ipAddress,
          userAgent: origin.userAgent,
        });
        if (initial !== null) {
          // FLOW 17: "create stock movement type = Manual Addition (never a
          // direct quantity write)" — same transaction as the product.
          const applied = await this.movements.apply(
            tx,
            ctx,
            {
              productId: id,
              warehouseId: initial.warehouseId,
              movement: {
                type: 'manual_addition',
                quantity: initial.quantity,
                unitCost: initial.unitCost,
                reason: null,
              },
              acknowledgeNegative: false,
              fields: { product: 'product_id', warehouse: 'initial_stock.warehouse_id' },
            },
            origin,
            now,
          );
          events = applied.events;
        }
      });
    } catch (error) {
      // A concurrent create with the same SKU loses at the unique index.
      if (isUniqueViolation(error)) {
        await this.tenant(ctx, (tx) => this.duplicateSku(tx, dto.sku, null));
      }
      throw error;
    }
    await this.events.publish(events);
    return this.get(ctx, id);
  }

  /** PATCH /products/{id}. Every documented field except a quantity, which does not exist. */
  async update(
    ctx: AuthContext,
    id: string,
    dto: UpdateProductDto,
    origin: RequestOrigin,
  ): Promise<ProductDetailPayload> {
    requireCompany(ctx, 'product.update');
    try {
      await this.tenant(ctx, async (tx) => {
        // Serializes with movements, which read min_stock under this lock.
        await tx.$queryRaw`SELECT id FROM products WHERE id = ${id}::uuid AND deleted_at IS NULL FOR UPDATE`;
        const before = await tx.product.findFirst({ where: { id, deletedAt: null } });
        if (before === null) throw notFound();
        const checked = await this.checkFields(tx, dto, id);
        if (dto.sku !== undefined && dto.sku !== before.sku)
          await this.duplicateSku(tx, dto.sku, id);
        const previous = {
          name_ar: before.nameAr,
          name_en: before.nameEn,
          sku: before.sku,
          unit: before.unit,
          category_id: before.categoryId,
          supplier_id: before.supplierId,
          min_stock: quantity(before.minStock).toString(),
          cost_price: money(before.costPrice).toString(),
          selling_price: money(before.sellingPrice).toString(),
          image_attachment_id: before.imagePath,
          description: before.description,
          status: before.status as string,
        };
        const next = {
          name_ar: dto.name_ar ?? previous.name_ar,
          name_en: dto.name_en ?? previous.name_en,
          sku: dto.sku ?? previous.sku,
          unit: dto.unit ?? previous.unit,
          category_id: dto.category_id === undefined ? previous.category_id : dto.category_id,
          supplier_id: dto.supplier_id === undefined ? previous.supplier_id : dto.supplier_id,
          min_stock: checked.minStock?.toString() ?? previous.min_stock,
          cost_price: checked.costPrice?.toString() ?? previous.cost_price,
          selling_price: checked.sellingPrice?.toString() ?? previous.selling_price,
          image_attachment_id:
            dto.image_attachment_id === undefined
              ? previous.image_attachment_id
              : dto.image_attachment_id,
          description: dto.description === undefined ? previous.description : dto.description,
          status: dto.status ?? previous.status,
        };
        const changed = (Object.keys(next) as (keyof typeof next)[]).filter(
          (key) => next[key] !== previous[key],
        );
        if (changed.length === 0) return;
        await tx.product.update({
          where: { id },
          data: {
            nameAr: next.name_ar,
            nameEn: next.name_en,
            sku: next.sku,
            unit: next.unit,
            categoryId: next.category_id,
            supplierId: next.supplier_id,
            minStock: next.min_stock,
            costPrice: next.cost_price,
            sellingPrice: next.selling_price,
            imagePath: next.image_attachment_id,
            description: next.description,
            status: next.status as 'active' | 'discontinued',
          },
        });
        const deactivating = previous.status === 'active' && next.status === 'discontinued';
        await this.audit.record(tx, {
          companyId: ctx.companyId,
          userId: ctx.userId,
          action: deactivating ? 'PRODUCT_DEACTIVATED' : 'PRODUCT_UPDATED',
          entityType: 'product',
          entityId: id,
          oldValues: Object.fromEntries(changed.map((key) => [key, previous[key]])),
          newValues: Object.fromEntries(changed.map((key) => [key, next[key]])),
          ipAddress: origin.ipAddress,
          userAgent: origin.userAgent,
        });
      });
    } catch (error) {
      if (isUniqueViolation(error) && dto.sku !== undefined) {
        await this.tenant(ctx, (tx) => this.duplicateSku(tx, dto.sku as string, id));
      }
      throw error;
    }
    return this.get(ctx, id);
  }
}

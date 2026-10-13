/**
 * Product categories and suppliers — DOCUMENT 06 §3.30, §3.33, DOCUMENT 08
 * §4.11, DOCUMENT 04 `/admin/inventory/suppliers`.
 *
 *   - Categories: `GET` / `POST`, with DOCUMENT 06's optional `parent_id`
 *     (a parent in the same company; created before its child, so a cycle
 *     cannot form). Audited `product_category.created` — the approved
 *     DOCUMENT 21 amendment.
 *   - Suppliers: `GET` / `POST`, plus `GET` / `PATCH /suppliers/{id}`: the
 *     edit DOCUMENT 21's `supplier.updated` presupposes. Deactivation is
 *     `status: "inactive"`; a supplier is never deleted (products keep it).
 *   - Same-company only: another company's category or supplier is 404 /
 *     `not_found`, never a confirmation.
 */

import { Inject, Injectable } from '@nestjs/common';
import { generateId } from '@ufuq/db';
import type { Prisma, PrismaClient } from '@ufuq/db';

import { AuditDispatcher } from '../auth/audit-dispatcher.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AppException } from '../common/app-exception.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import { ERROR_CODES } from '../common/errors.js';
import type { RequestOrigin } from '../common/request-context.js';
import { resolvePage } from '../company-structure/dto/pagination.dto.js';
import { notFound, TenantScopedService } from '../company-structure/tenant-scoped.service.js';

import type {
  CreateCategoryDto,
  CreateSupplierDto,
  ListSuppliersQueryDto,
  UpdateSupplierDto,
} from './dto/inventory.dto.js';
import { requireCompany } from './inventory-access.js';

export interface CategoryPayload {
  readonly id: string;
  readonly name_ar: string;
  readonly name_en: string;
  readonly parent_id: string | null;
  readonly product_count: number;
  readonly created_at: string;
}

export interface SupplierPayload {
  readonly id: string;
  readonly name: string;
  readonly contact_person: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly address: string | null;
  readonly status: string;
  readonly product_count: number;
  readonly created_at: string;
}

type SupplierRow = Prisma.SupplierGetPayload<{
  include: { _count: { select: { products: true } } };
}>;

function supplierPayload(row: SupplierRow): SupplierPayload {
  return {
    id: row.id,
    name: row.name,
    contact_person: row.contactPerson,
    phone: row.phone,
    email: row.email,
    address: row.address,
    status: row.status,
    product_count: row._count.products,
    created_at: row.createdAt.toISOString(),
  };
}

const SUPPLIER_INCLUDE = {
  _count: { select: { products: { where: { deletedAt: null } } } },
} as const;

@Injectable()
export class CatalogueService extends TenantScopedService {
  constructor(
    @Inject(PRISMA_CLIENT) prisma: PrismaClient,
    @Inject(AuditDispatcher) private readonly audit: AuditDispatcher,
  ) {
    super(prisma, audit);
  }

  // -- Categories ---------------------------------------------------------------

  /** GET /product-categories — every category, by English name (small reference list). */
  async listCategories(
    ctx: AuthContext,
    query: { page?: number; per_page?: number },
  ): Promise<{ readonly items: readonly CategoryPayload[]; readonly total: number }> {
    requireCompany(ctx, 'product.view');
    const page = resolvePage(query);
    return this.tenant(ctx, async (tx) => {
      const where = { deletedAt: null };
      const [rows, total] = await Promise.all([
        tx.productCategory.findMany({
          where,
          include: { _count: { select: { products: { where: { deletedAt: null } } } } },
          orderBy: [{ nameEn: 'asc' }, { id: 'asc' }],
          skip: page.skip,
          take: page.take,
        }),
        tx.productCategory.count({ where }),
      ]);
      return {
        items: rows.map((row) => ({
          id: row.id,
          name_ar: row.nameAr,
          name_en: row.nameEn,
          parent_id: row.parentId,
          product_count: row._count.products,
          created_at: row.createdAt.toISOString(),
        })),
        total,
      };
    });
  }

  async createCategory(
    ctx: AuthContext,
    dto: CreateCategoryDto,
    origin: RequestOrigin,
  ): Promise<CategoryPayload> {
    requireCompany(ctx, 'product.create');
    const id = generateId();
    return this.tenant(ctx, async (tx) => {
      if (dto.parent_id !== undefined && dto.parent_id !== null) {
        const parent = await tx.productCategory.findFirst({
          where: { id: dto.parent_id, deletedAt: null },
          select: { id: true },
        });
        if (parent === null) {
          throw new AppException(ERROR_CODES.VALIDATION_FAILED, 422, {
            fields: { parent_id: ['not_found'] },
          });
        }
      }
      const row = await tx.productCategory.create({
        data: {
          id,
          companyId: ctx.companyId,
          nameAr: dto.name_ar,
          nameEn: dto.name_en,
          parentId: dto.parent_id ?? null,
        },
      });
      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'PRODUCT_CATEGORY_CREATED',
        entityType: 'product_category',
        entityId: id,
        newValues: { name_ar: dto.name_ar, name_en: dto.name_en, parent_id: dto.parent_id ?? null },
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });
      return {
        id: row.id,
        name_ar: row.nameAr,
        name_en: row.nameEn,
        parent_id: row.parentId,
        product_count: 0,
        created_at: row.createdAt.toISOString(),
      };
    });
  }

  // -- Suppliers ----------------------------------------------------------------

  async listSuppliers(
    ctx: AuthContext,
    query: ListSuppliersQueryDto,
  ): Promise<{ readonly items: readonly SupplierPayload[]; readonly total: number }> {
    requireCompany(ctx, 'product.view');
    const page = resolvePage(query);
    const search = query.search?.trim();
    const where: Prisma.SupplierWhereInput = {
      deletedAt: null,
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(search === undefined || search === ''
        ? {}
        : {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { contactPerson: { contains: search, mode: 'insensitive' } },
              { email: { contains: search, mode: 'insensitive' } },
            ],
          }),
    };
    return this.tenant(ctx, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.supplier.findMany({
          where,
          include: SUPPLIER_INCLUDE,
          orderBy: [{ status: 'asc' }, { name: 'asc' }, { id: 'asc' }],
          skip: page.skip,
          take: page.take,
        }),
        tx.supplier.count({ where }),
      ]);
      return { items: rows.map(supplierPayload), total };
    });
  }

  async getSupplier(ctx: AuthContext, id: string): Promise<SupplierPayload> {
    requireCompany(ctx, 'product.view');
    return this.tenant(ctx, async (tx) => {
      const row = await tx.supplier.findFirst({
        where: { id, deletedAt: null },
        include: SUPPLIER_INCLUDE,
      });
      if (row === null) throw notFound();
      return supplierPayload(row);
    });
  }

  async createSupplier(
    ctx: AuthContext,
    dto: CreateSupplierDto,
    origin: RequestOrigin,
  ): Promise<SupplierPayload> {
    requireCompany(ctx, 'product.create');
    const id = generateId();
    const values = {
      name: dto.name,
      contact_person: dto.contact_person ?? null,
      phone: dto.phone ?? null,
      email: dto.email ?? null,
      address: dto.address ?? null,
    };
    await this.tenant(ctx, async (tx) => {
      await tx.supplier.create({
        data: {
          id,
          companyId: ctx.companyId,
          name: values.name,
          contactPerson: values.contact_person,
          phone: values.phone,
          email: values.email,
          address: values.address,
        },
      });
      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'SUPPLIER_CREATED',
        entityType: 'supplier',
        entityId: id,
        newValues: { ...values, status: 'active' },
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });
    });
    return this.getSupplier(ctx, id);
  }

  async updateSupplier(
    ctx: AuthContext,
    id: string,
    dto: UpdateSupplierDto,
    origin: RequestOrigin,
  ): Promise<SupplierPayload> {
    requireCompany(ctx, 'product.update');
    await this.tenant(ctx, async (tx) => {
      const before = await tx.supplier.findFirst({ where: { id, deletedAt: null } });
      if (before === null) throw notFound();
      const previous = {
        name: before.name,
        contact_person: before.contactPerson,
        phone: before.phone,
        email: before.email,
        address: before.address,
        status: before.status as string,
      };
      const next = {
        name: dto.name ?? previous.name,
        contact_person:
          dto.contact_person === undefined ? previous.contact_person : dto.contact_person,
        phone: dto.phone === undefined ? previous.phone : dto.phone,
        email: dto.email === undefined ? previous.email : dto.email,
        address: dto.address === undefined ? previous.address : dto.address,
        status: dto.status ?? previous.status,
      };
      const changed = (Object.keys(next) as (keyof typeof next)[]).filter(
        (key) => next[key] !== previous[key],
      );
      if (changed.length === 0) return;
      await tx.supplier.update({
        where: { id },
        data: {
          name: next.name,
          contactPerson: next.contact_person,
          phone: next.phone,
          email: next.email,
          address: next.address,
          status: next.status as 'active' | 'inactive',
        },
      });
      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'SUPPLIER_UPDATED',
        entityType: 'supplier',
        entityId: id,
        oldValues: Object.fromEntries(changed.map((key) => [key, previous[key]])),
        newValues: Object.fromEntries(changed.map((key) => [key, next[key]])),
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });
    });
    return this.getSupplier(ctx, id);
  }
}

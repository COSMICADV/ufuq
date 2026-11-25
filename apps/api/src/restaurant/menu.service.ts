/**
 * 1to1OS Business — Restaurants & Cafés: the visual menu — categories, items
 * with their photo, sizes, extras, customizations, ingredients and recipe.
 *
 * Only the owner changes the menu. The cashier reads it (the POS), without
 * the recipe; kitchen staff do not read the menu at all in this phase.
 *
 * Photos are checked by their bytes (PNG or JPEG, never SVG), stored under
 * the company's own prefix in the private bucket, and streamed back with
 * nosniff. A replaced photo is deleted.
 */

import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { generateId } from '@ufuq/db';
import type { Prisma, PrismaClient, TenantClient } from '@ufuq/db';
import type { Readable } from 'node:stream';

import { OBJECT_STORAGE } from '../attachments/object-storage.js';
import type { ObjectStorage } from '../attachments/object-storage.js';
import { AuditDispatcher } from '../auth/audit-dispatcher.js';
import type { AuthContext } from '../auth/auth-context.js';
import { inspectLogo } from '../business-identity/identity-rules.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import type { RequestOrigin } from '../common/request-context.js';
import {
  fieldError,
  notFound,
  TenantScopedService,
} from '../company-structure/tenant-scoped.service.js';

import { can, requireAction, requireOwner, resolveAccess } from './restaurant-access.js';
import type {
  CategoryDto,
  CreateItemDto,
  OptionDto,
  SizeDto,
  UpdateCategoryDto,
  UpdateItemDto,
} from './restaurant.dto.js';
import { money } from './restaurant-rules.js';

export const MAX_MENU_IMAGE_BYTES = 2 * 1024 * 1024;

export interface UploadedPart {
  readonly buffer: Buffer;
  readonly size: number;
}

export interface MenuCategoryPayload {
  readonly id: string;
  readonly name: string;
  readonly sort_order: number;
  readonly archived: boolean;
  readonly item_count: number;
}

export interface MenuItemPayload {
  readonly id: string;
  readonly category_id: string;
  readonly name: string;
  readonly description: string | null;
  readonly price: string;
  readonly available: boolean;
  readonly sort_order: number;
  readonly archived: boolean;
  /** Null without a photo; the version changes whenever the photo does. */
  readonly image_version: number | null;
  readonly sizes: readonly { readonly id: string; readonly name: string; readonly price: string }[];
  readonly options: readonly {
    readonly id: string;
    readonly kind: 'extra' | 'customization';
    readonly name: string;
    readonly price: string;
  }[];
  /** Owner only — absent for the cashier. */
  readonly ingredients?: string | null;
  readonly recipe?: string | null;
  readonly prep_instructions?: string | null;
}

export interface MenuPayload {
  readonly categories: readonly MenuCategoryPayload[];
  readonly items: readonly MenuItemPayload[];
  readonly can_manage: boolean;
}

export interface ImageStream {
  readonly stream: Readable;
  readonly contentType: string;
}

const ITEM_INCLUDE = {
  sizes: { orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] },
  options: { orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }] },
} as const satisfies Prisma.MenuItemInclude;

type ItemRow = Prisma.MenuItemGetPayload<{ include: typeof ITEM_INCLUDE }>;

function itemPayload(row: ItemRow, owner: boolean): MenuItemPayload {
  return {
    id: row.id,
    category_id: row.categoryId,
    name: row.name,
    description: row.description,
    price: money(row.price).toString(),
    available: row.available,
    sort_order: row.sortOrder,
    archived: row.archivedAt !== null,
    image_version: row.imageKey ? row.imageVersion : null,
    sizes: row.sizes.map((s) => ({ id: s.id, name: s.name, price: money(s.price).toString() })),
    options: row.options.map((o) => ({
      id: o.id,
      kind: o.kind,
      name: o.name,
      price: money(o.price).toString(),
    })),
    ...(owner
      ? {
          ingredients: row.ingredients,
          recipe: row.recipe,
          prep_instructions: row.prepInstructions,
        }
      : {}),
  };
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('base64');
}

@Injectable()
export class RestaurantMenuService extends TenantScopedService {
  constructor(
    @Inject(PRISMA_CLIENT) prisma: PrismaClient,
    @Inject(AuditDispatcher) private readonly audit: AuditDispatcher,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {
    super(prisma, audit);
  }

  menu(ctx: AuthContext, includeArchived: boolean): Promise<MenuPayload> {
    return this.tenant(ctx, async (tx) => {
      const access = await resolveAccess(tx, ctx);
      requireAction(access, 'menu.view');
      return this.load(tx, access.owner, includeArchived && access.owner);
    });
  }

  private async load(
    tx: TenantClient,
    owner: boolean,
    includeArchived: boolean,
  ): Promise<MenuPayload> {
    const categories = await tx.menuCategory.findMany({
      where: includeArchived ? {} : { archivedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { items: { where: { archivedAt: null } } } } },
    });
    const items = await tx.menuItem.findMany({
      where: includeArchived ? {} : { archivedAt: null, category: { archivedAt: null } },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: ITEM_INCLUDE,
    });
    return {
      categories: categories.map((c) => ({
        id: c.id,
        name: c.name,
        sort_order: c.sortOrder,
        archived: c.archivedAt !== null,
        item_count: c._count.items,
      })),
      items: items.map((row) => itemPayload(row, owner)),
      can_manage: owner,
    };
  }

  // -------------------------------------------------------------------------
  // Categories
  // -------------------------------------------------------------------------

  createCategory(ctx: AuthContext, dto: CategoryDto, origin: RequestOrigin): Promise<MenuPayload> {
    return this.tenant(ctx, async (tx) => {
      requireOwner(await resolveAccess(tx, ctx));
      await this.uniqueCategory(tx, dto.name, null);
      const id = generateId();
      const last = await tx.menuCategory.aggregate({ _max: { sortOrder: true } });
      await tx.menuCategory.create({
        data: {
          id,
          companyId: ctx.companyId,
          name: dto.name,
          sortOrder: dto.sort_order ?? (last._max.sortOrder ?? 0) + 1,
        },
      });
      await this.auditCategory(tx, ctx, id, { created: dto.name }, origin);
      return this.load(tx, true, true);
    });
  }

  updateCategory(
    ctx: AuthContext,
    id: string,
    dto: UpdateCategoryDto,
    origin: RequestOrigin,
  ): Promise<MenuPayload> {
    return this.tenant(ctx, async (tx) => {
      requireOwner(await resolveAccess(tx, ctx));
      const before = await tx.menuCategory.findFirst({ where: { id } });
      if (!before) throw notFound();
      if (dto.name !== undefined) await this.uniqueCategory(tx, dto.name, id);
      await tx.menuCategory.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.sort_order !== undefined ? { sortOrder: dto.sort_order } : {}),
          ...(dto.archived !== undefined
            ? { archivedAt: dto.archived ? (before.archivedAt ?? new Date()) : null }
            : {}),
        },
      });
      await this.auditCategory(tx, ctx, id, { fields: Object.keys(dto).sort() }, origin);
      return this.load(tx, true, true);
    });
  }

  private async uniqueCategory(
    tx: TenantClient,
    value: string,
    exceptId: string | null,
  ): Promise<void> {
    const clash = await tx.menuCategory.findFirst({
      where: {
        name: { equals: value, mode: 'insensitive' },
        ...(exceptId ? { NOT: { id: exceptId } } : {}),
      },
      select: { id: true },
    });
    if (clash) throw fieldError({ name: ['already_taken'] });
  }

  private async auditCategory(
    tx: TenantClient,
    ctx: AuthContext,
    id: string,
    values: Prisma.InputJsonObject,
    origin: RequestOrigin,
  ): Promise<void> {
    await this.audit.record(tx, {
      companyId: ctx.companyId,
      userId: ctx.userId,
      action: 'MENU_CATEGORY_CHANGED',
      entityType: 'menu_category',
      entityId: id,
      newValues: values,
      ipAddress: origin.ipAddress,
      userAgent: origin.userAgent,
    });
  }

  // -------------------------------------------------------------------------
  // Items
  // -------------------------------------------------------------------------

  createItem(
    ctx: AuthContext,
    dto: CreateItemDto,
    origin: RequestOrigin,
  ): Promise<MenuItemPayload> {
    return this.tenant(ctx, async (tx) => {
      requireOwner(await resolveAccess(tx, ctx));
      await this.category(tx, dto.category_id);
      const id = generateId();
      await tx.menuItem.create({
        data: {
          id,
          companyId: ctx.companyId,
          categoryId: dto.category_id,
          name: dto.name,
          description: dto.description ?? null,
          price: dto.price,
          ingredients: dto.ingredients ?? null,
          recipe: dto.recipe ?? null,
          prepInstructions: dto.prep_instructions ?? null,
          available: dto.available ?? true,
          sortOrder: dto.sort_order ?? 0,
          createdBy: ctx.userId,
        },
      });
      await this.replaceChoices(tx, ctx, id, dto.sizes ?? [], dto.options ?? []);
      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'MENU_ITEM_CREATED',
        entityType: 'menu_item',
        entityId: id,
        newValues: { name: dto.name, price: dto.price, category_id: dto.category_id },
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });
      return this.item(tx, id);
    });
  }

  updateItem(
    ctx: AuthContext,
    id: string,
    dto: UpdateItemDto,
    origin: RequestOrigin,
  ): Promise<MenuItemPayload> {
    return this.tenant(ctx, async (tx) => {
      requireOwner(await resolveAccess(tx, ctx));
      const before = await tx.menuItem.findFirst({ where: { id } });
      if (!before) throw notFound();
      if (dto.category_id !== undefined) await this.category(tx, dto.category_id);
      await tx.menuItem.update({
        where: { id },
        data: {
          ...(dto.category_id !== undefined ? { categoryId: dto.category_id } : {}),
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          ...(dto.price !== undefined ? { price: dto.price } : {}),
          ...(dto.ingredients !== undefined ? { ingredients: dto.ingredients } : {}),
          ...(dto.recipe !== undefined ? { recipe: dto.recipe } : {}),
          ...(dto.prep_instructions !== undefined
            ? { prepInstructions: dto.prep_instructions }
            : {}),
          ...(dto.available !== undefined ? { available: dto.available } : {}),
          ...(dto.sort_order !== undefined ? { sortOrder: dto.sort_order } : {}),
          ...(dto.archived !== undefined
            ? { archivedAt: dto.archived ? (before.archivedAt ?? new Date()) : null }
            : {}),
        },
      });
      if (dto.sizes !== undefined || dto.options !== undefined) {
        const current = await tx.menuItem.findFirstOrThrow({
          where: { id },
          include: ITEM_INCLUDE,
        });
        await this.replaceChoices(
          tx,
          ctx,
          id,
          dto.sizes ??
            current.sizes.map((s) => ({ name: s.name, price: money(s.price).toString() })),
          dto.options ??
            current.options.map((o) => ({
              kind: o.kind,
              name: o.name,
              price: money(o.price).toString(),
            })),
        );
      }
      const archivedNow = dto.archived === true && before.archivedAt === null;
      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: archivedNow ? 'MENU_ITEM_ARCHIVED' : 'MENU_ITEM_UPDATED',
        entityType: 'menu_item',
        entityId: id,
        oldValues: {
          name: before.name,
          price: money(before.price).toString(),
          available: before.available,
        },
        newValues: {
          fields: Object.keys(dto).sort(),
          ...(dto.price !== undefined ? { price: dto.price } : {}),
        },
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });
      return this.item(tx, id);
    });
  }

  private async category(tx: TenantClient, id: string): Promise<void> {
    const row = await tx.menuCategory.findFirst({ where: { id }, select: { id: true } });
    if (!row) throw fieldError({ category_id: ['not_found'] });
  }

  /** Sizes and options are replaced as a whole; order lines keep their own copies. */
  private async replaceChoices(
    tx: TenantClient,
    ctx: AuthContext,
    itemId: string,
    sizes: readonly SizeDto[],
    options: readonly OptionDto[],
  ): Promise<void> {
    const sizeNames = sizes.map((s) => s.name.toLocaleLowerCase());
    if (new Set(sizeNames).size !== sizeNames.length)
      throw fieldError({ sizes: ['already_taken'] });
    await tx.menuItemSize.deleteMany({ where: { itemId } });
    await tx.menuItemOption.deleteMany({ where: { itemId } });
    if (sizes.length > 0) {
      await tx.menuItemSize.createMany({
        data: sizes.map((s, index) => ({
          id: generateId(),
          companyId: ctx.companyId,
          itemId,
          name: s.name,
          price: s.price,
          sortOrder: index,
        })),
      });
    }
    if (options.length > 0) {
      await tx.menuItemOption.createMany({
        data: options.map((o, index) => ({
          id: generateId(),
          companyId: ctx.companyId,
          itemId,
          kind: o.kind,
          name: o.name,
          price: o.price,
          sortOrder: index,
        })),
      });
    }
  }

  private async item(tx: TenantClient, id: string): Promise<MenuItemPayload> {
    const row = await tx.menuItem.findFirst({ where: { id }, include: ITEM_INCLUDE });
    if (!row) throw notFound();
    return itemPayload(row, true);
  }

  // -------------------------------------------------------------------------
  // Photos
  // -------------------------------------------------------------------------

  async uploadImage(
    ctx: AuthContext,
    id: string,
    file: UploadedPart | undefined,
    origin: RequestOrigin,
  ): Promise<MenuItemPayload> {
    if (!file) throw fieldError({ image: ['required'] });
    if (file.buffer.length > MAX_MENU_IMAGE_BYTES) throw fieldError({ image: ['too_large'] });
    const inspected = inspectLogo(file.buffer);
    if (typeof inspected === 'string')
      throw fieldError({ image: [inspected === 'too_large' ? 'too_large' : 'unsupported_type'] });
    if (inspected.type === 'svg') throw fieldError({ image: ['unsupported_type'] });
    // Permission and existence first, before anything is written to storage.
    await this.tenant(ctx, async (tx) => {
      requireOwner(await resolveAccess(tx, ctx));
      const row = await tx.menuItem.findFirst({ where: { id }, select: { id: true } });
      if (!row) throw notFound();
    });
    const key = `companies/${ctx.companyId}/menu/${generateId()}.${inspected.type === 'jpeg' ? 'jpg' : 'png'}`;
    const contentType = inspected.type === 'jpeg' ? 'image/jpeg' : 'image/png';
    await this.storage.put({ key, body: file.buffer, contentType, checksum: sha256(file.buffer) });
    let replaced: string | null = null;
    try {
      const result = await this.tenant(ctx, async (tx) => {
        const before = await tx.menuItem.findFirst({ where: { id }, select: { imageKey: true } });
        if (!before) throw notFound();
        replaced = before.imageKey;
        await tx.menuItem.update({
          where: { id },
          data: { imageKey: key, imageType: inspected.type, imageVersion: { increment: 1 } },
        });
        await this.audit.record(tx, {
          companyId: ctx.companyId,
          userId: ctx.userId,
          action: 'MENU_ITEM_IMAGE_CHANGED',
          entityType: 'menu_item',
          entityId: id,
          newValues: { type: inspected.type, width: inspected.width, height: inspected.height },
          ipAddress: origin.ipAddress,
          userAgent: origin.userAgent,
        });
        return this.item(tx, id);
      });
      await this.discard(replaced);
      return result;
    } catch (error) {
      await this.discard(key);
      throw error;
    }
  }

  async removeImage(ctx: AuthContext, id: string, origin: RequestOrigin): Promise<MenuItemPayload> {
    let replaced: string | null = null;
    const result = await this.tenant(ctx, async (tx) => {
      requireOwner(await resolveAccess(tx, ctx));
      const before = await tx.menuItem.findFirst({ where: { id }, select: { imageKey: true } });
      if (!before) throw notFound();
      if (before.imageKey) {
        replaced = before.imageKey;
        await tx.menuItem.update({
          where: { id },
          data: { imageKey: null, imageType: null, imageVersion: { increment: 1 } },
        });
        await this.audit.record(tx, {
          companyId: ctx.companyId,
          userId: ctx.userId,
          action: 'MENU_ITEM_IMAGE_CHANGED',
          entityType: 'menu_item',
          entityId: id,
          newValues: { removed: true },
          ipAddress: origin.ipAddress,
          userAgent: origin.userAgent,
        });
      }
      return this.item(tx, id);
    });
    await this.discard(replaced);
    return result;
  }

  async image(ctx: AuthContext, id: string): Promise<ImageStream> {
    const row = await this.tenant(ctx, async (tx) => {
      const access = await resolveAccess(tx, ctx);
      // Anyone who sees the menu or an order line may see its photo.
      if (
        !can(access, 'menu.view') &&
        !can(access, 'kitchen.view') &&
        !can(access, 'waiter.view')
      ) {
        requireAction(access, 'menu.view');
      }
      return tx.menuItem.findFirst({ where: { id }, select: { imageKey: true, imageType: true } });
    });
    if (!row?.imageKey) throw notFound();
    // The key always sits under this company's own prefix; anything else is refused.
    if (!row.imageKey.startsWith(`companies/${ctx.companyId}/menu/`)) throw notFound();
    return {
      stream: await this.storage.get(row.imageKey),
      contentType: row.imageType === 'jpeg' ? 'image/jpeg' : 'image/png',
    };
  }

  /** Best effort: an orphaned object costs storage, never correctness. */
  private async discard(key: string | null): Promise<void> {
    if (!key) return;
    try {
      await this.storage.delete(key);
    } catch {
      // Left for a later clean-up.
    }
  }
}

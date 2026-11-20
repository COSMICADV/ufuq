/**
 * 1to1OS Personal — Health, phase 1: medical documents.
 *
 * A document's pages are sensitive attachments. Deleting moves a document to
 * the trash; restoring brings it back; emptying it (by hand, or 30 days
 * later by the daily job) removes the row and the stored bytes, leaving only
 * the attachment's audit trail with its name redacted. Nothing medical is
 * ever logged: log lines carry counts and ids only.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { generateId, listActiveCompanyIds, withPlatformContext, withTenant } from '@ufuq/db';
import type { Prisma, PrismaClient, TenantClient } from '@ufuq/db';

import type { AttachmentPayload } from '../attachments/attachment-payload.js';
import { AttachmentsService } from '../attachments/attachments.service.js';
import { OBJECT_STORAGE } from '../attachments/object-storage.js';
import type { ObjectStorage } from '../attachments/object-storage.js';
import type { AuthContext } from '../auth/auth-context.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import type { ResolvedPage } from '../company-structure/dto/pagination.dto.js';
import { fieldError, notFound, TenantScopedService } from '../company-structure/tenant-scoped.service.js';

import { daysLeft, DOCUMENT_CATEGORIES, trashCutoff } from './health-rules.js';
import type { DocumentCategory } from './health-rules.js';
import type { CreateDocumentDto, ListDocumentsQueryDto, UpdateDocumentDto } from './health.dto.js';

const PAGE_TYPE = 'health_document';

export interface DocumentPayload {
  readonly id: string;
  readonly title: string;
  readonly category: DocumentCategory;
  readonly document_date: string | null;
  readonly notes: string | null;
  readonly link_type: string | null;
  readonly link_id: string | null;
  readonly page_count: number;
  /** The first image page, for a thumbnail (fetched through the private download). */
  readonly cover_id: string | null;
  readonly in_trash: boolean;
  readonly days_left: number | null;
  readonly created_at: string;
  readonly pages?: readonly AttachmentPayload[];
}

export interface OverviewPayload {
  readonly documents: number;
  readonly trash: number;
  readonly by_category: Readonly<Record<DocumentCategory, number>>;
  readonly recent: readonly DocumentPayload[];
}

interface DocumentRow {
  readonly id: string;
  readonly title: string;
  readonly category: DocumentCategory;
  readonly documentDate: Date | null;
  readonly notes: string | null;
  readonly linkType: string | null;
  readonly linkId: string | null;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
}

function payload(row: DocumentRow, pages: { count: number; cover: string | null }, now: Date): DocumentPayload {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    document_date: row.documentDate ? row.documentDate.toISOString().slice(0, 10) : null,
    notes: row.notes,
    link_type: row.linkType,
    link_id: row.linkId,
    page_count: pages.count,
    cover_id: pages.cover,
    in_trash: row.deletedAt !== null,
    days_left: row.deletedAt ? daysLeft(row.deletedAt, now) : null,
    created_at: row.createdAt.toISOString(),
  };
}

/** Page counts and a cover image for a set of documents, in one query. */
async function pageInfo(
  tx: TenantClient,
  ids: readonly string[],
): Promise<ReadonlyMap<string, { count: number; cover: string | null }>> {
  const result = new Map<string, { count: number; cover: string | null }>();
  if (ids.length === 0) return result;
  const rows = await tx.attachment.findMany({
    where: { relatedType: PAGE_TYPE, relatedId: { in: [...ids] }, deletedAt: null },
    select: { id: true, relatedId: true, mimeType: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  for (const row of rows) {
    const info = result.get(row.relatedId) ?? { count: 0, cover: null };
    info.count += 1;
    if (info.cover === null && row.mimeType.startsWith('image/')) info.cover = row.id;
    result.set(row.relatedId, info);
  }
  return result;
}

function dateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

@Injectable()
export class PersonalHealthService extends TenantScopedService {
  private readonly logger = new Logger(PersonalHealthService.name);

  constructor(
    @Inject(PRISMA_CLIENT) prisma: PrismaClient,
    @Inject(AttachmentsService) private readonly attachments: AttachmentsService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {
    super(prisma);
  }

  async overview(ctx: AuthContext): Promise<OverviewPayload> {
    return this.tenant(ctx, async (tx) => {
      const now = new Date();
      const [groups, trash, recent] = await Promise.all([
        tx.healthDocument.groupBy({ by: ['category'], where: { deletedAt: null }, _count: { _all: true } }),
        tx.healthDocument.count({ where: { deletedAt: { not: null } } }),
        tx.healthDocument.findMany({
          where: { deletedAt: null },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 6,
        }),
      ]);
      const byCategory = Object.fromEntries(DOCUMENT_CATEGORIES.map((c) => [c, 0])) as Record<DocumentCategory, number>;
      let documents = 0;
      for (const g of groups) {
        byCategory[g.category] = g._count._all;
        documents += g._count._all;
      }
      const info = await pageInfo(
        tx,
        recent.map((r) => r.id),
      );
      return {
        documents,
        trash,
        by_category: byCategory,
        recent: recent.map((r) => payload(r, info.get(r.id) ?? { count: 0, cover: null }, now)),
      };
    });
  }

  async list(
    ctx: AuthContext,
    query: ListDocumentsQueryDto,
    page: ResolvedPage,
  ): Promise<{ items: DocumentPayload[]; total: number }> {
    return this.tenant(ctx, async (tx) => {
      const now = new Date();
      const where: Prisma.HealthDocumentWhereInput = {
        deletedAt: query.trash === 'true' ? { not: null } : null,
        ...(query.category ? { category: query.category } : {}),
        ...(query.q
          ? {
              OR: [
                { title: { contains: query.q, mode: 'insensitive' } },
                { notes: { contains: query.q, mode: 'insensitive' } },
              ],
            }
          : {}),
      };
      const [rows, total] = await Promise.all([
        tx.healthDocument.findMany({
          where,
          orderBy:
            query.trash === 'true'
              ? [{ deletedAt: 'desc' }, { id: 'desc' }]
              : [{ documentDate: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }],
          skip: page.skip,
          take: page.take,
        }),
        tx.healthDocument.count({ where }),
      ]);
      const info = await pageInfo(
        tx,
        rows.map((r) => r.id),
      );
      return { items: rows.map((r) => payload(r, info.get(r.id) ?? { count: 0, cover: null }, now)), total };
    });
  }

  async get(ctx: AuthContext, id: string): Promise<DocumentPayload> {
    return this.tenant(ctx, async (tx) => {
      const row = await tx.healthDocument.findUnique({ where: { id } });
      if (!row) throw notFound();
      const pages = [...(await this.attachments.listFor(tx, PAGE_TYPE, id))].reverse();
      const cover = pages.find((p) => p.mime_type.startsWith('image/'))?.id ?? null;
      return { ...payload(row, { count: pages.length, cover }, new Date()), pages };
    });
  }

  async create(ctx: AuthContext, dto: CreateDocumentDto): Promise<DocumentPayload> {
    return this.tenant(ctx, async (tx) => {
      const row = await tx.healthDocument.create({
        data: {
          id: generateId(),
          companyId: ctx.companyId,
          userId: ctx.userId,
          title: dto.title,
          category: dto.category,
          documentDate: dto.document_date ? dateOnly(dto.document_date) : null,
          notes: dto.notes || null,
        },
      });
      return payload(row, { count: 0, cover: null }, new Date());
    });
  }

  async update(ctx: AuthContext, id: string, dto: UpdateDocumentDto): Promise<DocumentPayload> {
    return this.tenant(ctx, async (tx) => {
      const existing = await tx.healthDocument.findUnique({ where: { id } });
      if (!existing) throw notFound();
      if (existing.deletedAt !== null) throw fieldError({ id: ['not_allowed'] });
      if (dto.document_date !== undefined && dto.document_date !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(dto.document_date)) {
        throw fieldError({ document_date: ['invalid'] });
      }
      const row = await tx.healthDocument.update({
        where: { id },
        data: {
          ...(dto.title === undefined ? {} : { title: dto.title }),
          ...(dto.category === undefined ? {} : { category: dto.category }),
          ...(dto.document_date === undefined
            ? {}
            : { documentDate: dto.document_date === '' ? null : dateOnly(dto.document_date) }),
          ...(dto.notes === undefined ? {} : { notes: dto.notes || null }),
        },
      });
      const info = await pageInfo(tx, [id]);
      return payload(row, info.get(id) ?? { count: 0, cover: null }, new Date());
    });
  }

  async trash(ctx: AuthContext, id: string): Promise<void> {
    await this.tenant(ctx, async (tx) => {
      const row = await tx.healthDocument.findUnique({ where: { id }, select: { deletedAt: true } });
      if (!row) throw notFound();
      if (row.deletedAt === null) {
        await tx.healthDocument.update({ where: { id }, data: { deletedAt: new Date() } });
      }
    });
  }

  async restore(ctx: AuthContext, id: string): Promise<void> {
    await this.tenant(ctx, async (tx) => {
      const row = await tx.healthDocument.findUnique({ where: { id }, select: { id: true } });
      if (!row) throw notFound();
      await tx.healthDocument.update({ where: { id }, data: { deletedAt: null } });
    });
  }

  /** Empty one document from the trash now. Only a trashed document can be removed. */
  async removeForGood(ctx: AuthContext, id: string): Promise<void> {
    const keys = await this.tenant(ctx, async (tx) => {
      const row = await tx.healthDocument.findUnique({ where: { id }, select: { deletedAt: true } });
      if (!row) throw notFound();
      if (row.deletedAt === null) throw fieldError({ id: ['not_allowed'] });
      return this.erase(tx, [id]);
    });
    await this.deleteObjects(keys);
  }

  /** The daily job: every document trashed more than 30 days ago, in every account. */
  async purgeExpired(now: Date = new Date()): Promise<number> {
    const cutoff = trashCutoff(now);
    const companyIds = await withPlatformContext(this.prisma, (tx) => listActiveCompanyIds(tx));
    let removed = 0;
    for (const companyId of companyIds) {
      try {
        for (;;) {
          const { count, keys } = await withTenant(this.prisma, companyId, async (tx) => {
            const due = await tx.healthDocument.findMany({
              where: { deletedAt: { lt: cutoff } },
              select: { id: true },
              take: 100,
            });
            return {
              count: due.length,
              keys: due.length === 0 ? [] : await this.erase(tx, due.map((d) => d.id)),
            };
          });
          await this.deleteObjects(keys);
          removed += count;
          if (count < 100) break;
        }
      } catch (error) {
        this.logger.error(
          `Health trash purge for ${companyId} failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    }
    return removed;
  }

  /**
   * Deletes the documents and retires their pages (the attachment rows stay,
   * as every attachment's audit trail does, with the name scrubbed). Returns
   * the storage keys to delete once the transaction has committed.
   */
  private async erase(tx: TenantClient, ids: readonly string[]): Promise<string[]> {
    const pages = await tx.attachment.findMany({
      where: { relatedType: PAGE_TYPE, relatedId: { in: [...ids] } },
      select: { id: true, storedPath: true },
    });
    if (pages.length > 0) {
      await tx.attachment.updateMany({
        where: { id: { in: pages.map((p) => p.id) } },
        data: { originalName: '[removed]' },
      });
      await tx.attachment.updateMany({
        where: { id: { in: pages.map((p) => p.id) }, deletedAt: null },
        data: { deletedAt: new Date() },
      });
    }
    await tx.healthDocument.deleteMany({ where: { id: { in: [...ids] } } });
    return pages.map((p) => p.storedPath);
  }

  private async deleteObjects(keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      try {
        await this.storage.delete(key);
      } catch {
        // The row is already retired, so the bytes are unreachable; log only that it happened.
        this.logger.warn('A removed health document page could not be deleted from storage');
      }
    }
  }
}

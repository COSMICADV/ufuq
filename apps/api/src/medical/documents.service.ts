/**
 * 1to1OS Business — Medical, phase M1: patient documents and their categories.
 *
 * A document belongs to one patient; its pages are sensitive attachments
 * (uploaded through /attachments, checked by MedicalDocumentAttachmentPolicy).
 * What a person sees is narrowed in the query: only the kinds (documents /
 * labs / imaging) whose view permission reaches the patient. A document the
 * caller may not see answers 404, like one that does not exist.
 * Audit rows carry ids, the category and counts — never titles or notes.
 */

import { Inject, Injectable } from '@nestjs/common';
import { generateId } from '@ufuq/db';
import type { Prisma, PrismaClient, TenantClient } from '@ufuq/db';

import { AuditDispatcher } from '../auth/audit-dispatcher.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AppException } from '../common/app-exception.js';
import { ERROR_CODES } from '../common/errors.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import type { RequestOrigin } from '../common/request-context.js';
import { fieldError, notFound, TenantScopedService } from '../company-structure/tenant-scoped.service.js';

import { reachablePatient, reaches, requireGrant, resolveAccess } from './medical-access.js';
import type { MedicalAccess } from './medical-access.js';
import type { CategoryDto, CreateDocumentDto, UpdateCategoryDto, UpdateDocumentDto } from './documents.dto.js';
import { DEFAULT_CATEGORIES, defaultKind, DOCUMENT_KINDS, MAX_CUSTOM_CATEGORIES, VIEW_PERMISSION } from './document-rules.js';
import type { DocumentKind } from './document-rules.js';

export interface CategoryPayload {
  /** A default category's key, or a custom category's id. */
  readonly id: string;
  readonly custom: boolean;
  readonly kind: DocumentKind;
  /** Custom categories only; default names come from the translations. */
  readonly name_ar: string | null;
  readonly name_en: string | null;
  readonly archived: boolean;
}

export interface PagePayload {
  readonly id: string;
  readonly mime_type: string;
  readonly size_bytes: number;
  readonly created_at: string;
}

export interface DocumentPayload {
  readonly id: string;
  readonly patient_id: string;
  readonly visit: { readonly id: string; readonly visit_at: string } | null;
  readonly category: CategoryPayload;
  readonly title: string;
  readonly document_date: string | null;
  readonly notes: string | null;
  readonly source: 'upload' | 'camera';
  readonly archived: boolean;
  readonly pages: readonly PagePayload[];
  readonly created_by: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly can: {
    readonly upload: boolean;
    readonly edit: boolean;
    readonly archive: boolean;
    readonly delete: boolean;
  };
}

export interface DocumentListPayload {
  readonly documents: readonly DocumentPayload[];
  /** The kinds this person may see for this patient (the screen's filter chips). */
  readonly kinds: readonly DocumentKind[];
  readonly can_upload: boolean;
}

const DOCUMENT_INCLUDE = {
  visit: { select: { id: true, visitAt: true } },
  customCategory: true,
  creator: { select: { email: true, employee: { select: { firstName: true, lastName: true } } } },
} as const satisfies Prisma.MedicalDocumentInclude;

type DocumentRow = Prisma.MedicalDocumentGetPayload<{ include: typeof DOCUMENT_INCLUDE }>;

function forbidden(): AppException {
  return new AppException(ERROR_CODES.FORBIDDEN, 403);
}

function kindOf(row: Pick<DocumentRow, 'categoryKey' | 'customCategory'>): DocumentKind {
  return (row.categoryKey ? defaultKind(row.categoryKey) : (row.customCategory?.kind as DocumentKind | undefined)) ?? 'document';
}

function dateOnly(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

@Injectable()
export class DocumentsService extends TenantScopedService {
  constructor(
    @Inject(PRISMA_CLIENT) prisma: PrismaClient,
    @Inject(AuditDispatcher) private readonly audit: AuditDispatcher,
  ) {
    super(prisma, audit);
  }

  // -------------------------------------------------------------------------
  // Categories
  // -------------------------------------------------------------------------

  categories(ctx: AuthContext): Promise<CategoryPayload[]> {
    return this.tenant(ctx, async (tx) => {
      const access = await resolveAccess(tx, ctx);
      if (!access.enabled) throw notFound();
      if (access.grants.size === 0) throw forbidden();
      const custom = await tx.medicalDocumentCategory.findMany({ orderBy: { createdAt: 'asc' } });
      return [
        ...DEFAULT_CATEGORIES.map((c) => ({ id: c.key, custom: false, kind: c.kind, name_ar: null, name_en: null, archived: false })),
        ...custom.map((c) => ({
          id: c.id,
          custom: true,
          kind: c.kind as DocumentKind,
          name_ar: c.nameAr,
          name_en: c.nameEn,
          archived: c.archivedAt !== null,
        })),
      ];
    });
  }

  createCategory(ctx: AuthContext, dto: CategoryDto, origin: RequestOrigin): Promise<CategoryPayload> {
    return this.tenant(ctx, async (tx) => {
      const access = await resolveAccess(tx, ctx);
      requireGrant(access, 'categories.manage');
      if ((await tx.medicalDocumentCategory.count()) >= MAX_CUSTOM_CATEGORIES) throw fieldError({ name_en: ['too_large'] });
      const row = await tx.medicalDocumentCategory.create({
        data: { id: generateId(), companyId: ctx.companyId, nameAr: dto.name_ar, nameEn: dto.name_en, kind: dto.kind, createdBy: ctx.userId },
      });
      await this.record(tx, ctx, origin, 'MEDICAL_CATEGORY_CHANGED', 'medical_document_category', row.id, { created: true, kind: dto.kind });
      return { id: row.id, custom: true, kind: dto.kind, name_ar: row.nameAr, name_en: row.nameEn, archived: false };
    });
  }

  updateCategory(ctx: AuthContext, id: string, dto: UpdateCategoryDto, origin: RequestOrigin): Promise<CategoryPayload> {
    return this.tenant(ctx, async (tx) => {
      const access = await resolveAccess(tx, ctx);
      requireGrant(access, 'categories.manage');
      const current = await tx.medicalDocumentCategory.findFirst({ where: { id } });
      if (!current) throw notFound();
      // The kind never changes: it decides who may see documents already filed under it.
      const row = await tx.medicalDocumentCategory.update({
        where: { id },
        data: {
          ...(dto.name_ar !== undefined ? { nameAr: dto.name_ar } : {}),
          ...(dto.name_en !== undefined ? { nameEn: dto.name_en } : {}),
          ...(dto.archived !== undefined ? { archivedAt: dto.archived ? new Date() : null } : {}),
        },
      });
      await this.record(tx, ctx, origin, 'MEDICAL_CATEGORY_CHANGED', 'medical_document_category', id, {
        fields: Object.keys(dto),
      });
      return {
        id: row.id,
        custom: true,
        kind: row.kind as DocumentKind,
        name_ar: row.nameAr,
        name_en: row.nameEn,
        archived: row.archivedAt !== null,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Documents
  // -------------------------------------------------------------------------

  list(ctx: AuthContext, patientId: string, filter: { kind?: DocumentKind; archived: boolean }): Promise<DocumentListPayload> {
    return this.tenant(ctx, async (tx) => {
      const access = await resolveAccess(tx, ctx);
      if (!access.enabled) throw notFound();
      await this.anyReach(tx, access, patientId);
      const kinds = await this.visibleKinds(tx, access, patientId);
      const wanted = filter.kind ? kinds.filter((k) => k === filter.kind) : kinds;
      const canUpload = await reaches(tx, access, 'documents.upload', patientId);
      if (wanted.length === 0) return { documents: [], kinds, can_upload: canUpload };
      const rows = await tx.medicalDocument.findMany({
        where: {
          patientId,
          deletedAt: null,
          archivedAt: filter.archived ? { not: null } : null,
          OR: [
            { categoryKey: { in: DEFAULT_CATEGORIES.filter((c) => wanted.includes(c.kind)).map((c) => c.key) } },
            { customCategory: { kind: { in: [...wanted] } } },
          ],
        },
        include: DOCUMENT_INCLUDE,
        orderBy: [{ documentDate: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
        take: 300,
      });
      return { documents: await this.payloads(tx, access, rows), kinds, can_upload: canUpload };
    });
  }

  get(ctx: AuthContext, id: string): Promise<DocumentPayload> {
    return this.tenant(ctx, async (tx) => {
      const access = await resolveAccess(tx, ctx);
      const row = await this.visible(tx, access, id);
      const [payload] = await this.payloads(tx, access, [row]);
      return payload as DocumentPayload;
    });
  }

  create(ctx: AuthContext, patientId: string, dto: CreateDocumentDto, origin: RequestOrigin): Promise<DocumentPayload> {
    return this.tenant(ctx, async (tx) => {
      const access = await resolveAccess(tx, ctx);
      const scope = requireGrant(access, 'documents.upload');
      const patient = await reachablePatient(tx, access, scope, patientId);
      const full = await tx.patient.findUniqueOrThrow({ where: { id: patientId }, select: { fileNumber: true } });
      // The number on the uploader's screen must be this patient's.
      if (full.fileNumber !== dto.patient_file_number) throw fieldError({ patient_file_number: ['mismatch'] });
      if (patient.archivedAt) throw fieldError({ patient: ['not_active'] });
      const category = await this.category(tx, dto.category_key, dto.custom_category_id, true);
      if (dto.visit_id) await this.requireVisit(tx, dto.visit_id, patientId);
      const id = generateId();
      const row = await tx.medicalDocument.create({
        data: {
          id,
          companyId: ctx.companyId,
          patientId,
          visitId: dto.visit_id ?? null,
          categoryKey: category.key,
          customCategoryId: category.customId,
          title: dto.title,
          documentDate: dto.document_date ? new Date(`${dto.document_date}T00:00:00Z`) : null,
          notes: dto.notes || null,
          source: dto.source ?? 'upload',
          createdBy: ctx.userId,
        },
        include: DOCUMENT_INCLUDE,
      });
      await this.record(tx, ctx, origin, 'MEDICAL_DOCUMENT_CREATED', 'medical_document', id, {
        patient_id: patientId,
        category: category.key ?? category.customId,
        kind: category.kind,
      });
      const [payload] = await this.payloads(tx, access, [row]);
      return payload as DocumentPayload;
    });
  }

  update(ctx: AuthContext, id: string, dto: UpdateDocumentDto, origin: RequestOrigin): Promise<DocumentPayload> {
    return this.tenant(ctx, async (tx) => {
      const access = await resolveAccess(tx, ctx);
      const current = await this.visible(tx, access, id);
      if (!(await reaches(tx, access, 'documents.edit', current.patientId))) throw forbidden();
      if (current.archivedAt) throw fieldError({ document: ['not_active'] });
      const data: Prisma.MedicalDocumentUncheckedUpdateInput = { updatedBy: ctx.userId };
      const changed: string[] = [];
      if (dto.category_key !== undefined || dto.custom_category_id !== undefined) {
        const category = await this.category(tx, dto.category_key, dto.custom_category_id, true);
        // Moving a document to a kind you cannot see would hide it from you: refused.
        if (!(await reaches(tx, access, VIEW_PERMISSION[category.kind], current.patientId))) {
          throw fieldError({ category_key: ['not_allowed'] });
        }
        data.categoryKey = category.key;
        data.customCategoryId = category.customId;
        changed.push('category');
      }
      if (dto.title !== undefined) {
        data.title = dto.title;
        changed.push('title');
      }
      if (dto.document_date !== undefined) {
        data.documentDate = dto.document_date ? new Date(`${dto.document_date}T00:00:00Z`) : null;
        changed.push('document_date');
      }
      if (dto.notes !== undefined) {
        data.notes = dto.notes || null;
        changed.push('notes');
      }
      if (dto.visit_id !== undefined) {
        if (dto.visit_id) await this.requireVisit(tx, dto.visit_id, current.patientId);
        data.visitId = dto.visit_id;
        changed.push('visit_id');
      }
      const row = await tx.medicalDocument.update({ where: { id }, data, include: DOCUMENT_INCLUDE });
      if (changed.length > 0) {
        await this.record(tx, ctx, origin, 'MEDICAL_DOCUMENT_UPDATED', 'medical_document', id, { fields: changed });
      }
      const [payload] = await this.payloads(tx, access, [row]);
      return payload as DocumentPayload;
    });
  }

  setArchived(ctx: AuthContext, id: string, archived: boolean, origin: RequestOrigin): Promise<DocumentPayload> {
    return this.tenant(ctx, async (tx) => {
      const access = await resolveAccess(tx, ctx);
      const current = await this.visible(tx, access, id);
      if (!(await reaches(tx, access, 'documents.archive', current.patientId))) throw forbidden();
      let row = current;
      if ((current.archivedAt !== null) !== archived) {
        row = await tx.medicalDocument.update({
          where: { id },
          data: { archivedAt: archived ? new Date() : null, updatedBy: ctx.userId },
          include: DOCUMENT_INCLUDE,
        });
        await this.record(tx, ctx, origin, 'MEDICAL_DOCUMENT_ARCHIVED', 'medical_document', id, { archived });
      }
      const [payload] = await this.payloads(tx, access, [row]);
      return payload as DocumentPayload;
    });
  }

  /** Marks the document deleted. The record and its pages are kept (medical records are retained). */
  remove(ctx: AuthContext, id: string, origin: RequestOrigin): Promise<void> {
    return this.tenant(ctx, async (tx) => {
      const access = await resolveAccess(tx, ctx);
      const current = await this.visible(tx, access, id);
      if (!(await reaches(tx, access, 'documents.delete', current.patientId))) throw forbidden();
      await tx.medicalDocument.update({ where: { id }, data: { deletedAt: new Date(), updatedBy: ctx.userId } });
      const pages = await tx.attachment.count({ where: { relatedType: 'medical_document', relatedId: id, deletedAt: null } });
      await this.record(tx, ctx, origin, 'MEDICAL_DOCUMENT_DELETED', 'medical_document', id, {
        patient_id: current.patientId,
        pages,
      });
    });
  }

  // -------------------------------------------------------------------------

  private async anyReach(tx: TenantClient, access: MedicalAccess, patientId: string): Promise<void> {
    const keys = ['documents.view', 'labs.view', 'imaging.view', 'documents.upload'] as const;
    for (const key of keys) if (await reaches(tx, access, key, patientId)) return;
    // Never confirm the patient exists to someone with no document access to them.
    throw notFound();
  }

  private async visibleKinds(tx: TenantClient, access: MedicalAccess, patientId: string): Promise<DocumentKind[]> {
    const out: DocumentKind[] = [];
    for (const kind of DOCUMENT_KINDS) if (await reaches(tx, access, VIEW_PERMISSION[kind], patientId)) out.push(kind);
    return out;
  }

  private async visible(tx: TenantClient, access: MedicalAccess, id: string): Promise<DocumentRow> {
    if (!access.enabled) throw notFound();
    const row = await tx.medicalDocument.findFirst({ where: { id, deletedAt: null }, include: DOCUMENT_INCLUDE });
    if (!row) throw notFound();
    if (!(await reaches(tx, access, VIEW_PERMISSION[kindOf(row)], row.patientId))) throw notFound();
    return row;
  }

  private async category(
    tx: TenantClient,
    key: string | undefined,
    customId: string | undefined,
    activeOnly: boolean,
  ): Promise<{ key: string | null; customId: string | null; kind: DocumentKind }> {
    if ((key === undefined) === (customId === undefined)) throw fieldError({ category_key: ['required'] });
    if (key !== undefined) {
      const kind = defaultKind(key);
      if (!kind) throw fieldError({ category_key: ['invalid'] });
      return { key, customId: null, kind };
    }
    const row = await tx.medicalDocumentCategory.findFirst({
      where: { id: customId as string, ...(activeOnly ? { archivedAt: null } : {}) },
    });
    if (!row) throw fieldError({ custom_category_id: ['not_found'] });
    return { key: null, customId: row.id, kind: row.kind as DocumentKind };
  }

  private async requireVisit(tx: TenantClient, visitId: string, patientId: string): Promise<void> {
    const visit = await tx.medicalVisit.findFirst({ where: { id: visitId, patientId }, select: { id: true } });
    if (!visit) throw fieldError({ visit_id: ['not_found'] });
  }

  private async payloads(tx: TenantClient, access: MedicalAccess, rows: readonly DocumentRow[]): Promise<DocumentPayload[]> {
    if (rows.length === 0) return [];
    const pages = await tx.attachment.findMany({
      where: { relatedType: 'medical_document', relatedId: { in: rows.map((r) => r.id) }, deletedAt: null },
      select: { id: true, relatedId: true, mimeType: true, sizeBytes: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    const can = new Map<string, DocumentPayload['can']>();
    for (const patientId of new Set(rows.map((r) => r.patientId))) {
      can.set(patientId, {
        upload: await reaches(tx, access, 'documents.upload', patientId),
        edit: await reaches(tx, access, 'documents.edit', patientId),
        archive: await reaches(tx, access, 'documents.archive', patientId),
        delete: await reaches(tx, access, 'documents.delete', patientId),
      });
    }
    return rows.map((row) => {
      const employee = row.creator.employee;
      return {
        id: row.id,
        patient_id: row.patientId,
        visit: row.visit ? { id: row.visit.id, visit_at: row.visit.visitAt.toISOString() } : null,
        category: row.categoryKey
          ? { id: row.categoryKey, custom: false, kind: kindOf(row), name_ar: null, name_en: null, archived: false }
          : {
              id: row.customCategoryId as string,
              custom: true,
              kind: kindOf(row),
              name_ar: row.customCategory?.nameAr ?? null,
              name_en: row.customCategory?.nameEn ?? null,
              archived: (row.customCategory?.archivedAt ?? null) !== null,
            },
        title: row.title,
        document_date: dateOnly(row.documentDate),
        notes: row.notes,
        source: row.source as 'upload' | 'camera',
        archived: row.archivedAt !== null,
        pages: pages
          .filter((p) => p.relatedId === row.id)
          .map((p) => ({ id: p.id, mime_type: p.mimeType, size_bytes: p.sizeBytes, created_at: p.createdAt.toISOString() })),
        created_by: employee ? `${employee.firstName} ${employee.lastName}`.trim() : row.creator.email,
        created_at: row.createdAt.toISOString(),
        updated_at: row.updatedAt.toISOString(),
        can: can.get(row.patientId) as DocumentPayload['can'],
      };
    });
  }

  private async record(
    tx: TenantClient,
    ctx: AuthContext,
    origin: RequestOrigin,
    action: 'MEDICAL_DOCUMENT_CREATED' | 'MEDICAL_DOCUMENT_UPDATED' | 'MEDICAL_DOCUMENT_ARCHIVED' | 'MEDICAL_DOCUMENT_DELETED' | 'MEDICAL_CATEGORY_CHANGED',
    entityType: string,
    entityId: string,
    newValues: Prisma.InputJsonObject,
  ): Promise<void> {
    await this.audit.record(tx, {
      companyId: ctx.companyId,
      userId: ctx.userId,
      action,
      entityType,
      entityId,
      newValues,
      ipAddress: origin.ipAddress,
      userAgent: origin.userAgent,
    });
  }
}

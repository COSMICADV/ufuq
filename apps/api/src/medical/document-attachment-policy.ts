/**
 * Medical document pages — sensitive attachments: every download is audited
 * (without the file name). A page is visible only to someone whose grant for
 * the document's kind (documents / labs / imaging) reaches its patient; pages
 * are added with documents.upload and removed with documents.edit. Archived or
 * deleted documents take no new pages.
 */

import { Injectable } from '@nestjs/common';
import type { TenantClient } from '@ufuq/db';

import type { AttachmentPolicy } from '../attachments/attachment-policy.js';
import type { AuthContext } from '../auth/auth-context.js';

import { reaches, resolveAccess } from './medical-access.js';
import { defaultKind, MAX_PAGES, VIEW_PERMISSION } from './document-rules.js';
import type { DocumentKind } from './document-rules.js';

interface DocRow {
  readonly patientId: string;
  readonly archivedAt: Date | null;
  readonly deletedAt: Date | null;
  readonly kind: DocumentKind;
}

export async function documentRow(tx: TenantClient, documentId: string): Promise<DocRow | null> {
  const row = await tx.medicalDocument.findFirst({
    where: { id: documentId },
    select: { patientId: true, archivedAt: true, deletedAt: true, categoryKey: true, customCategory: { select: { kind: true } } },
  });
  if (!row) return null;
  const kind = (row.categoryKey ? defaultKind(row.categoryKey) : (row.customCategory?.kind as DocumentKind | undefined)) ?? 'document';
  return { patientId: row.patientId, archivedAt: row.archivedAt, deletedAt: row.deletedAt, kind };
}

@Injectable()
export class MedicalDocumentAttachmentPolicy implements AttachmentPolicy {
  readonly relatedType = 'medical_document' as const;
  readonly sensitive = true;

  async canView(tx: TenantClient, ctx: AuthContext, documentId: string): Promise<boolean> {
    const doc = await documentRow(tx, documentId);
    if (!doc || doc.deletedAt) return false;
    return reaches(tx, await resolveAccess(tx, ctx), VIEW_PERMISSION[doc.kind], doc.patientId);
  }

  async canUpload(tx: TenantClient, ctx: AuthContext, documentId: string): Promise<boolean> {
    const doc = await documentRow(tx, documentId);
    if (!doc || doc.deletedAt || doc.archivedAt) return false;
    if (!(await reaches(tx, await resolveAccess(tx, ctx), 'documents.upload', doc.patientId))) return false;
    const pages = await tx.attachment.count({ where: { relatedType: this.relatedType, relatedId: documentId, deletedAt: null } });
    return pages < MAX_PAGES;
  }

  async canDelete(tx: TenantClient, ctx: AuthContext, documentId: string): Promise<boolean> {
    const doc = await documentRow(tx, documentId);
    if (!doc || doc.deletedAt || doc.archivedAt) return false;
    return reaches(tx, await resolveAccess(tx, ctx), 'documents.edit', doc.patientId);
  }
}

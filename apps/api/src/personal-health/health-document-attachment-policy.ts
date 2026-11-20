/**
 * Medical document pages — the attachment store's sixth consumer, and its
 * first **sensitive** one: every download is audited (without the file name),
 * and a page is visible only to the Personal account that owns the document
 * (`personal.health`, RLS for everything else). A document in the trash can
 * still be viewed, but takes no new pages.
 */

import { Injectable } from '@nestjs/common';
import type { TenantClient } from '@ufuq/db';

import type { AttachmentPolicy } from '../attachments/attachment-policy.js';
import type { AuthContext } from '../auth/auth-context.js';

import { MAX_PAGES } from './health-rules.js';

@Injectable()
export class HealthDocumentAttachmentPolicy implements AttachmentPolicy {
  readonly relatedType = 'health_document' as const;
  readonly sensitive = true;

  async canView(tx: TenantClient, ctx: AuthContext, documentId: string): Promise<boolean> {
    if (!ctx.permissions.has('personal.health')) return false;
    const row = await tx.healthDocument.findFirst({ where: { id: documentId }, select: { id: true } });
    return row !== null;
  }

  async canUpload(tx: TenantClient, ctx: AuthContext, documentId: string): Promise<boolean> {
    if (!ctx.permissions.has('personal.health')) return false;
    const row = await tx.healthDocument.findFirst({
      where: { id: documentId, deletedAt: null },
      select: { id: true },
    });
    if (!row) return false;
    const pages = await tx.attachment.count({
      where: { relatedType: this.relatedType, relatedId: documentId, deletedAt: null },
    });
    return pages < MAX_PAGES;
  }

  async canDelete(tx: TenantClient, ctx: AuthContext, documentId: string): Promise<boolean> {
    if (!ctx.permissions.has('personal.health')) return false;
    const row = await tx.healthDocument.findFirst({
      where: { id: documentId, deletedAt: null },
      select: { id: true },
    });
    return row !== null;
  }
}

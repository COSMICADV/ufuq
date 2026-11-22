/**
 * Odometer photos — the attachment store's seventh consumer. A photo is as
 * visible as its reading: only the Personal account that owns it
 * (`personal.car`; RLS hides every other account). One reading keeps at most
 * {@link MAX_PHOTOS} photos.
 */

import { Injectable } from '@nestjs/common';
import type { TenantClient } from '@ufuq/db';

import type { AttachmentPolicy } from '../attachments/attachment-policy.js';
import type { AuthContext } from '../auth/auth-context.js';

export const MAX_PHOTOS = 3;

@Injectable()
export class OdometerAttachmentPolicy implements AttachmentPolicy {
  readonly relatedType = 'odometer_reading' as const;
  readonly sensitive = false;

  async canView(tx: TenantClient, ctx: AuthContext, readingId: string): Promise<boolean> {
    if (!ctx.permissions.has('personal.car')) return false;
    return (await tx.odometerReading.findFirst({ where: { id: readingId }, select: { id: true } })) !== null;
  }

  async canUpload(tx: TenantClient, ctx: AuthContext, readingId: string): Promise<boolean> {
    if (!(await this.canView(tx, ctx, readingId))) return false;
    const count = await tx.attachment.count({
      where: { relatedType: this.relatedType, relatedId: readingId, deletedAt: null },
    });
    return count < MAX_PHOTOS;
  }

  canDelete(_tx: TenantClient, ctx: AuthContext): Promise<boolean> {
    return Promise.resolve(ctx.permissions.has('personal.car'));
  }
}

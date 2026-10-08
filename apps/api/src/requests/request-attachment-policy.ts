/**
 * Request attachments — who may see, add and remove them (DOCUMENT 01 FR-08.2
 * "attachments", DOCUMENT 04 B13 / C10).
 *
 * Expressed entirely through the request's own reach, so a file can never be
 * more visible than its request:
 *
 *   - **view** — the request is visible to the caller (`requestVisibleWhere`:
 *     their `request.view` scope, or their own request). Otherwise 404.
 *   - **upload** — the requester, on their own request while it is pending:
 *     evidence belongs with the ask, and a decided request is history.
 *   - **delete** — the requester, on their own pending request. Nobody removes
 *     a file from a decided request: the reviewer decided with it in front of
 *     them. No new permission is invented.
 */

import { Injectable } from '@nestjs/common';
import type { TenantClient } from '@ufuq/db';

import type { AuthContext } from '../auth/auth-context.js';
import type { AttachmentPolicy } from '../attachments/attachment-policy.js';
import { AppException } from '../common/app-exception.js';

import { requestVisibleWhere } from './request-query.js';

@Injectable()
export class RequestAttachmentPolicy implements AttachmentPolicy {
  readonly relatedType = 'request' as const;
  readonly sensitive = false;

  async canView(tx: TenantClient, ctx: AuthContext, requestId: string): Promise<boolean> {
    let visible;
    try {
      visible = requestVisibleWhere(ctx);
    } catch (error) {
      if (error instanceof AppException) return false;
      throw error;
    }
    const row = await tx.request.findFirst({
      where: { AND: [{ id: requestId }, visible] },
      select: { id: true },
    });
    return row !== null;
  }

  canUpload(tx: TenantClient, ctx: AuthContext, requestId: string): Promise<boolean> {
    return this.ownPending(tx, ctx, requestId);
  }

  canDelete(tx: TenantClient, ctx: AuthContext, requestId: string): Promise<boolean> {
    return this.ownPending(tx, ctx, requestId);
  }

  private async ownPending(
    tx: TenantClient,
    ctx: AuthContext,
    requestId: string,
  ): Promise<boolean> {
    if (ctx.callerEmployeeId === null || !ctx.permissions.has('request.create')) {
      return false;
    }
    const row = await tx.request.findFirst({
      where: { id: requestId, employeeId: ctx.callerEmployeeId, status: 'pending' },
      select: { id: true },
    });
    return row !== null;
  }
}

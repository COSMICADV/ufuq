/**
 * Leave attachments — who may see them (DOCUMENT 16 rule 9, DOCUMENT 20 §7).
 *
 * A leave request's file (a sick note) is stored with the submission itself
 * (`LeaveRequestsService.create`), so this policy is about reading it:
 *
 *   - **view** — the leave request is visible to the caller: their
 *     `leave.view` scope or their own. Otherwise 404, across tenants too.
 *   - **upload / delete** — nobody, through `/attachments`. The file belongs
 *     to the request as submitted and decided; replacing it afterwards would
 *     change what the reviewer decided on.
 */

import { Injectable } from '@nestjs/common';
import type { TenantClient } from '@ufuq/db';

import type { AttachmentPolicy } from '../attachments/attachment-policy.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AppException } from '../common/app-exception.js';

import { leaveVisibleWhere } from './leave-query.js';

@Injectable()
export class LeaveAttachmentPolicy implements AttachmentPolicy {
  readonly relatedType = 'leave_request' as const;
  readonly sensitive = false;

  async canView(tx: TenantClient, ctx: AuthContext, leaveRequestId: string): Promise<boolean> {
    let visible;
    try {
      visible = leaveVisibleWhere(ctx);
    } catch (error) {
      if (error instanceof AppException) return false;
      throw error;
    }
    const row = await tx.leaveRequest.findFirst({
      where: { AND: [{ id: leaveRequestId }, visible] },
      select: { id: true },
    });
    return row !== null;
  }

  canUpload(): Promise<boolean> {
    return Promise.resolve(false);
  }

  canDelete(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

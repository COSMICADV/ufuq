/**
 * Receipts — the attachment store's fifth consumer (1to1OS Personal,
 * Expenses phase 2).
 *
 * A receipt is exactly as visible as its transaction: the caller holds
 * `personal.finance` and the transaction is in the caller's own account (RLS
 * has already hidden every other). A transaction carries at most
 * {@link MAX_RECEIPTS} files.
 */

import { Injectable } from '@nestjs/common';
import type { TenantClient } from '@ufuq/db';

import type { AttachmentPolicy } from '../attachments/attachment-policy.js';
import type { AuthContext } from '../auth/auth-context.js';

export const MAX_RECEIPTS = 10;

@Injectable()
export class ReceiptAttachmentPolicy implements AttachmentPolicy {
  readonly relatedType = 'finance_transaction' as const;
  readonly sensitive = false;

  async canView(tx: TenantClient, ctx: AuthContext, transactionId: string): Promise<boolean> {
    if (!ctx.permissions.has('personal.finance')) return false;
    const row = await tx.financeTransaction.findFirst({
      where: { id: transactionId },
      select: { id: true },
    });
    return row !== null;
  }

  async canUpload(tx: TenantClient, ctx: AuthContext, transactionId: string): Promise<boolean> {
    if (!ctx.permissions.has('personal.finance')) return false;
    const count = await tx.attachment.count({
      where: { relatedType: this.relatedType, relatedId: transactionId, deletedAt: null },
    });
    return count < MAX_RECEIPTS;
  }

  canDelete(_tx: TenantClient, ctx: AuthContext): Promise<boolean> {
    return Promise.resolve(ctx.permissions.has('personal.finance'));
  }
}

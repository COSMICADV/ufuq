/**
 * Product images — the attachment store's fourth consumer (DOCUMENT 17
 * "Data": `image_path`; DOCUMENT 08 §4.14).
 *
 * An image is exactly as visible as its product: `product.view` at company
 * scope (ADMIN only in V1), and only for a product in the caller's company
 * (RLS has already hidden every other). Adding or removing one is
 * `product.update`. The product points at its current image through
 * `PATCH /products/{id}` `image_attachment_id`.
 */

import { Injectable } from '@nestjs/common';
import type { TenantClient } from '@ufuq/db';

import type { AttachmentPolicy } from '../attachments/attachment-policy.js';
import type { AuthContext } from '../auth/auth-context.js';

function companyScope(ctx: AuthContext, permission: string): boolean {
  const scope = ctx.permissions.get(permission);
  return scope === 'company' || scope === 'platform';
}

@Injectable()
export class ProductAttachmentPolicy implements AttachmentPolicy {
  readonly relatedType = 'product' as const;
  readonly sensitive = false;

  async canView(tx: TenantClient, ctx: AuthContext, productId: string): Promise<boolean> {
    if (!companyScope(ctx, 'product.view')) return false;
    const row = await tx.product.findFirst({
      where: { id: productId, deletedAt: null },
      select: { id: true },
    });
    return row !== null;
  }

  canUpload(_tx: TenantClient, ctx: AuthContext): Promise<boolean> {
    return Promise.resolve(companyScope(ctx, 'product.update'));
  }

  canDelete(_tx: TenantClient, ctx: AuthContext): Promise<boolean> {
    return Promise.resolve(companyScope(ctx, 'product.update'));
  }
}

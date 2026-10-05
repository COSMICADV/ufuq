/**
 * Attachment rows → the DOCUMENT 08 §1 wire shape (snake_case).
 *
 * `stored_path` is never sent: the storage key is an internal detail, and
 * DOCUMENT 20 §8 keeps file paths out of every response. The file is reached
 * by its id through `GET /attachments/{id}` and nothing else.
 */

import type { Prisma } from '@ufuq/db';

export const ATTACHMENT_INCLUDE = {
  uploader: {
    select: {
      id: true,
      email: true,
      employee: { select: { firstName: true, lastName: true } },
    },
  },
} as const;

export type AttachmentRow = Prisma.AttachmentGetPayload<{ include: typeof ATTACHMENT_INCLUDE }>;

export interface AttachmentPayload {
  readonly id: string;
  readonly original_name: string;
  readonly mime_type: string;
  readonly size_bytes: number;
  readonly checksum: string;
  readonly related_type: string;
  readonly related_id: string;
  readonly uploaded_by: { readonly id: string; readonly name: string | null };
  readonly created_at: string;
}

export function attachmentPayload(row: AttachmentRow): AttachmentPayload {
  const employee = row.uploader.employee;
  return {
    id: row.id,
    original_name: row.originalName,
    mime_type: row.mimeType,
    size_bytes: row.sizeBytes,
    checksum: row.checksum,
    related_type: row.relatedType,
    related_id: row.relatedId,
    uploaded_by: {
      id: row.uploader.id,
      name: employee === null ? null : `${employee.firstName} ${employee.lastName}`,
    },
    created_at: row.createdAt.toISOString(),
  };
}

/**
 * What an audit record keeps about a file — DOCUMENT 21: metadata only, never
 * the contents ("Never captured: … full attachment contents"), and not the
 * storage key either.
 */
export function attachmentAuditSnapshot(row: {
  readonly originalName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly checksum: string;
  readonly relatedType: string;
  readonly relatedId: string;
}): Prisma.InputJsonObject {
  return {
    original_name: row.originalName,
    mime_type: row.mimeType,
    size_bytes: row.sizeBytes,
    checksum: row.checksum,
    related_type: row.relatedType,
    related_id: row.relatedId,
  };
}

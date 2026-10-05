/**
 * Attachments on the browser side — DOCUMENT 08 §4.14, DOCUMENT 20 §7.
 *
 * Pure, so what the file picker offers, how a size and a type are shown, and
 * which sentence a refusal becomes are tested without a DOM. The server is the
 * authority on every rule; nothing here is a security check.
 */

import { apiUrl } from './api-client';

/** `AttachmentPayload` — see `apps/api/src/attachments/attachment-payload.ts`. */
export interface Attachment {
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

/** What a record carries about its files: the list, and the server's own answers. */
export interface RecordAttachments {
  readonly items: readonly Attachment[];
  readonly can_upload: boolean;
  readonly can_delete: boolean;
}

/** DOCUMENT 20 §7's six types, by MIME, with the short label a person reads. */
export const ATTACHMENT_TYPES: Readonly<Record<string, string>> = {
  'application/pdf': 'PDF',
  'image/png': 'PNG',
  'image/jpeg': 'JPG',
  'image/webp': 'WebP',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
};

/**
 * The file picker's `accept` — MIME types and extensions both, because some
 * mobile pickers filter by one and some by the other. On a phone this offers
 * the camera alongside the files (DOCUMENT 13 "Mobile behaviour").
 */
export const ACCEPT_ATTRIBUTE = [
  ...Object.keys(ATTACHMENT_TYPES),
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.docx',
  '.xlsx',
].join(',');

export function typeLabel(mime: string): string {
  return ATTACHMENT_TYPES[mime] ?? mime;
}

/** A size in the reader's own digits and units: "١٫٥ ميغابايت", "1.5 MB". */
export function formatBytes(bytes: number, locale: string): string {
  const tag = locale === 'ar' ? 'ar-EG' : 'en-GB';
  const [value, unit] =
    bytes >= 1024 * 1024
      ? [bytes / (1024 * 1024), 'megabyte']
      : bytes >= 1024
        ? [bytes / 1024, 'kilobyte']
        : [bytes, 'byte'];
  return new Intl.NumberFormat(tag, {
    style: 'unit',
    unit,
    unitDisplay: 'short',
    maximumFractionDigits: 1,
  }).format(value);
}

/**
 * Where a file is downloaded from — the authorization-checked endpoint, never
 * a storage URL (there is none to give). The session cookie travels with the
 * request; the API answers `Content-Disposition: attachment`.
 */
export function downloadUrl(id: string): string {
  return apiUrl(`/attachments/${encodeURIComponent(id)}`);
}

/** The translation key for a refused upload, from the API's status and field issue. */
export function uploadErrorKey(status: number, fileIssue: string | null): string {
  if (status === 429) return 'attachments.error_rate_limited';
  if (status === 404) return 'attachments.error_not_found';
  if (status === 403) return 'attachments.error_forbidden';
  switch (fileIssue) {
    case 'too_large':
      return 'attachments.error_too_large';
    case 'unsupported_type':
      return 'attachments.error_unsupported_type';
    case 'required':
      return 'attachments.error_required';
    default:
      return 'attachments.error_generic';
  }
}

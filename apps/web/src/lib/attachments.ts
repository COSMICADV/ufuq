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

/** The upload size the API accepts by default (`STORAGE_MAX_UPLOAD_BYTES`, 10 MiB). */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Uploads one person may make per hour (DOCUMENT 08 §6) — a folder larger than this is cut. */
export const MAX_UPLOADS_PER_BATCH = 30;

const EXTENSION_TYPES: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** The bits of a picked file this module reads — a `File` satisfies it. */
export interface PickedFile {
  readonly name: string;
  readonly size: number;
  readonly type: string;
  readonly webkitRelativePath?: string;
}

/**
 * Whether a picked file can be uploaded, judged before sending it: an allowed
 * type (by MIME, or by extension when the browser gives none) and the size
 * limit. A courtesy so a folder's stray files are skipped with a reason
 * rather than refused one by one — the server still checks every byte.
 */
export function fileProblem(file: PickedFile): 'too_large' | 'unsupported_type' | null {
  const extension = file.name.includes('.') ? (file.name.split('.').pop() ?? '').toLowerCase() : '';
  const mime = file.type !== '' ? file.type : (EXTENSION_TYPES[extension] ?? '');
  if (!(mime in ATTACHMENT_TYPES)) return 'unsupported_type';
  if (file.size > MAX_UPLOAD_BYTES) return 'too_large';
  return null;
}

/**
 * The name a file is stored under. A file picked from a folder keeps where it
 * was: "Reports/Q3/summary.pdf" becomes "Reports › Q3 › summary.pdf" (the
 * server keeps only the last path segment, so "/" cannot be used).
 */
export function uploadName(file: PickedFile): string {
  const path = file.webkitRelativePath ?? '';
  return path.includes('/') ? path.split('/').filter(Boolean).join(' › ') : file.name;
}

/** The type the server should be told: the browser's, or the one the extension implies. */
export function uploadType(file: PickedFile): string {
  if (file.type !== '') return file.type;
  const extension = (file.name.split('.').pop() ?? '').toLowerCase();
  return EXTENSION_TYPES[extension] ?? 'application/octet-stream';
}

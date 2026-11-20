/** 1to1OS Personal — Health: shared constants. */

export const DOCUMENT_CATEGORIES = [
  'prescription',
  'lab_result',
  'medical_report',
  'imaging',
  'vaccination',
  'insurance',
  'other',
] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

/** Pages one medical document may carry. */
export const MAX_PAGES = 20;

/** Days a deleted document waits in the trash before it is removed for good. */
export const TRASH_DAYS = 30;

/** The instant before which a trashed document is due for removal. */
export function trashCutoff(now: Date): Date {
  return new Date(now.getTime() - TRASH_DAYS * 86_400_000);
}

/** Whole days left before a document deleted at `deletedAt` is removed (never below 0). */
export function daysLeft(deletedAt: Date, now: Date): number {
  const left = TRASH_DAYS - Math.floor((now.getTime() - deletedAt.getTime()) / 86_400_000);
  return Math.max(0, left);
}

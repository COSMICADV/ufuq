/** 1to1OS Personal — Health: the shapes the API returns. */

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

export const MAX_PAGES = 20;

export interface HealthPage {
  readonly id: string;
  readonly original_name: string;
  readonly mime_type: string;
  readonly size_bytes: number;
}

export interface HealthDocument {
  readonly id: string;
  readonly title: string;
  readonly category: DocumentCategory;
  readonly document_date: string | null;
  readonly notes: string | null;
  readonly page_count: number;
  readonly cover_id: string | null;
  readonly in_trash: boolean;
  readonly days_left: number | null;
  readonly created_at: string;
  readonly pages?: readonly HealthPage[];
}

export interface HealthOverview {
  readonly documents: number;
  readonly trash: number;
  readonly by_category: Readonly<Record<DocumentCategory, number>>;
  readonly recent: readonly HealthDocument[];
}

/** A date-only value (`2026-11-15`) for display, in the person's language. */
export function documentDay(day: string, locale: string): string {
  const tag = locale === 'ar' ? 'ar-EG-u-nu-latn' : locale;
  return new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${day}T00:00:00Z`),
  );
}

export function todayInput(date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

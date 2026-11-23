/**
 * Medical documents — the ten default categories (in code; a company adds its
 * own), and which permission each kind needs to be seen.
 */

import type { MedicalPermissionKey } from './medical-rules.js';

export const DOCUMENT_KINDS = ['document', 'lab', 'imaging'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DEFAULT_CATEGORIES = [
  { key: 'prescription', kind: 'document' },
  { key: 'lab_result', kind: 'lab' },
  { key: 'radiology_report', kind: 'imaging' },
  { key: 'xray', kind: 'imaging' },
  { key: 'scan', kind: 'imaging' },
  { key: 'medical_report', kind: 'document' },
  { key: 'referral', kind: 'document' },
  { key: 'discharge_summary', kind: 'document' },
  { key: 'consent_form', kind: 'document' },
  { key: 'insurance', kind: 'document' },
] as const satisfies readonly { key: string; kind: DocumentKind }[];
export type DefaultCategoryKey = (typeof DEFAULT_CATEGORIES)[number]['key'];
export const DEFAULT_CATEGORY_KEYS: readonly string[] = DEFAULT_CATEGORIES.map((c) => c.key);

/** Seeing a lab result needs labs.view; an image, imaging.view; anything else, documents.view. */
export const VIEW_PERMISSION: Readonly<Record<DocumentKind, MedicalPermissionKey>> = {
  document: 'documents.view',
  lab: 'labs.view',
  imaging: 'imaging.view',
};

export const MAX_PAGES = 30;
export const MAX_CUSTOM_CATEGORIES = 50;

export function defaultKind(key: string): DocumentKind | null {
  return DEFAULT_CATEGORIES.find((c) => c.key === key)?.kind ?? null;
}

/**
 * 1to1OS Business — Medical: the shapes the /medical API returns, and the
 * calls the screens make. Every permission shown here is checked again by the
 * API; the screen only decides what to draw.
 */

import type { Locale } from '@ufuq/i18n';

import { fetchMany, fetchOne, sendNoContent, sendRaw, uploadForm } from './api-client';
import type { CollectionResult } from './api-client';

export const MEDICAL_PERMISSIONS = [
  'patients.view',
  'patients.manage',
  'visits.view',
  'visits.manage',
  'visits.clinical',
  'queue.manage',
  'documents.view',
  'documents.upload',
  'documents.edit',
  'documents.download',
  'documents.print',
  'documents.share',
  'documents.archive',
  'documents.delete',
  'imaging.view',
  'labs.view',
  'categories.manage',
  'staff.manage',
] as const;
export type MedicalPermission = (typeof MEDICAL_PERMISSIONS)[number];
export type MedicalScope = 'all' | 'assigned';

/** The permission groups the team screen draws, in order. */
export const PERMISSION_GROUPS: readonly (readonly [string, readonly MedicalPermission[]])[] = [
  ['patients', ['patients.view', 'patients.manage']],
  ['visits', ['visits.view', 'visits.manage', 'visits.clinical', 'queue.manage']],
  [
    'documents',
    [
      'documents.view',
      'documents.upload',
      'documents.edit',
      'documents.download',
      'documents.print',
      'documents.share',
      'documents.archive',
      'documents.delete',
      'imaging.view',
      'labs.view',
      'categories.manage',
    ],
  ],
  ['admin', ['staff.manage']],
];

export const CLINICAL_ROLES = ['doctor', 'nurse', 'technician', 'reception', 'finance', 'administration'] as const;
export type ClinicalRole = (typeof CLINICAL_ROLES)[number];

export const VISIT_STATUSES = ['scheduled', 'waiting', 'in_progress', 'completed', 'cancelled', 'no_show'] as const;
export type VisitStatus = (typeof VISIT_STATUSES)[number];

export interface MedicalMe {
  readonly enabled: boolean;
  readonly admin: boolean;
  readonly employee_id: string | null;
  readonly permissions: Readonly<Partial<Record<MedicalPermission, MedicalScope>>>;
}

export interface PersonRef {
  readonly id: string;
  readonly name: string;
  readonly clinical_role: ClinicalRole | null;
  readonly specialty: string | null;
}

export interface Grant {
  readonly key: MedicalPermission;
  readonly scope: MedicalScope;
}

export interface StaffMember extends PersonRef {
  readonly employee_code: string;
  readonly is_admin: boolean;
  readonly permissions: readonly Grant[];
}

export interface StaffList {
  readonly staff: readonly StaffMember[];
  readonly presets: Readonly<Record<ClinicalRole, readonly (readonly [MedicalPermission, MedicalScope])[]>>;
}

export interface Patient {
  readonly id: string;
  readonly file_number: string;
  readonly full_name: string;
  readonly date_of_birth: string | null;
  readonly gender: 'male' | 'female' | null;
  readonly phone: string | null;
  readonly primary_doctor: PersonRef | null;
  readonly archived: boolean;
  readonly last_visit_at: string | null;
  readonly created_at: string;
}

export interface PatientDetail extends Patient {
  readonly national_id: string | null;
  readonly notes: string | null;
  readonly care_team: readonly PersonRef[];
  readonly visit_count: number;
  readonly can: {
    readonly manage: boolean;
    readonly assign: boolean;
    readonly view_visits: boolean;
    readonly manage_visits: boolean;
    readonly clinical: boolean;
    readonly documents: boolean;
    readonly labs: boolean;
    readonly imaging: boolean;
    readonly upload_documents: boolean;
  };
}

export interface Visit {
  readonly id: string;
  readonly patient: { readonly id: string; readonly full_name: string; readonly file_number: string };
  readonly doctor: PersonRef | null;
  readonly visit_at: string;
  readonly reason: string | null;
  /** Absent when the caller may not read clinical notes. */
  readonly notes?: string | null;
  readonly status: VisitStatus;
  readonly queue_number: number | null;
  readonly checked_in_at: string | null;
  readonly called_at: string | null;
  readonly finished_at: string | null;
}

export interface Queue {
  readonly date: string;
  readonly time_zone: string;
  readonly doctors: readonly PersonRef[];
  readonly visits: readonly Visit[];
  readonly can_check_in: boolean;
}

export interface PatientInput {
  readonly full_name?: string;
  readonly date_of_birth?: string | null;
  readonly gender?: 'male' | 'female' | null;
  readonly phone?: string | null;
  readonly national_id?: string | null;
  readonly notes?: string | null;
  readonly primary_doctor_id?: string | null;
}

export interface VisitInput {
  readonly visit_at?: string;
  readonly doctor_id?: string | null;
  readonly reason?: string | null;
  readonly notes?: string | null;
  readonly status?: VisitStatus;
}

export function loadMedicalMe(locale: Locale, signal?: AbortSignal): Promise<MedicalMe> {
  return fetchOne<MedicalMe>('/medical/me', { locale, ...(signal ? { signal } : {}) });
}

export function listPatients(
  locale: Locale,
  query: { readonly q: string; readonly mine: boolean; readonly archived: boolean; readonly page: number },
  signal?: AbortSignal,
): Promise<CollectionResult<Patient>> {
  return fetchMany<Patient>('/medical/patients', {
    locale,
    query: {
      ...(query.q ? { q: query.q } : {}),
      ...(query.mine ? { mine: 'true' } : {}),
      ...(query.archived ? { archived: 'true' } : {}),
      page: String(query.page),
      per_page: '25',
    },
    ...(signal ? { signal } : {}),
  });
}

export function loadPatient(locale: Locale, id: string, signal?: AbortSignal): Promise<PatientDetail> {
  return fetchOne<PatientDetail>(`/medical/patients/${id}`, { locale, ...(signal ? { signal } : {}) });
}

export function savePatient(locale: Locale, id: string | null, body: PatientInput): Promise<PatientDetail> {
  return fetchOne<PatientDetail>(id ? `/medical/patients/${id}` : '/medical/patients', {
    locale,
    method: id ? 'PATCH' : 'POST',
    body,
  });
}

export function setArchived(locale: Locale, id: string, archived: boolean): Promise<PatientDetail> {
  return fetchOne<PatientDetail>(`/medical/patients/${id}/${archived ? 'archive' : 'restore'}`, { locale, method: 'POST' });
}

export function setCareTeam(locale: Locale, id: string, employeeIds: readonly string[]): Promise<PatientDetail> {
  return fetchOne<PatientDetail>(`/medical/patients/${id}/team`, { locale, method: 'PUT', body: { employee_ids: employeeIds } });
}

export function loadStaffOptions(locale: Locale, signal?: AbortSignal): Promise<PersonRef[]> {
  return fetchOne<PersonRef[]>('/medical/staff/options', { locale, ...(signal ? { signal } : {}) });
}

export function loadPatientVisits(locale: Locale, id: string, signal?: AbortSignal): Promise<Visit[]> {
  return fetchOne<Visit[]>(`/medical/patients/${id}/visits`, { locale, ...(signal ? { signal } : {}) });
}

export function saveVisit(locale: Locale, target: { patientId: string } | { visitId: string }, body: VisitInput): Promise<Visit> {
  return 'visitId' in target
    ? fetchOne<Visit>(`/medical/visits/${target.visitId}`, { locale, method: 'PATCH', body })
    : fetchOne<Visit>(`/medical/patients/${target.patientId}/visits`, { locale, method: 'POST', body });
}

export function loadStaff(locale: Locale, signal?: AbortSignal): Promise<StaffList> {
  return fetchOne<StaffList>('/medical/staff', { locale, ...(signal ? { signal } : {}) });
}

export function saveStaff(
  locale: Locale,
  employeeId: string,
  body: { readonly clinical_role: ClinicalRole | null; readonly specialty?: string | null; readonly permissions: readonly Grant[] },
): Promise<StaffMember> {
  return fetchOne<StaffMember>(`/medical/staff/${employeeId}`, { locale, method: 'PUT', body });
}

/** Whole years between a date of birth and today. */
export function ageFrom(dateOfBirth: string | null, today: Date = new Date()): number | null {
  if (!dateOfBirth) return null;
  const [y, m, d] = dateOfBirth.split('-').map(Number) as [number, number, number];
  let age = today.getFullYear() - y;
  if (today.getMonth() + 1 < m || (today.getMonth() + 1 === m && today.getDate() < d)) age -= 1;
  return age >= 0 ? age : null;
}

/** `datetime-local` value for an ISO instant, in the browser's zone. */
export function localInput(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// Documents (phase M1)
// ---------------------------------------------------------------------------

export const DOCUMENT_KINDS = ['document', 'lab', 'imaging'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** Files a page may be: the attachment store checks the bytes again. */
export const PAGE_ACCEPT = 'application/pdf,image/jpeg,image/png,image/webp';
export const PAGE_TYPES: readonly string[] = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
export const MAX_PAGE_BYTES = 10 * 1024 * 1024;
export const MAX_PAGES = 30;

export interface DocumentCategory {
  /** A default category's key, or a custom category's id. */
  readonly id: string;
  readonly custom: boolean;
  readonly kind: DocumentKind;
  readonly name_ar: string | null;
  readonly name_en: string | null;
  readonly archived: boolean;
}

export interface DocumentPage {
  readonly id: string;
  readonly mime_type: string;
  readonly size_bytes: number;
  readonly created_at: string;
}

export interface MedicalDocument {
  readonly id: string;
  readonly patient_id: string;
  readonly visit: { readonly id: string; readonly visit_at: string } | null;
  readonly category: DocumentCategory;
  readonly title: string;
  readonly document_date: string | null;
  readonly notes: string | null;
  readonly source: 'upload' | 'camera';
  readonly archived: boolean;
  readonly pages: readonly DocumentPage[];
  readonly created_by: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly can: { readonly upload: boolean; readonly edit: boolean; readonly archive: boolean; readonly delete: boolean };
}

export interface DocumentList {
  readonly documents: readonly MedicalDocument[];
  readonly kinds: readonly DocumentKind[];
  readonly can_upload: boolean;
}

export interface DocumentInput {
  readonly category_key?: string;
  readonly custom_category_id?: string;
  readonly title?: string;
  readonly document_date?: string | null;
  readonly visit_id?: string | null;
  readonly notes?: string | null;
}

export function categoryInput(category: DocumentCategory): Pick<DocumentInput, 'category_key' | 'custom_category_id'> {
  return category.custom ? { custom_category_id: category.id } : { category_key: category.id };
}

export function loadCategories(locale: Locale, signal?: AbortSignal): Promise<DocumentCategory[]> {
  return fetchOne<DocumentCategory[]>('/medical/document-categories', { locale, ...(signal ? { signal } : {}) });
}

export function createCategory(locale: Locale, body: { name_ar: string; name_en: string; kind: DocumentKind }): Promise<DocumentCategory> {
  return fetchOne<DocumentCategory>('/medical/document-categories', { locale, method: 'POST', body });
}

export function updateCategory(
  locale: Locale,
  id: string,
  body: { name_ar?: string; name_en?: string; archived?: boolean },
): Promise<DocumentCategory> {
  return fetchOne<DocumentCategory>(`/medical/document-categories/${id}`, { locale, method: 'PATCH', body });
}

export function loadDocuments(
  locale: Locale,
  patientId: string,
  filter: { readonly kind: DocumentKind | null; readonly archived: boolean },
  signal?: AbortSignal,
): Promise<DocumentList> {
  return fetchOne<DocumentList>(`/medical/patients/${patientId}/documents`, {
    locale,
    query: { ...(filter.kind ? { kind: filter.kind } : {}), ...(filter.archived ? { archived: 'true' } : {}) },
    ...(signal ? { signal } : {}),
  });
}

export function createDocument(
  locale: Locale,
  patientId: string,
  body: DocumentInput & { readonly patient_file_number: string; readonly title: string; readonly source?: 'upload' | 'camera' },
): Promise<MedicalDocument> {
  return fetchOne<MedicalDocument>(`/medical/patients/${patientId}/documents`, { locale, method: 'POST', body });
}

export function updateDocument(locale: Locale, id: string, body: DocumentInput): Promise<MedicalDocument> {
  return fetchOne<MedicalDocument>(`/medical/documents/${id}`, { locale, method: 'PATCH', body });
}

export function setDocumentArchived(locale: Locale, id: string, archived: boolean): Promise<MedicalDocument> {
  return fetchOne<MedicalDocument>(`/medical/documents/${id}/${archived ? 'archive' : 'restore'}`, { locale, method: 'POST' });
}

export function deleteDocument(locale: Locale, id: string): Promise<void> {
  return sendNoContent(`/medical/documents/${id}`, { locale, method: 'DELETE' });
}

export function uploadDocumentPage(locale: Locale, documentId: string, file: Blob, name: string): Promise<DocumentPage> {
  const form = new FormData();
  form.append('related_type', 'medical_document');
  form.append('related_id', documentId);
  form.append('file', file, name);
  return uploadForm<DocumentPage>('/attachments', form, { locale });
}

/** A page's bytes, for a preview — never a public URL. */
export async function pageBlob(locale: Locale, pageId: string): Promise<Blob> {
  return (await sendRaw(`/attachments/${pageId}`, { locale })).blob();
}

// ---------------------------------------------------------------------------
// Reception (phase C1)
// ---------------------------------------------------------------------------

export function loadQueue(locale: Locale, doctorId: string | null, signal?: AbortSignal): Promise<Queue> {
  return fetchOne<Queue>('/medical/queue', { locale, query: doctorId ? { doctor_id: doctorId } : {}, ...(signal ? { signal } : {}) });
}

export function checkIn(
  locale: Locale,
  body: { readonly patient_id: string; readonly doctor_id: string; readonly visit_id?: string; readonly reason?: string | null },
): Promise<Visit> {
  return fetchOne<Visit>('/medical/queue/check-in', { locale, method: 'POST', body });
}

export function nextPatient(locale: Locale): Promise<Visit | null> {
  return fetchOne<Visit | null>('/medical/queue/next', { locale, method: 'POST', body: {} });
}

export function advanceVisit(locale: Locale, id: string, to: 'start' | 'finish' | 'no-show'): Promise<Visit> {
  return fetchOne<Visit>(`/medical/visits/${id}/${to}`, { locale, method: 'POST' });
}

/**
 * 1to1OS Business — Medical: the shapes the /medical API returns, and the
 * calls the screens make. Every permission shown here is checked again by the
 * API; the screen only decides what to draw.
 */

import type { Locale } from '@ufuq/i18n';

import { fetchMany, fetchOne } from './api-client';
import type { CollectionResult } from './api-client';

export const MEDICAL_PERMISSIONS = [
  'patients.view',
  'patients.manage',
  'visits.view',
  'visits.manage',
  'visits.clinical',
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
  ['visits', ['visits.view', 'visits.manage', 'visits.clinical']],
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

export const VISIT_STATUSES = ['scheduled', 'in_progress', 'completed', 'cancelled'] as const;
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

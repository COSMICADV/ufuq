/**
 * 1to1OS Business — Medical: the permission vocabulary and its defaults.
 *
 * Clinical access is granted to each employee individually (the company's
 * roles are fixed and know nothing clinical). A grant is scoped:
 *   all      → every patient of the company
 *   assigned → the employee's own patients (primary doctor or care team, or
 *              a visit with them as the doctor) and their own visits
 * Nobody but the company admin has any medical access until granted.
 * `visits.clinical` (the clinical notes) is separate from `visits.view` (the
 * schedule), so reception can book visits without reading diagnoses.
 * `queue.manage` checks patients in and gives them their number.
 */

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
export type MedicalPermissionKey = (typeof MEDICAL_PERMISSIONS)[number];
export type MedicalScope = 'all' | 'assigned';

export const CLINICAL_ROLES = ['doctor', 'nurse', 'technician', 'reception', 'finance', 'administration'] as const;
export type ClinicalRoleKey = (typeof CLINICAL_ROLES)[number];

/** Company roles that hold every medical permission over every patient. */
export const MEDICAL_ADMIN_ROLES: readonly string[] = ['admin', 'super_admin'];

/**
 * What the screen proposes when a clinical role is chosen. Only a proposal:
 * the admin sees it, can change it, and nothing is granted until saved.
 * Reception and finance get no clinical notes, documents or imaging.
 */
export const ROLE_PRESETS: Readonly<Record<ClinicalRoleKey, readonly (readonly [MedicalPermissionKey, MedicalScope])[]>> = {
  doctor: [
    ['patients.view', 'assigned'],
    ['patients.manage', 'assigned'],
    ['visits.view', 'assigned'],
    ['visits.manage', 'assigned'],
    ['visits.clinical', 'assigned'],
    ['documents.view', 'assigned'],
    ['documents.upload', 'assigned'],
    ['documents.edit', 'assigned'],
    ['documents.download', 'assigned'],
    ['documents.print', 'assigned'],
    ['imaging.view', 'assigned'],
    ['labs.view', 'assigned'],
  ],
  nurse: [
    ['patients.view', 'assigned'],
    ['visits.view', 'assigned'],
    ['visits.clinical', 'assigned'],
    ['documents.view', 'assigned'],
    ['documents.upload', 'assigned'],
    ['labs.view', 'assigned'],
  ],
  technician: [
    ['patients.view', 'assigned'],
    ['documents.upload', 'assigned'],
    ['imaging.view', 'assigned'],
  ],
  reception: [
    ['patients.view', 'all'],
    ['patients.manage', 'all'],
    ['visits.view', 'all'],
    ['visits.manage', 'all'],
    ['queue.manage', 'all'],
  ],
  finance: [['patients.view', 'all']],
  administration: [['patients.view', 'all']],
};

/** The wider of two scopes. */
export function widest(a: MedicalScope | undefined, b: MedicalScope | undefined): MedicalScope | undefined {
  if (a === 'all' || b === 'all') return 'all';
  return a ?? b;
}

/** The next file number after the highest one seen: P-000001, P-000002, … */
export function nextFileNumber(highest: string | null): string {
  const n = highest ? Number(/(\d+)$/.exec(highest)?.[1] ?? '0') : 0;
  return `P-${String(n + 1).padStart(6, '0')}`;
}

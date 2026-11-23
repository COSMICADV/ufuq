/**
 * Who may do what with which patient — every medical route asks here first,
 * and the answer is enforced in the queries themselves (an "assigned" grant
 * narrows the WHERE clause), never only in the screen.
 */

import type { Prisma, TenantClient } from '@ufuq/db';

import type { AuthContext } from '../auth/auth-context.js';
import { AppException } from '../common/app-exception.js';
import { ERROR_CODES } from '../common/errors.js';
import { notFound } from '../company-structure/tenant-scoped.service.js';

import { MEDICAL_ADMIN_ROLES, MEDICAL_PERMISSIONS } from './medical-rules.js';
import type { MedicalPermissionKey, MedicalScope } from './medical-rules.js';

export interface MedicalAccess {
  readonly enabled: boolean;
  readonly admin: boolean;
  readonly employeeId: string | null;
  readonly grants: ReadonlyMap<MedicalPermissionKey, MedicalScope>;
}

export async function resolveAccess(tx: TenantClient, ctx: AuthContext): Promise<MedicalAccess> {
  const company = await tx.company.findUnique({
    where: { id: ctx.companyId },
    select: { businessActivity: true },
  });
  const enabled = company?.businessActivity === 'medical';
  const admin = MEDICAL_ADMIN_ROLES.includes(ctx.roleKey);
  const grants = new Map<MedicalPermissionKey, MedicalScope>();
  if (enabled && admin) {
    for (const key of MEDICAL_PERMISSIONS) grants.set(key, 'all');
  } else if (enabled && ctx.callerEmployeeId) {
    const rows = await tx.medicalPermission.findMany({ where: { employeeId: ctx.callerEmployeeId } });
    for (const row of rows) {
      if ((MEDICAL_PERMISSIONS as readonly string[]).includes(row.key)) {
        grants.set(row.key as MedicalPermissionKey, row.scope as MedicalScope);
      }
    }
  }
  return { enabled, admin, employeeId: ctx.callerEmployeeId, grants };
}

function forbidden(): AppException {
  return new AppException(ERROR_CODES.FORBIDDEN, 403);
}

/** The scope of a permission, or 403. A company that is not medical answers 404. */
export function requireGrant(access: MedicalAccess, key: MedicalPermissionKey): MedicalScope {
  if (!access.enabled) throw notFound();
  const scope = access.grants.get(key);
  if (!scope) throw forbidden();
  return scope;
}

/** The patients an "assigned" grant reaches: primary doctor, care team, or their doctor in a visit. */
export function assignedPatients(employeeId: string | null): Prisma.PatientWhereInput {
  if (!employeeId) return { id: { in: [] } };
  return {
    OR: [
      { primaryDoctorId: employeeId },
      { careTeam: { some: { employeeId } } },
      { visits: { some: { doctorId: employeeId } } },
    ],
  };
}

export function patientScope(access: MedicalAccess, scope: MedicalScope): Prisma.PatientWhereInput {
  return scope === 'all' ? {} : assignedPatients(access.employeeId);
}

/** The visits an "assigned" grant reaches: their own, or those of their patients. */
export function visitScope(access: MedicalAccess, scope: MedicalScope): Prisma.MedicalVisitWhereInput {
  if (scope === 'all') return {};
  if (!access.employeeId) return { id: { in: [] } };
  return { OR: [{ doctorId: access.employeeId }, { patient: assignedPatients(access.employeeId) }] };
}

/** The patient, if this grant reaches them — else 404 (never "exists but forbidden"). */
export async function reachablePatient(
  tx: TenantClient,
  access: MedicalAccess,
  scope: MedicalScope,
  patientId: string,
): Promise<{ id: string; archivedAt: Date | null }> {
  const row = await tx.patient.findFirst({
    where: { id: patientId, ...patientScope(access, scope) },
    select: { id: true, archivedAt: true },
  });
  if (!row) throw notFound();
  return row;
}

/** Whether a permission reaches this patient (scope "all", or the patient is the employee's own). */
export async function reaches(
  tx: TenantClient,
  access: MedicalAccess,
  key: MedicalPermissionKey,
  patientId: string,
): Promise<boolean> {
  if (!access.enabled) return false;
  const scope = access.grants.get(key);
  if (!scope) return false;
  // Even "all" reaches only a patient of this company (row-level security decides that).
  const row = await tx.patient.findFirst({
    where: { id: patientId, ...(scope === 'all' ? {} : assignedPatients(access.employeeId)) },
    select: { id: true },
  });
  return row !== null;
}

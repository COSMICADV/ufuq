/**
 * 1to1OS Business — Medical, phase M0: the medical team and its permissions,
 * patients, care teams and visits.
 *
 * Every method resolves the caller's medical access first (medical-access.ts)
 * and narrows its queries by it, so an "assigned" doctor's list, search and
 * counts only ever contain their own patients. A patient outside the caller's
 * reach answers 404, the same as one that does not exist.
 *
 * Audit entries name what changed, never the clinical content itself.
 */

import { Inject, Injectable } from '@nestjs/common';
import { generateId } from '@ufuq/db';
import type { Prisma, PrismaClient, TenantClient } from '@ufuq/db';

import { AuditDispatcher } from '../auth/audit-dispatcher.js';
import type { AuthContext } from '../auth/auth-context.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import type { RequestOrigin } from '../common/request-context.js';
import { fieldError, notFound, TenantScopedService } from '../company-structure/tenant-scoped.service.js';

import {
  patientScope,
  reachablePatient,
  reaches,
  requireGrant,
  resolveAccess,
  visitScope,
} from './medical-access.js';
import type { MedicalAccess } from './medical-access.js';
import type { CareTeamDto, CheckInDto, CreatePatientDto, CreateVisitDto, UpdatePatientDto, UpdateStaffDto, UpdateVisitDto } from './medical.dto.js';
import { calendarDateIn, formatCalendarDate, instantAt, parseCalendarDate } from '../attendance/zoned-time.js';
import { MEDICAL_PERMISSIONS, nextFileNumber, ROLE_PRESETS } from './medical-rules.js';
import type { ClinicalRoleKey, MedicalPermissionKey, MedicalScope } from './medical-rules.js';

export interface MedicalMePayload {
  readonly enabled: boolean;
  readonly admin: boolean;
  readonly employee_id: string | null;
  readonly permissions: Readonly<Partial<Record<MedicalPermissionKey, MedicalScope>>>;
}

export interface PersonRef {
  readonly id: string;
  readonly name: string;
  readonly clinical_role: ClinicalRoleKey | null;
  readonly specialty: string | null;
}

export interface StaffPayload extends PersonRef {
  readonly employee_code: string;
  readonly is_admin: boolean;
  readonly permissions: readonly { readonly key: MedicalPermissionKey; readonly scope: MedicalScope }[];
}

export interface StaffListPayload {
  readonly staff: readonly StaffPayload[];
  readonly presets: typeof ROLE_PRESETS;
  readonly permissions: typeof MEDICAL_PERMISSIONS;
}

export interface PatientPayload {
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

export interface PatientDetailPayload extends PatientPayload {
  readonly national_id: string | null;
  readonly notes: string | null;
  readonly care_team: readonly PersonRef[];
  readonly visit_count: number;
  /** What the caller may do with this patient — the server checks again on every call. */
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

export interface VisitPayload {
  readonly id: string;
  readonly patient: { readonly id: string; readonly full_name: string; readonly file_number: string };
  readonly doctor: PersonRef | null;
  readonly visit_at: string;
  readonly reason: string | null;
  /** Absent (not null) when the caller may not read clinical notes. */
  readonly notes?: string | null;
  readonly status: 'scheduled' | 'waiting' | 'in_progress' | 'completed' | 'cancelled' | 'no_show';
  readonly queue_number: number | null;
  readonly checked_in_at: string | null;
  readonly called_at: string | null;
  readonly finished_at: string | null;
}

export interface QueuePayload {
  /** The clinic's calendar day (company time zone). */
  readonly date: string;
  readonly time_zone: string;
  readonly doctors: readonly PersonRef[];
  readonly visits: readonly VisitPayload[];
  readonly can_check_in: boolean;
}

interface EmployeeRow {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly medicalStaff: { readonly clinicalRole: ClinicalRoleKey; readonly specialty: string | null } | null;
}

const PERSON_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  medicalStaff: { select: { clinicalRole: true, specialty: true } },
} as const;

function person(row: EmployeeRow): PersonRef {
  return {
    id: row.id,
    name: `${row.firstName} ${row.lastName}`.trim(),
    clinical_role: row.medicalStaff?.clinicalRole ?? null,
    specialty: row.medicalStaff?.specialty ?? null,
  };
}

function dateOnly(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

const PATIENT_INCLUDE = {
  primaryDoctor: { select: PERSON_SELECT },
  visits: { select: { visitAt: true }, orderBy: { visitAt: 'desc' }, take: 1, where: { status: { not: 'cancelled' } } },
} as const satisfies Prisma.PatientInclude;

type PatientRow = Prisma.PatientGetPayload<{ include: typeof PATIENT_INCLUDE }>;

function patientPayload(row: PatientRow): PatientPayload {
  return {
    id: row.id,
    file_number: row.fileNumber,
    full_name: row.fullName,
    date_of_birth: dateOnly(row.dateOfBirth),
    gender: row.gender,
    phone: row.phone,
    primary_doctor: row.primaryDoctor ? person(row.primaryDoctor) : null,
    archived: row.archivedAt !== null,
    last_visit_at: row.visits[0]?.visitAt.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  };
}

const VISIT_INCLUDE = {
  patient: { select: { id: true, fullName: true, fileNumber: true } },
  doctor: { select: PERSON_SELECT },
} as const satisfies Prisma.MedicalVisitInclude;

type VisitRow = Prisma.MedicalVisitGetPayload<{ include: typeof VISIT_INCLUDE }>;

@Injectable()
export class MedicalService extends TenantScopedService {
  constructor(
    @Inject(PRISMA_CLIENT) prisma: PrismaClient,
    @Inject(AuditDispatcher) private readonly audit: AuditDispatcher,
  ) {
    super(prisma, audit);
  }

  // -------------------------------------------------------------------------
  // Access
  // -------------------------------------------------------------------------

  me(ctx: AuthContext): Promise<MedicalMePayload> {
    return this.tenant(ctx, async (tx) => {
      const access = await resolveAccess(tx, ctx);
      return {
        enabled: access.enabled,
        admin: access.enabled && access.admin,
        employee_id: access.employeeId,
        permissions: Object.fromEntries(access.grants),
      };
    });
  }

  // -------------------------------------------------------------------------
  // The medical team
  // -------------------------------------------------------------------------

  staff(ctx: AuthContext): Promise<StaffListPayload> {
    return this.tenant(ctx, async (tx) => {
      const access = await resolveAccess(tx, ctx);
      requireGrant(access, 'staff.manage');
      const rows = await tx.employee.findMany({
        where: { deletedAt: null, status: 'active' },
        select: {
          ...PERSON_SELECT,
          employeeCode: true,
          medicalPermissions: { select: { key: true, scope: true } },
          user: { select: { role: { select: { key: true } } } },
        },
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      });
      return {
        staff: rows.map((row) => {
          const isAdmin = ['admin', 'super_admin'].includes(row.user?.role.key ?? '');
          return {
            ...person(row),
            employee_code: row.employeeCode,
            is_admin: isAdmin,
            permissions: isAdmin
              ? MEDICAL_PERMISSIONS.map((key) => ({ key, scope: 'all' as const }))
              : row.medicalPermissions
                  .filter((p) => (MEDICAL_PERMISSIONS as readonly string[]).includes(p.key))
                  .map((p) => ({ key: p.key as MedicalPermissionKey, scope: p.scope as MedicalScope })),
          };
        }),
        presets: ROLE_PRESETS,
        permissions: MEDICAL_PERMISSIONS,
      };
    });
  }

  /** The doctors and staff a patient or visit can be assigned to. */
  staffOptions(ctx: AuthContext): Promise<PersonRef[]> {
    return this.tenant(ctx, async (tx) => {
      const access = await resolveAccess(tx, ctx);
      requireGrant(access, 'patients.view');
      const rows = await tx.employee.findMany({
        where: { deletedAt: null, status: 'active', medicalStaff: { isNot: null } },
        select: PERSON_SELECT,
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      });
      return rows.map(person);
    });
  }

  updateStaff(ctx: AuthContext, employeeId: string, dto: UpdateStaffDto, origin: RequestOrigin): Promise<StaffPayload> {
    return this.tenant(ctx, async (tx) => {
      const access = await resolveAccess(tx, ctx);
      requireGrant(access, 'staff.manage');
      const employee = await tx.employee.findFirst({
        where: { id: employeeId, deletedAt: null },
        select: { ...PERSON_SELECT, employeeCode: true, user: { select: { role: { select: { key: true } } } } },
      });
      if (!employee) throw notFound();
      const targetIsAdmin = ['admin', 'super_admin'].includes(employee.user?.role.key ?? '');
      // An admin's access comes from the role and is not edited here; and a
      // non-admin cannot change their own grants or hand out staff.manage.
      if (targetIsAdmin && dto.permissions.length > 0) throw fieldError({ permissions: ['not_allowed'] });
      if (!access.admin && employeeId === access.employeeId) throw fieldError({ employee_id: ['not_allowed'] });
      const keys = new Set<string>();
      for (const grant of dto.permissions) {
        if (keys.has(grant.key)) throw fieldError({ permissions: ['invalid'] });
        keys.add(grant.key);
      }
      const before = await tx.medicalPermission.findMany({ where: { employeeId }, select: { key: true, scope: true } });
      const staffManageChanged =
        before.some((p) => p.key === 'staff.manage') !== keys.has('staff.manage');
      if (!access.admin && staffManageChanged) throw fieldError({ permissions: ['not_allowed'] });
      const grants = dto.clinical_role === null ? [] : dto.permissions;

      if (dto.clinical_role === null) {
        await tx.medicalStaff.deleteMany({ where: { employeeId } });
      } else {
        await tx.medicalStaff.upsert({
          where: { employeeId },
          create: { employeeId, companyId: ctx.companyId, clinicalRole: dto.clinical_role, specialty: dto.specialty ?? null },
          update: { clinicalRole: dto.clinical_role, ...(dto.specialty !== undefined ? { specialty: dto.specialty } : {}) },
        });
      }
      await tx.medicalPermission.deleteMany({ where: { employeeId } });
      if (grants.length > 0) {
        await tx.medicalPermission.createMany({
          data: grants.map((g) => ({ companyId: ctx.companyId, employeeId, key: g.key, scope: g.scope, grantedBy: ctx.userId })),
        });
      }
      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'MEDICAL_PERMISSIONS_CHANGED',
        entityType: 'employee',
        entityId: employeeId,
        oldValues: { permissions: before.map((p) => `${p.key}:${p.scope}`).sort() },
        newValues: {
          clinical_role: dto.clinical_role,
          permissions: grants.map((g) => `${g.key}:${g.scope}`).sort(),
        },
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });
      const role = dto.clinical_role;
      return {
        id: employee.id,
        name: `${employee.firstName} ${employee.lastName}`.trim(),
        clinical_role: role,
        specialty: role === null ? null : dto.specialty !== undefined ? dto.specialty : (employee.medicalStaff?.specialty ?? null),
        employee_code: employee.employeeCode,
        is_admin: targetIsAdmin,
        permissions: targetIsAdmin ? MEDICAL_PERMISSIONS.map((key) => ({ key, scope: 'all' as const })) : grants,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Patients
  // -------------------------------------------------------------------------

  patients(
    ctx: AuthContext,
    query: { readonly q?: string; readonly archived?: boolean; readonly mine?: boolean; readonly skip: number; readonly take: number },
  ): Promise<{ items: PatientPayload[]; total: number }> {
    return this.tenant(ctx, async (tx) => {
      const access = await resolveAccess(tx, ctx);
      const scope = requireGrant(access, 'patients.view');
      const term = query.q?.trim();
      const where: Prisma.PatientWhereInput = {
        AND: [
          patientScope(access, scope),
          query.mine ? patientScope(access, 'assigned') : {},
          { archivedAt: query.archived ? { not: null } : null },
          term
            ? {
                OR: [
                  { fullName: { contains: term, mode: 'insensitive' } },
                  { fileNumber: { contains: term, mode: 'insensitive' } },
                  { phone: { contains: term } },
                  { nationalId: { contains: term } },
                ],
              }
            : {},
        ],
      };
      const [rows, total] = await Promise.all([
        tx.patient.findMany({ where, include: PATIENT_INCLUDE, orderBy: { createdAt: 'desc' }, skip: query.skip, take: query.take }),
        tx.patient.count({ where }),
      ]);
      return { items: rows.map(patientPayload), total };
    });
  }

  patient(ctx: AuthContext, id: string): Promise<PatientDetailPayload> {
    return this.tenant(ctx, async (tx) => {
      const access = await resolveAccess(tx, ctx);
      const scope = requireGrant(access, 'patients.view');
      await reachablePatient(tx, access, scope, id);
      return this.detail(tx, access, id);
    });
  }

  createPatient(ctx: AuthContext, dto: CreatePatientDto, origin: RequestOrigin): Promise<PatientDetailPayload> {
    return this.tenant(ctx, async (tx) => {
      const access = await resolveAccess(tx, ctx);
      const scope = requireGrant(access, 'patients.manage');
      if (scope !== 'all' && (dto.primary_doctor_id ?? null) !== null && dto.primary_doctor_id !== access.employeeId) {
        throw fieldError({ primary_doctor_id: ['not_allowed'] });
      }
      if (dto.primary_doctor_id) await this.requireStaff(tx, dto.primary_doctor_id, 'primary_doctor_id');
      const id = generateId();
      // One registration at a time per company, so two receptionists never take the same file number.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`patient-file:${ctx.companyId}`}, 0))`;
      const highest = await tx.patient.findFirst({ orderBy: { fileNumber: 'desc' }, select: { fileNumber: true } });
      await tx.patient.create({
        data: {
          id,
          companyId: ctx.companyId,
          fileNumber: nextFileNumber(highest?.fileNumber ?? null),
          fullName: dto.full_name,
          dateOfBirth: dto.date_of_birth ? new Date(`${dto.date_of_birth}T00:00:00Z`) : null,
          gender: dto.gender ?? null,
          phone: dto.phone || null,
          nationalId: dto.national_id || null,
          notes: dto.notes || null,
          primaryDoctorId: dto.primary_doctor_id ?? null,
          createdBy: ctx.userId,
        },
      });
      // An "assigned" creator joins the care team, or they could not open the file they just made.
      if (scope !== 'all' && access.employeeId && dto.primary_doctor_id !== access.employeeId) {
        await tx.patientCareTeam.create({ data: { patientId: id, employeeId: access.employeeId, companyId: ctx.companyId } });
      }
      const created = await tx.patient.findUniqueOrThrow({ where: { id }, select: { fileNumber: true } });
      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'PATIENT_CREATED',
        entityType: 'patient',
        entityId: id,
        newValues: { file_number: created.fileNumber },
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });
      return this.detail(tx, access, id);
    });
  }

  updatePatient(ctx: AuthContext, id: string, dto: UpdatePatientDto, origin: RequestOrigin): Promise<PatientDetailPayload> {
    return this.tenant(ctx, async (tx) => {
      const access = await resolveAccess(tx, ctx);
      const scope = requireGrant(access, 'patients.manage');
      const current = await reachablePatient(tx, access, scope, id);
      if (current.archivedAt) throw fieldError({ patient: ['not_active'] });
      const data: Prisma.PatientUpdateInput = {};
      const changed: string[] = [];
      const set = <K extends keyof Prisma.PatientUpdateInput>(field: string, key: K, value: Prisma.PatientUpdateInput[K]): void => {
        data[key] = value;
        changed.push(field);
      };
      if (dto.full_name !== undefined) set('full_name', 'fullName', dto.full_name);
      if (dto.date_of_birth !== undefined) {
        set('date_of_birth', 'dateOfBirth', dto.date_of_birth ? new Date(`${dto.date_of_birth}T00:00:00Z`) : null);
      }
      if (dto.gender !== undefined) set('gender', 'gender', dto.gender);
      if (dto.phone !== undefined) set('phone', 'phone', dto.phone || null);
      if (dto.national_id !== undefined) set('national_id', 'nationalId', dto.national_id || null);
      if (dto.notes !== undefined) set('notes', 'notes', dto.notes || null);
      if (dto.primary_doctor_id !== undefined) {
        // Who the primary doctor is decides who can reach the file: only an "all" manager changes it.
        if (scope !== 'all') throw fieldError({ primary_doctor_id: ['not_allowed'] });
        if (dto.primary_doctor_id !== null) await this.requireStaff(tx, dto.primary_doctor_id, 'primary_doctor_id');
        set(
          'primary_doctor_id',
          'primaryDoctor',
          dto.primary_doctor_id === null ? { disconnect: true } : { connect: { id: dto.primary_doctor_id } },
        );
      }
      if (changed.length > 0) {
        await tx.patient.update({ where: { id }, data });
        await this.audit.record(tx, {
          companyId: ctx.companyId,
          userId: ctx.userId,
          action: 'PATIENT_UPDATED',
          entityType: 'patient',
          entityId: id,
          newValues: { fields: changed },
          ipAddress: origin.ipAddress,
          userAgent: origin.userAgent,
        });
      }
      return this.detail(tx, access, id);
    });
  }

  setArchived(ctx: AuthContext, id: string, archived: boolean, origin: RequestOrigin): Promise<PatientDetailPayload> {
    return this.tenant(ctx, async (tx) => {
      const access = await resolveAccess(tx, ctx);
      const scope = requireGrant(access, 'patients.manage');
      const current = await reachablePatient(tx, access, scope, id);
      if ((current.archivedAt !== null) !== archived) {
        await tx.patient.update({ where: { id }, data: { archivedAt: archived ? new Date() : null } });
        await this.audit.record(tx, {
          companyId: ctx.companyId,
          userId: ctx.userId,
          action: archived ? 'PATIENT_ARCHIVED' : 'PATIENT_UPDATED',
          entityType: 'patient',
          entityId: id,
          newValues: { archived },
          ipAddress: origin.ipAddress,
          userAgent: origin.userAgent,
        });
      }
      return this.detail(tx, access, id);
    });
  }

  setCareTeam(ctx: AuthContext, id: string, dto: CareTeamDto, origin: RequestOrigin): Promise<PatientDetailPayload> {
    return this.tenant(ctx, async (tx) => {
      const access = await resolveAccess(tx, ctx);
      // The care team decides who reaches the file: an "all" manager only.
      const scope = requireGrant(access, 'patients.manage');
      if (scope !== 'all') throw fieldError({ employee_ids: ['not_allowed'] });
      await reachablePatient(tx, access, scope, id);
      const ids = [...new Set(dto.employee_ids)];
      for (const employeeId of ids) await this.requireStaff(tx, employeeId, 'employee_ids');
      const before = await tx.patientCareTeam.findMany({ where: { patientId: id }, select: { employeeId: true } });
      await tx.patientCareTeam.deleteMany({ where: { patientId: id } });
      if (ids.length > 0) {
        await tx.patientCareTeam.createMany({
          data: ids.map((employeeId) => ({ patientId: id, employeeId, companyId: ctx.companyId })),
        });
      }
      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'PATIENT_UPDATED',
        entityType: 'patient',
        entityId: id,
        oldValues: { care_team: before.map((r) => r.employeeId).sort() },
        newValues: { care_team: [...ids].sort() },
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });
      return this.detail(tx, access, id);
    });
  }

  // -------------------------------------------------------------------------
  // Visits
  // -------------------------------------------------------------------------

  patientVisits(ctx: AuthContext, patientId: string): Promise<VisitPayload[]> {
    return this.tenant(ctx, async (tx) => {
      const access = await resolveAccess(tx, ctx);
      const scope = requireGrant(access, 'visits.view');
      await reachablePatient(tx, access, scope, patientId);
      const rows = await tx.medicalVisit.findMany({
        where: { patientId, ...visitScope(access, scope) },
        include: VISIT_INCLUDE,
        orderBy: { visitAt: 'desc' },
        take: 200,
      });
      return Promise.all(rows.map((row) => this.visitPayload(tx, access, row)));
    });
  }

  visits(ctx: AuthContext, from: Date, to: Date, mine: boolean): Promise<VisitPayload[]> {
    return this.tenant(ctx, async (tx) => {
      const access = await resolveAccess(tx, ctx);
      const scope = requireGrant(access, 'visits.view');
      if (!(to > from) || to.getTime() - from.getTime() > 62 * 86_400_000) throw fieldError({ to: ['invalid'] });
      const rows = await tx.medicalVisit.findMany({
        where: {
          AND: [
            visitScope(access, scope),
            mine && access.employeeId ? { doctorId: access.employeeId } : {},
            { visitAt: { gte: from, lt: to } },
          ],
        },
        include: VISIT_INCLUDE,
        orderBy: { visitAt: 'asc' },
        take: 500,
      });
      return Promise.all(rows.map((row) => this.visitPayload(tx, access, row)));
    });
  }

  createVisit(ctx: AuthContext, patientId: string, dto: CreateVisitDto, origin: RequestOrigin): Promise<VisitPayload> {
    return this.tenant(ctx, async (tx) => {
      const access = await resolveAccess(tx, ctx);
      const scope = requireGrant(access, 'visits.manage');
      const patient = await reachablePatient(tx, access, scope, patientId);
      if (patient.archivedAt) throw fieldError({ patient: ['not_active'] });
      if ((dto.notes ?? null) !== null && !(await this.reachesClinical(tx, access, patientId))) throw fieldError({ notes: ['not_allowed'] });
      if (dto.doctor_id) await this.requireStaff(tx, dto.doctor_id, 'doctor_id');
      const id = generateId();
      const row = await tx.medicalVisit.create({
        data: {
          id,
          companyId: ctx.companyId,
          patientId,
          doctorId: dto.doctor_id ?? null,
          visitAt: new Date(dto.visit_at),
          reason: dto.reason || null,
          notes: dto.notes || null,
          status: dto.status ?? 'scheduled',
          createdBy: ctx.userId,
        },
        include: VISIT_INCLUDE,
      });
      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'MEDICAL_VISIT_CREATED',
        entityType: 'medical_visit',
        entityId: id,
        newValues: { patient_id: patientId, status: row.status },
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });
      return this.visitPayload(tx, access, row);
    });
  }

  updateVisit(ctx: AuthContext, id: string, dto: UpdateVisitDto, origin: RequestOrigin): Promise<VisitPayload> {
    return this.tenant(ctx, async (tx) => {
      const access = await resolveAccess(tx, ctx);
      const scope = requireGrant(access, 'visits.manage');
      const current = await tx.medicalVisit.findFirst({ where: { id, ...visitScope(access, scope) }, select: { patientId: true } });
      if (!current) throw notFound();
      if (dto.notes !== undefined && !(await this.reachesClinical(tx, access, current.patientId))) {
        throw fieldError({ notes: ['not_allowed'] });
      }
      if (dto.doctor_id) await this.requireStaff(tx, dto.doctor_id, 'doctor_id');
      const data: Prisma.MedicalVisitUpdateInput = {};
      const changed: string[] = [];
      if (dto.visit_at !== undefined) { data.visitAt = new Date(dto.visit_at); changed.push('visit_at'); }
      if (dto.reason !== undefined) { data.reason = dto.reason || null; changed.push('reason'); }
      if (dto.notes !== undefined) { data.notes = dto.notes || null; changed.push('notes'); }
      if (dto.status !== undefined) { data.status = dto.status; changed.push('status'); }
      if (dto.doctor_id !== undefined) {
        data.doctor = dto.doctor_id === null ? { disconnect: true } : { connect: { id: dto.doctor_id } };
        changed.push('doctor_id');
      }
      const row = await tx.medicalVisit.update({ where: { id }, data, include: VISIT_INCLUDE });
      if (changed.length > 0) {
        await this.audit.record(tx, {
          companyId: ctx.companyId,
          userId: ctx.userId,
          action: 'MEDICAL_VISIT_UPDATED',
          entityType: 'medical_visit',
          entityId: id,
          newValues: { fields: changed, status: row.status },
          ipAddress: origin.ipAddress,
          userAgent: origin.userAgent,
        });
      }
      return this.visitPayload(tx, access, row);
    });
  }


  // -------------------------------------------------------------------------
  // Reception: the day's queue (phase C1)
  // -------------------------------------------------------------------------

  /** The day's queue: checked-in patients by number, plus that day's appointments. */
  queue(ctx: AuthContext, date: string | undefined, doctorId: string | undefined): Promise<QueuePayload> {
    return this.tenant(ctx, async (tx) => {
      const access = await resolveAccess(tx, ctx);
      const scope = requireGrant(access, 'visits.view');
      const timeZone = await this.timeZone(tx, ctx);
      const day = date ? parseCalendarDate(date) : calendarDateIn(new Date(), timeZone);
      if (!day) throw fieldError({ date: ['invalid'] });
      const iso = formatCalendarDate(day);
      const start = instantAt(day, 0, timeZone);
      const end = instantAt(day, 24 * 60, timeZone);
      // An "own patients" doctor's queue is theirs alone, whoever else their patients see.
      const whose = scope === 'all' ? doctorId : (access.employeeId ?? '00000000-0000-0000-0000-000000000000');
      const rows = await tx.medicalVisit.findMany({
        where: {
          AND: [
            visitScope(access, scope),
            whose ? { doctorId: whose } : {},
            {
              OR: [
                { queueDate: new Date(`${iso}T00:00:00Z`) },
                { queueNumber: null, status: 'scheduled', visitAt: { gte: start, lt: end } },
              ],
            },
          ],
        },
        include: VISIT_INCLUDE,
        orderBy: [{ queueNumber: { sort: 'asc', nulls: 'last' } }, { visitAt: 'asc' }],
        take: 500,
      });
      const doctors = await tx.employee.findMany({
        where: { deletedAt: null, status: 'active', medicalStaff: { is: { clinicalRole: 'doctor' } } },
        select: PERSON_SELECT,
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      });
      return {
        date: iso,
        time_zone: timeZone,
        doctors: doctors.map(person),
        visits: await Promise.all(rows.map((row) => this.visitPayload(tx, access, row))),
        can_check_in: access.grants.has('queue.manage'),
      };
    });
  }

  /** Check a patient in for a doctor: the next number in that doctor's queue today. */
  checkIn(ctx: AuthContext, dto: CheckInDto, origin: RequestOrigin): Promise<VisitPayload> {
    return this.tenant(ctx, async (tx) => {
      const access = await resolveAccess(tx, ctx);
      requireGrant(access, 'queue.manage');
      const scope = requireGrant(access, 'patients.view');
      const patient = await reachablePatient(tx, access, scope, dto.patient_id);
      if (patient.archivedAt) throw fieldError({ patient: ['not_active'] });
      await this.requireStaff(tx, dto.doctor_id, 'doctor_id');
      const timeZone = await this.timeZone(tx, ctx);
      const now = new Date();
      const queueDate = new Date(`${formatCalendarDate(calendarDateIn(now, timeZone))}T00:00:00Z`);
      if (dto.visit_id) {
        const visit = await tx.medicalVisit.findFirst({ where: { id: dto.visit_id, patientId: dto.patient_id }, select: { status: true } });
        if (!visit) throw fieldError({ visit_id: ['not_found'] });
        if (visit.status !== 'scheduled') throw fieldError({ visit_id: ['not_active'] });
      }
      const already = await tx.medicalVisit.findFirst({
        where: { patientId: dto.patient_id, doctorId: dto.doctor_id, queueDate, status: { in: ['waiting', 'in_progress'] } },
        select: { id: true },
      });
      if (already) throw fieldError({ patient_id: ['already_taken'] });
      // One check-in at a time per doctor and day, so two receptionists never take the same number.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`queue:${ctx.companyId}:${dto.doctor_id}:${queueDate.toISOString()}`}, 0))`;
      const last = await tx.medicalVisit.aggregate({ where: { doctorId: dto.doctor_id, queueDate }, _max: { queueNumber: true } });
      const queueNumber = (last._max.queueNumber ?? 0) + 1;
      const fields = {
        doctorId: dto.doctor_id,
        status: 'waiting' as const,
        queueDate,
        queueNumber,
        checkedInAt: now,
        ...(dto.reason !== undefined ? { reason: dto.reason || null } : {}),
      };
      const row = dto.visit_id
        ? await tx.medicalVisit.update({ where: { id: dto.visit_id }, data: fields, include: VISIT_INCLUDE })
        : await tx.medicalVisit.create({
            data: { id: generateId(), companyId: ctx.companyId, patientId: dto.patient_id, visitAt: now, createdBy: ctx.userId, ...fields },
            include: VISIT_INCLUDE,
          });
      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'MEDICAL_VISIT_CHECKED_IN',
        entityType: 'medical_visit',
        entityId: row.id,
        newValues: { patient_id: dto.patient_id, doctor_id: dto.doctor_id, queue_number: queueNumber },
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });
      return this.visitPayload(tx, access, row);
    });
  }

  /** Move a visit along the queue: waiting → in_progress → completed, or → no_show. */
  advance(ctx: AuthContext, id: string, to: 'in_progress' | 'completed' | 'no_show', origin: RequestOrigin): Promise<VisitPayload> {
    return this.tenant(ctx, async (tx) => {
      const access = await resolveAccess(tx, ctx);
      const scope = requireGrant(access, 'visits.manage');
      const current = await tx.medicalVisit.findFirst({ where: { id, ...visitScope(access, scope) }, select: { status: true } });
      if (!current) throw notFound();
      const allowed: Readonly<Record<typeof to, readonly string[]>> = {
        in_progress: ['waiting', 'scheduled'],
        completed: ['in_progress', 'waiting'],
        no_show: ['waiting', 'scheduled'],
      };
      if (!allowed[to].includes(current.status)) throw fieldError({ status: ['invalid'] });
      const now = new Date();
      const row = await tx.medicalVisit.update({
        where: { id },
        data: {
          status: to,
          ...(to === 'in_progress' ? { calledAt: now } : {}),
          ...(to === 'completed' ? { finishedAt: now } : {}),
        },
        include: VISIT_INCLUDE,
      });
      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'MEDICAL_VISIT_UPDATED',
        entityType: 'medical_visit',
        entityId: id,
        newValues: { fields: ['status'], status: to },
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });
      return this.visitPayload(tx, access, row);
    });
  }

  /** The doctor calls the next waiting patient (lowest number today) — or null when nobody waits. */
  next(ctx: AuthContext, doctorId: string | undefined, origin: RequestOrigin): Promise<VisitPayload | null> {
    return this.tenant(ctx, async (tx) => {
      const access = await resolveAccess(tx, ctx);
      const scope = requireGrant(access, 'visits.manage');
      const doctor = doctorId ?? access.employeeId;
      if (!doctor) throw fieldError({ doctor_id: ['required'] });
      if (scope !== 'all' && doctor !== access.employeeId) throw fieldError({ doctor_id: ['not_allowed'] });
      const timeZone = await this.timeZone(tx, ctx);
      const queueDate = new Date(`${formatCalendarDate(calendarDateIn(new Date(), timeZone))}T00:00:00Z`);
      const waiting = await tx.medicalVisit.findFirst({
        where: { doctorId: doctor, queueDate, status: 'waiting' },
        orderBy: { queueNumber: 'asc' },
        select: { id: true },
      });
      return waiting ? { id: waiting.id } : null;
    }).then((found) => (found ? this.advance(ctx, found.id, 'in_progress', origin) : null));
  }

  private async timeZone(tx: TenantClient, ctx: AuthContext): Promise<string> {
    const company = await tx.company.findUnique({ where: { id: ctx.companyId }, select: { timezone: true } });
    return company?.timezone ?? 'Africa/Cairo';
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** An active member of the medical team — a doctor, for the primary doctor and a visit's doctor. */
  private async requireStaff(tx: TenantClient, employeeId: string, field: string): Promise<void> {
    const doctorOnly = field === 'primary_doctor_id' || field === 'doctor_id';
    const row = await tx.employee.findFirst({
      where: {
        id: employeeId,
        deletedAt: null,
        status: 'active',
        medicalStaff: doctorOnly ? { is: { clinicalRole: 'doctor' } } : { isNot: null },
      },
      select: { id: true },
    });
    if (!row) throw fieldError({ [field]: ['not_found'] });
  }

  private reaches(tx: TenantClient, access: MedicalAccess, key: MedicalPermissionKey, patientId: string): Promise<boolean> {
    return reaches(tx, access, key, patientId);
  }

  private reachesClinical(tx: TenantClient, access: MedicalAccess, patientId: string): Promise<boolean> {
    return this.reaches(tx, access, 'visits.clinical', patientId);
  }

  private async visitPayload(tx: TenantClient, access: MedicalAccess, row: VisitRow): Promise<VisitPayload> {
    const base: VisitPayload = {
      id: row.id,
      patient: { id: row.patient.id, full_name: row.patient.fullName, file_number: row.patient.fileNumber },
      doctor: row.doctor ? person(row.doctor) : null,
      visit_at: row.visitAt.toISOString(),
      reason: row.reason,
      status: row.status,
      queue_number: row.queueNumber,
      checked_in_at: row.checkedInAt?.toISOString() ?? null,
      called_at: row.calledAt?.toISOString() ?? null,
      finished_at: row.finishedAt?.toISOString() ?? null,
    };
    const clinical = await this.reachesClinical(tx, access, row.patientId);
    return clinical ? { ...base, notes: row.notes } : base;
  }

  private async detail(tx: TenantClient, access: MedicalAccess, id: string): Promise<PatientDetailPayload> {
    const row = await tx.patient.findUniqueOrThrow({
      where: { id },
      include: {
        ...PATIENT_INCLUDE,
        careTeam: { include: { employee: { select: PERSON_SELECT } }, orderBy: { createdAt: 'asc' } },
        _count: { select: { visits: true } },
      },
    });
    const [manage, viewVisits, manageVisits, clinical, documents, labs, imaging, upload] = await Promise.all([
      this.reaches(tx, access, 'patients.manage', id),
      this.reaches(tx, access, 'visits.view', id),
      this.reaches(tx, access, 'visits.manage', id),
      this.reaches(tx, access, 'visits.clinical', id),
      this.reaches(tx, access, 'documents.view', id),
      this.reaches(tx, access, 'labs.view', id),
      this.reaches(tx, access, 'imaging.view', id),
      this.reaches(tx, access, 'documents.upload', id),
    ]);
    return {
      ...patientPayload(row),
      national_id: row.nationalId,
      notes: row.notes,
      care_team: row.careTeam.map((member) => person(member.employee)),
      visit_count: row._count.visits,
      can: {
        manage,
        assign: access.grants.get('patients.manage') === 'all',
        view_visits: viewVisits,
        manage_visits: manageVisits,
        clinical,
        documents,
        labs,
        imaging,
        upload_documents: upload,
      },
    };
  }
}

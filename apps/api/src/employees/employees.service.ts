/**
 * Employees — DOCUMENT 25 Phase 5, DOCUMENT 08 §4.3, DOCUMENT 05 FLOW 02/03,
 * DOCUMENT 09 §6.
 *
 * The rules that carry the weight:
 *
 *   - **Creation is one transaction** (DOCUMENT 06 §8): the login user
 *     (status `invited`, no password) and the employee are written together,
 *     with the invitation when one is requested. Salary and leave balances
 *     join this transaction in Phases 11 and 10 (approved decision).
 *   - **References are checked before anything else** (DOCUMENT 08 §5.3), and
 *     another company's id fails exactly like a fictional one: row-level
 *     security has already hidden it. The same-company triggers in the Phase 5
 *     migration are the backstop if a check here is ever forgotten.
 *   - **Scope** (DOCUMENT 09 §4): a path id outside the tenant is 404; inside
 *     the tenant but outside the caller's scope is 403.
 *   - **Manager cycles** are refused by walking the chain (DOCUMENT 06 §3.6).
 *   - **The last active ADMIN** cannot be deactivated or demoted (DOCUMENT 02
 *     §7, DOCUMENT 09 §6). The admin rows are locked while that is checked, so
 *     two admins demoting each other at once cannot both succeed.
 *   - **Deactivation** revokes every session and any outstanding invitation in
 *     the same transaction (DOCUMENT 09 §6). **Reactivation** of an account
 *     that never set a password issues a fresh invitation.
 *   - **Email is delivered after commit.** Holding a database transaction
 *     open across an SMTP conversation is how a slow relay becomes a pool of
 *     stuck connections. A failed delivery never undoes the change it followed:
 *     creation reports it in `meta`, and a resend reports it as 503.
 *
 * Audit records (DOCUMENT 21 "Employees") are written inside the transaction
 * of the change they describe, so a rolled-back change leaves none;
 * `invitation.sent` is written only once the relay has accepted the message,
 * because until then nothing was sent.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AssignableRoleKey } from '@ufuq/auth';
import { generateId } from '@ufuq/db';
import type { AuditAction, Prisma, PrismaClient, Role, TenantClient } from '@ufuq/db';
import { DEFAULT_LOCALE, isLocale } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { AuditService } from '../auth/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { InvitationService } from '../auth/invitation.service.js';
import { SessionService } from '../auth/session.service.js';
import { AppException } from '../common/app-exception.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import { ERROR_CODES } from '../common/errors.js';
import type { RequestOrigin } from '../common/request-context.js';
import { resolvePage } from '../company-structure/dto/pagination.dto.js';
import {
  conflict,
  fieldError,
  isUniqueViolation,
  notFound,
  TenantScopedService,
} from '../company-structure/tenant-scoped.service.js';
import type { FieldIssue } from '../company-structure/tenant-scoped.service.js';
import { parseCalendarDate } from '../company-structure/validation.js';
import { InvitationMailer } from '../mail/invitation-mailer.js';
import type { InvitationDelivery } from '../mail/invitation-mailer.js';

import type {
  CreateEmployeeDto,
  DeactivateEmployeeDto,
  ListEmployeesQueryDto,
  UpdateEmployeeDto,
} from './dto/employee.dto.js';
import {
  diffSnapshots,
  EMPLOYEE_INCLUDE,
  employeeAuditSnapshot,
  employeePayload,
} from './employee-payload.js';
import type { EmployeePayload, EmployeeRow } from './employee-payload.js';
import { employeeScopeWhere, forbidden, listWhere, orderByFor } from './employee-query.js';

/** What happened to the invitation email a write asked for. */
export type InvitationDeliveryOutcome = 'sent' | 'failed' | 'not_requested';

export interface EmployeeWriteResult {
  readonly employee: EmployeePayload;
  readonly invitationDelivery: InvitationDeliveryOutcome;
}

export interface EmployeeList {
  readonly items: readonly EmployeePayload[];
  readonly total: number;
}

/** An issued invitation waiting for its transaction to commit before it is emailed. */
interface PendingInvitation {
  readonly userId: string;
  readonly delivery: InvitationDelivery;
}

/** Fields whose changes are audited as `employee.updated`; the rest have their own action. */
const GENERAL_FIELDS = [
  'employee_code',
  'first_name',
  'last_name',
  'email',
  'phone',
  'position_id',
  'work_schedule_id',
  'joining_date',
] as const;

@Injectable()
export class EmployeesService extends TenantScopedService {
  private readonly logger = new Logger(EmployeesService.name);

  constructor(
    @Inject(PRISMA_CLIENT) prisma: PrismaClient,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(InvitationService) private readonly invitations: InvitationService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(InvitationMailer) private readonly mailer: InvitationMailer,
  ) {
    super(prisma);
  }

  // -- Reads -----------------------------------------------------------------

  async list(
    ctx: AuthContext,
    query: ListEmployeesQueryDto,
    locale: Locale,
  ): Promise<EmployeeList> {
    const page = resolvePage(query);
    const where = listWhere(ctx, query);
    return this.tenant(ctx, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.employee.findMany({
          where,
          include: EMPLOYEE_INCLUDE,
          orderBy: orderByFor(query.sort ?? 'name', query.order ?? 'asc', locale),
          skip: page.skip,
          take: page.take,
        }),
        tx.employee.count({ where }),
      ]);
      return { items: rows.map(employeePayload), total };
    });
  }

  async get(ctx: AuthContext, id: string): Promise<EmployeePayload> {
    return this.tenant(ctx, async (tx) =>
      employeePayload(await this.loadScoped(tx, ctx, id, 'employee.view')),
    );
  }

  // -- Create — FLOW 02 ------------------------------------------------------

  async create(
    ctx: AuthContext,
    dto: CreateEmployeeDto,
    origin: RequestOrigin,
  ): Promise<EmployeeWriteResult> {
    const joiningDate = requireDate(dto.joining_date);
    if ((dto.manager_id ?? null) !== null && !ctx.permissions.has('employee.assign_manager')) {
      throw forbidden();
    }

    const { row, pending } = await this.tenant(ctx, async (tx) => {
      await this.assertReferences(tx, {
        department_id: dto.department_id ?? null,
        position_id: dto.position_id ?? null,
        manager_id: dto.manager_id ?? null,
        work_schedule_id: dto.work_schedule_id,
      });
      await this.assertUnique(tx, { email: dto.email, employee_code: dto.employee_code }, null);
      const role = await this.requireRole(tx, dto.role_key);

      const userId = generateId();
      const employeeId = generateId();
      let created: EmployeeRow;
      try {
        await tx.user.create({
          data: {
            id: userId,
            companyId: ctx.companyId,
            email: dto.email,
            passwordHash: null,
            roleId: role.id,
            status: 'invited',
            createdBy: ctx.userId,
          },
        });
        created = await tx.employee.create({
          data: {
            id: employeeId,
            companyId: ctx.companyId,
            userId,
            employeeCode: dto.employee_code,
            firstName: dto.first_name,
            lastName: dto.last_name,
            email: dto.email,
            phone: dto.phone ?? null,
            departmentId: dto.department_id ?? null,
            positionId: dto.position_id ?? null,
            managerId: dto.manager_id ?? null,
            workScheduleId: dto.work_schedule_id,
            joiningDate,
            createdBy: ctx.userId,
          },
          include: EMPLOYEE_INCLUDE,
        });
      } catch (error) {
        throw translateWriteError(error);
      }

      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'EMPLOYEE_CREATED',
        entityType: 'employee',
        entityId: employeeId,
        newValues: { ...employeeAuditSnapshot(created), role_key: dto.role_key },
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });

      const pending = dto.send_invitation ? await this.prepareInvitation(tx, ctx, created) : null;
      return { row: await this.reload(tx, employeeId), pending };
    });

    const invitationDelivery = pending ? await this.deliver(ctx, pending, origin) : 'not_requested';
    return { employee: employeePayload(row), invitationDelivery };
  }

  // -- Update ----------------------------------------------------------------

  async update(
    ctx: AuthContext,
    id: string,
    dto: UpdateEmployeeDto,
    origin: RequestOrigin,
  ): Promise<EmployeePayload> {
    const joiningDate = dto.joining_date === undefined ? undefined : requireDate(dto.joining_date);
    // DOCUMENT 02 §4 gives manager assignment its own permission. In V1 only
    // ADMIN holds either, but the check is on the permission, not the role.
    if (dto.manager_id !== undefined && !ctx.permissions.has('employee.assign_manager')) {
      throw forbidden();
    }

    return this.tenant(ctx, async (tx) => {
      const before = await this.loadForWrite(tx, ctx, id, 'employee.update');

      await this.assertReferences(tx, {
        department_id: dto.department_id ?? null,
        position_id: dto.position_id ?? null,
        manager_id: dto.manager_id ?? null,
        work_schedule_id: dto.work_schedule_id ?? null,
      });
      const proposedManagerId = dto.manager_id ?? null;
      if (proposedManagerId !== null && proposedManagerId !== before.managerId) {
        await this.rejectManagerCycle(tx, before.id, proposedManagerId);
      }
      await this.assertUnique(
        tx,
        {
          email: dto.email !== undefined && dto.email !== before.email ? dto.email : undefined,
          employee_code:
            dto.employee_code !== undefined && dto.employee_code !== before.employeeCode
              ? dto.employee_code
              : undefined,
        },
        before,
      );

      const data: Prisma.EmployeeUncheckedUpdateInput = {
        ...(dto.first_name === undefined ? {} : { firstName: dto.first_name }),
        ...(dto.last_name === undefined ? {} : { lastName: dto.last_name }),
        ...(dto.email === undefined ? {} : { email: dto.email }),
        ...(dto.phone === undefined ? {} : { phone: dto.phone }),
        ...(dto.employee_code === undefined ? {} : { employeeCode: dto.employee_code }),
        ...(dto.department_id === undefined ? {} : { departmentId: dto.department_id }),
        ...(dto.position_id === undefined ? {} : { positionId: dto.position_id }),
        ...(dto.manager_id === undefined ? {} : { managerId: dto.manager_id }),
        ...(dto.work_schedule_id === undefined ? {} : { workScheduleId: dto.work_schedule_id }),
        ...(joiningDate === undefined ? {} : { joiningDate }),
      };

      // The login email follows the employee's: it is the address the
      // invitation went to and the one the person signs in with, and two
      // diverging copies of "this person's email" would be a defect waiting.
      let roleChange: { readonly from: string; readonly to: AssignableRoleKey } | null = null;
      let revokedSessions = 0;
      try {
        if (dto.email !== undefined && before.user && dto.email !== before.user.email) {
          await tx.user.update({ where: { id: before.user.id }, data: { email: dto.email } });
        }
        if (dto.role_key !== undefined) {
          if (!before.user) {
            throw fieldError({ role_key: ['invalid'] });
          }
          if (before.user.role.key !== dto.role_key) {
            if (before.user.role.key === 'admin' && before.user.status === 'active') {
              await this.assertAnotherActiveAdmin(tx, before.user.id);
            }
            const role = await this.requireRole(tx, dto.role_key);
            await tx.user.update({ where: { id: before.user.id }, data: { roleId: role.id } });
            // DOCUMENT 09 §3: a role change invalidates sessions, so the new
            // permissions apply from the next sign-in, not from whenever an
            // old session happens to expire.
            revokedSessions = await this.sessions.revokeAllForUserIn(tx, before.user.id);
            roleChange = { from: before.user.role.key, to: dto.role_key };
          }
        }
        if (Object.keys(data).length > 0) {
          await tx.employee.update({ where: { id: before.id }, data });
        }
      } catch (error) {
        throw translateWriteError(error);
      }

      const after = await this.reload(tx, before.id);
      await this.auditUpdate(tx, ctx, before, after, roleChange, revokedSessions, origin);
      return employeePayload(after);
    });
  }

  // -- Deactivate / activate — DOCUMENT 09 §6 --------------------------------

  async deactivate(
    ctx: AuthContext,
    id: string,
    dto: DeactivateEmployeeDto,
    origin: RequestOrigin,
  ): Promise<EmployeePayload> {
    return this.tenant(ctx, async (tx) => {
      const before = await this.loadForWrite(tx, ctx, id, 'employee.deactivate');
      if (before.status === 'inactive') {
        throw conflict(ERROR_CODES.EMPLOYEE_ALREADY_INACTIVE);
      }
      if (before.status === 'terminated') {
        throw conflict(ERROR_CODES.EMPLOYEE_TERMINATED);
      }
      if (before.user && before.user.status === 'active' && before.user.role.key === 'admin') {
        await this.assertAnotherActiveAdmin(tx, before.user.id);
      }

      await tx.employee.update({ where: { id: before.id }, data: { status: 'inactive' } });
      let revokedSessions = 0;
      if (before.user) {
        await tx.user.update({ where: { id: before.user.id }, data: { status: 'deactivated' } });
        revokedSessions = await this.sessions.revokeAllForUserIn(tx, before.user.id);
        await this.invitations.expirePending(tx, before.user.id);
      }

      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'EMPLOYEE_DEACTIVATED',
        entityType: 'employee',
        entityId: before.id,
        oldValues: {
          status: before.status,
          ...(before.user ? { account_status: before.user.status } : {}),
        },
        // DOCUMENT 08 §4.3 requires the reason; the audit trail is where it is kept.
        newValues: {
          status: 'inactive',
          ...(before.user ? { account_status: 'deactivated' } : {}),
          reason: dto.reason,
        },
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });
      if (before.user && revokedSessions > 0) {
        await this.recordSessionsRevoked(tx, ctx, before.user.id, revokedSessions, origin);
      }

      return employeePayload(await this.reload(tx, before.id));
    });
  }

  async activate(
    ctx: AuthContext,
    id: string,
    origin: RequestOrigin,
  ): Promise<EmployeeWriteResult> {
    const { row, pending } = await this.tenant(ctx, async (tx) => {
      const before = await this.loadForWrite(tx, ctx, id, 'employee.deactivate');
      if (before.status === 'active') {
        throw conflict(ERROR_CODES.EMPLOYEE_ALREADY_ACTIVE);
      }
      if (before.status === 'terminated') {
        throw conflict(ERROR_CODES.EMPLOYEE_TERMINATED);
      }

      await tx.employee.update({ where: { id: before.id }, data: { status: 'active' } });

      let accountStatus: 'active' | 'invited' | null = null;
      let pending: PendingInvitation | null = null;
      if (before.user) {
        const account = await tx.user.findUniqueOrThrow({
          where: { id: before.user.id },
          select: { passwordHash: true },
        });
        // DOCUMENT 09 §6 "Reactivation": sets the account active; "if the
        // password was never set, a fresh invitation is issued".
        accountStatus = account.passwordHash === null ? 'invited' : 'active';
        await tx.user.update({ where: { id: before.user.id }, data: { status: accountStatus } });
        if (accountStatus === 'invited') {
          pending = await this.prepareInvitation(tx, ctx, before);
        }
      }

      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'EMPLOYEE_ACTIVATED',
        entityType: 'employee',
        entityId: before.id,
        oldValues: {
          status: before.status,
          ...(before.user ? { account_status: before.user.status } : {}),
        },
        newValues: {
          status: 'active',
          ...(accountStatus === null ? {} : { account_status: accountStatus }),
        },
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });

      return { row: await this.reload(tx, before.id), pending };
    });

    const invitationDelivery = pending ? await this.deliver(ctx, pending, origin) : 'not_requested';
    return { employee: employeePayload(row), invitationDelivery };
  }

  // -- Invite — DOCUMENT 08 §4.3 "resend invitation" --------------------------

  async invite(ctx: AuthContext, id: string, origin: RequestOrigin): Promise<EmployeePayload> {
    const { row, pending } = await this.tenant(ctx, async (tx) => {
      const before = await this.loadForWrite(tx, ctx, id, 'employee.create');
      if (!before.user) {
        throw conflict(ERROR_CODES.CONFLICT);
      }
      if (before.status !== 'active') {
        throw conflict(ERROR_CODES.EMPLOYEE_NOT_ACTIVE);
      }
      if (before.user.status !== 'invited') {
        throw conflict(ERROR_CODES.ACCOUNT_ALREADY_ACTIVATED);
      }
      const pending = await this.prepareInvitation(tx, ctx, before);
      return { row: await this.reload(tx, before.id), pending };
    });

    if ((await this.deliver(ctx, pending, origin)) === 'failed') {
      throw new AppException(ERROR_CODES.MAIL_DELIVERY_FAILED, 503);
    }
    return employeePayload(row);
  }

  // -- Loading and scope -----------------------------------------------------

  /**
   * DOCUMENT 09 §4 checks 2 and 4, in that order: not in this tenant (or not
   * there at all) is 404; in this tenant but outside the caller's scope is
   * 403. Row-level security makes another company's row indistinguishable
   * from a missing one before this code runs.
   */
  private async loadScoped(
    tx: TenantClient,
    ctx: AuthContext,
    id: string,
    permission: Parameters<typeof employeeScopeWhere>[1],
  ): Promise<EmployeeRow> {
    const exists = await tx.employee.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (!exists) {
      throw notFound();
    }
    const row = await tx.employee.findFirst({
      where: { AND: [{ id, deletedAt: null }, employeeScopeWhere(ctx, permission)] },
      include: EMPLOYEE_INCLUDE,
    });
    if (!row) {
      throw forbidden();
    }
    return row;
  }

  /** `loadScoped`, with the row locked for the rest of the transaction. */
  private async loadForWrite(
    tx: TenantClient,
    ctx: AuthContext,
    id: string,
    permission: Parameters<typeof employeeScopeWhere>[1],
  ): Promise<EmployeeRow> {
    await tx.$executeRaw`SELECT 1 FROM employees WHERE id = ${id}::uuid FOR UPDATE`;
    return this.loadScoped(tx, ctx, id, permission);
  }

  private reload(tx: TenantClient, id: string): Promise<EmployeeRow> {
    return tx.employee.findUniqueOrThrow({ where: { id }, include: EMPLOYEE_INCLUDE });
  }

  // -- Validation ------------------------------------------------------------

  /**
   * DOCUMENT 08 §5.3 — every referenced id must exist in the caller's
   * company, and is checked before any other rule. All failures are reported
   * together, so a form can mark every bad field at once.
   */
  private async assertReferences(
    tx: TenantClient,
    refs: {
      readonly department_id: string | null;
      readonly position_id: string | null;
      readonly manager_id: string | null;
      readonly work_schedule_id: string | null;
    },
  ): Promise<void> {
    const [department, position, manager, schedule] = await Promise.all([
      refs.department_id === null
        ? null
        : tx.department.findFirst({
            where: { id: refs.department_id, deletedAt: null },
            select: { id: true },
          }),
      refs.position_id === null
        ? null
        : tx.position.findFirst({
            where: { id: refs.position_id, deletedAt: null },
            select: { id: true },
          }),
      refs.manager_id === null
        ? null
        : tx.employee.findFirst({
            where: { id: refs.manager_id, deletedAt: null },
            select: { id: true },
          }),
      refs.work_schedule_id === null
        ? null
        : tx.workSchedule.findFirst({
            where: { id: refs.work_schedule_id, deletedAt: null },
            select: { id: true },
          }),
    ]);

    const issues: Record<string, FieldIssue[]> = {};
    if (refs.department_id !== null && !department) issues['department_id'] = ['not_found'];
    if (refs.position_id !== null && !position) issues['position_id'] = ['not_found'];
    if (refs.manager_id !== null && !manager) issues['manager_id'] = ['not_found'];
    if (refs.work_schedule_id !== null && !schedule) issues['work_schedule_id'] = ['not_found'];
    if (Object.keys(issues).length > 0) {
      throw fieldError(issues);
    }
  }

  /**
   * DOCUMENT 08 §4.3 — email and employee code are unique per company. Checked
   * up front so both collisions are reported together; the unique indexes
   * remain the authority if two requests race.
   */
  private async assertUnique(
    tx: TenantClient,
    values: { readonly email: string | undefined; readonly employee_code: string | undefined },
    self: EmployeeRow | null,
  ): Promise<void> {
    const [userClash, employeeEmailClash, codeClash] = await Promise.all([
      values.email === undefined
        ? null
        : tx.user.findFirst({
            where: { email: values.email, ...(self?.userId ? { id: { not: self.userId } } : {}) },
            select: { id: true },
          }),
      values.email === undefined
        ? null
        : tx.employee.findFirst({
            where: { email: values.email, ...(self ? { id: { not: self.id } } : {}) },
            select: { id: true },
          }),
      values.employee_code === undefined
        ? null
        : tx.employee.findFirst({
            where: {
              employeeCode: values.employee_code,
              ...(self ? { id: { not: self.id } } : {}),
            },
            select: { id: true },
          }),
    ]);

    const issues: Record<string, FieldIssue[]> = {};
    if (userClash || employeeEmailClash) issues['email'] = ['already_taken'];
    if (codeClash) issues['employee_code'] = ['already_taken'];
    if (Object.keys(issues).length > 0) {
      throw fieldError(issues);
    }
  }

  /** A system role by key (DOCUMENT 06 §3.3: `company_id = NULL`). */
  private async requireRole(tx: TenantClient, key: AssignableRoleKey): Promise<Role> {
    const role = await tx.role.findFirst({ where: { companyId: null, key } });
    if (!role) {
      // The seed loads all four system roles; a missing one is a deployment
      // defect, not a client error.
      throw new Error(`System role "${key}" is not seeded.`);
    }
    return role;
  }

  /**
   * Walk up from the proposed manager. Reaching the employee being edited
   * means the assignment would close a loop, and a loop in the reporting line
   * would make every `team` scope — and any later org-chart read — ill-defined.
   * Bounded by the number of rows, which also makes it safe against a chain
   * that is somehow already cyclic.
   */
  private async rejectManagerCycle(
    tx: TenantClient,
    employeeId: string,
    proposedManagerId: string,
  ): Promise<void> {
    if (proposedManagerId === employeeId) {
      throw fieldError({ manager_id: ['would_create_cycle'] });
    }
    const limit = await tx.employee.count();
    let cursor: string | null = proposedManagerId;
    for (let step = 0; cursor !== null && step <= limit; step += 1) {
      if (cursor === employeeId) {
        throw fieldError({ manager_id: ['would_create_cycle'] });
      }
      const next: { managerId: string | null } | null = await tx.employee.findFirst({
        where: { id: cursor },
        select: { managerId: true },
      });
      cursor = next?.managerId ?? null;
    }
  }

  /**
   * DOCUMENT 02 §7 / DOCUMENT 09 §6 — refuse when `userId` is the company's
   * only active ADMIN. The active admin rows are locked first: without the
   * lock, two admins demoting each other in parallel would each see the other
   * still active and both succeed, leaving the company with no admin at all.
   */
  private async assertAnotherActiveAdmin(tx: TenantClient, userId: string): Promise<void> {
    const admins = await tx.$queryRaw<{ id: string }[]>`
      SELECT u.id
      FROM users u
      JOIN roles r ON r.id = u.role_id
      WHERE r.key = 'admin' AND u.status = 'active' AND u.deleted_at IS NULL
      FOR UPDATE OF u`;
    if (!admins.some((admin) => admin.id !== userId)) {
      throw conflict(ERROR_CODES.LAST_ACTIVE_ADMIN);
    }
  }

  // -- Invitations -----------------------------------------------------------

  private async prepareInvitation(
    tx: TenantClient,
    ctx: AuthContext,
    employee: Pick<EmployeeRow, 'userId' | 'firstName'>,
  ): Promise<PendingInvitation> {
    const userId = employee.userId;
    if (userId === null) {
      throw conflict(ERROR_CODES.CONFLICT);
    }
    const [company, user] = await Promise.all([
      tx.company.findUniqueOrThrow({
        where: { id: ctx.companyId },
        select: { name: true, defaultLocale: true, timezone: true },
      }),
      tx.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, locale: true } }),
    ]);
    const issued = await this.invitations.issue(tx, {
      companyId: ctx.companyId,
      userId,
      invitedBy: ctx.userId,
    });
    return {
      userId,
      delivery: {
        to: user.email,
        locale: mailLocale(user.locale, company.defaultLocale),
        token: issued.token,
        firstName: employee.firstName,
        companyName: company.name,
        expiresAt: issued.expiresAt,
        timeZone: company.timezone,
      },
    };
  }

  private async deliver(
    ctx: AuthContext,
    pending: PendingInvitation,
    origin: RequestOrigin,
  ): Promise<'sent' | 'failed'> {
    try {
      await this.mailer.send(pending.delivery);
    } catch (error) {
      // The user id, never the token or the message (DOCUMENT 20 §8).
      this.logger.error(
        `Invitation email for user ${pending.userId} was not accepted by the mail relay.`,
        error instanceof Error ? error.message : undefined,
      );
      return 'failed';
    }
    await this.tenant(ctx, (tx) =>
      this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'INVITATION_SENT',
        entityType: 'user',
        entityId: pending.userId,
        newValues: { expires_at: pending.delivery.expiresAt.toISOString() },
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      }),
    );
    return 'sent';
  }

  // -- Audit -----------------------------------------------------------------

  private async auditUpdate(
    tx: TenantClient,
    ctx: AuthContext,
    before: EmployeeRow,
    after: EmployeeRow,
    roleChange: { readonly from: string; readonly to: string } | null,
    revokedSessions: number,
    origin: RequestOrigin,
  ): Promise<void> {
    const beforeSnapshot = employeeAuditSnapshot(before);
    const afterSnapshot = employeeAuditSnapshot(after);
    const record = (
      action: AuditAction,
      values: { oldValues: Prisma.InputJsonObject; newValues: Prisma.InputJsonObject },
      entityType = 'employee',
      entityId = before.id,
    ): Promise<void> =>
      this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action,
        entityType,
        entityId,
        ...values,
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });

    const general = diffSnapshots(beforeSnapshot, afterSnapshot, GENERAL_FIELDS);
    if (Object.keys(general.newValues).length > 0) {
      await record('EMPLOYEE_UPDATED', general);
    }
    const department = diffSnapshots(beforeSnapshot, afterSnapshot, ['department_id']);
    if (Object.keys(department.newValues).length > 0) {
      await record('EMPLOYEE_DEPARTMENT_CHANGED', department);
    }
    const manager = diffSnapshots(beforeSnapshot, afterSnapshot, ['manager_id']);
    if (Object.keys(manager.newValues).length > 0) {
      await record('EMPLOYEE_MANAGER_CHANGED', manager);
    }
    if (roleChange !== null) {
      // DOCUMENT 02 §7: "Role changes are audited with old and new role."
      await record('EMPLOYEE_ROLE_CHANGED', {
        oldValues: { role_key: roleChange.from },
        newValues: { role_key: roleChange.to },
      });
    }
    if (before.user && revokedSessions > 0) {
      await this.recordSessionsRevoked(tx, ctx, before.user.id, revokedSessions, origin);
    }
  }

  private recordSessionsRevoked(
    tx: TenantClient,
    ctx: AuthContext,
    userId: string,
    count: number,
    origin: RequestOrigin,
  ): Promise<void> {
    return this.audit.record(tx, {
      companyId: ctx.companyId,
      userId: ctx.userId,
      action: 'SESSION_REVOKED',
      entityType: 'user',
      entityId: userId,
      newValues: { revoked_sessions: count },
      ipAddress: origin.ipAddress,
      userAgent: origin.userAgent,
    });
  }
}

function requireDate(value: string): Date {
  const parsed = parseCalendarDate(value);
  if (parsed === null) {
    throw fieldError({ joining_date: ['invalid'] });
  }
  return parsed;
}

/** The recipient's own language if set, else the company default (DOCUMENT 06 §3.2). */
function mailLocale(userLocale: string | null, companyLocale: string): Locale {
  for (const candidate of [userLocale?.trim(), companyLocale.trim()]) {
    if (isLocale(candidate)) {
      return candidate;
    }
  }
  return DEFAULT_LOCALE;
}

/**
 * A unique violation that slipped past `assertUnique` (two requests racing)
 * still becomes the field error it describes rather than a 500.
 */
function translateWriteError(error: unknown): unknown {
  if (!isUniqueViolation(error)) {
    return error;
  }
  const target = JSON.stringify((error as { meta?: { target?: unknown } }).meta?.target ?? '');
  if (target.includes('employee_code')) {
    return fieldError({ employee_code: ['already_taken'] });
  }
  if (target.includes('email')) {
    return fieldError({ email: ['already_taken'] });
  }
  return conflict(ERROR_CODES.CONFLICT);
}

/**
 * 1to1OS Business — Restaurants & Cafés: what the owner sets up — branches,
 * the team (each employee's role, branch and shift) and tables — plus the
 * caller's own restaurant identity (GET /restaurant/me).
 *
 * Only the owner changes anything here. Staff read only what their screens
 * need, and only for their own branch.
 */

import { Inject, Injectable } from '@nestjs/common';
import { generateId } from '@ufuq/db';
import type { Prisma, PrismaClient, TenantClient } from '@ufuq/db';

import { AuditDispatcher } from '../auth/audit-dispatcher.js';
import type { AuthContext } from '../auth/auth-context.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import type { RequestOrigin } from '../common/request-context.js';
import {
  fieldError,
  notFound,
  TenantScopedService,
} from '../company-structure/tenant-scoped.service.js';

import {
  actionsOf,
  requireAction,
  requireOwner,
  resolveAccess,
  resolveBranch,
} from './restaurant-access.js';
import type { RestaurantAccess } from './restaurant-access.js';
import type {
  CreateBranchDto,
  CreateTableDto,
  UpdateBranchDto,
  UpdateStaffDto,
  UpdateTableDto,
} from './restaurant.dto.js';
import { money, RESTAURANT_ROLES, shiftMinutes } from './restaurant-rules.js';
import type { RestaurantAction, RestaurantRoleKey } from './restaurant-rules.js';

export interface BranchRef {
  readonly id: string;
  readonly name: string;
}

/** A branch as the POS needs it: its rates price the cart preview. */
export interface WorkBranch extends BranchRef {
  readonly tax_rate: string;
  readonly service_rate: string;
}

export interface RestaurantMePayload {
  readonly enabled: boolean;
  readonly owner: boolean;
  readonly employee_id: string | null;
  readonly role: RestaurantRoleKey | null;
  readonly branch: WorkBranch | null;
  readonly branches: readonly WorkBranch[];
  readonly actions: readonly RestaurantAction[];
  readonly currency: string;
  readonly time_zone: string;
}

export interface BranchPayload extends BranchRef {
  readonly address: string | null;
  readonly phone: string | null;
  readonly tax_rate: string;
  readonly service_rate: string;
  readonly archived: boolean;
  readonly staff_count: number;
  readonly table_count: number;
}

export interface StaffPayload {
  readonly employee_id: string;
  readonly name: string;
  readonly employee_code: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly employee_status: string;
  readonly has_login: boolean;
  /** Null when the employee is not on the restaurant team yet. */
  readonly restaurant: {
    readonly branch: BranchRef;
    readonly role: RestaurantRoleKey;
    readonly job_title: string | null;
    readonly working_days: readonly number[];
    readonly shift_start: string | null;
    readonly shift_end: string | null;
    readonly break_minutes: number;
    readonly weekly_minutes: number;
    readonly active: boolean;
  } | null;
}

export interface PersonRef {
  readonly id: string;
  readonly name: string;
}

export interface TablePayload {
  readonly id: string;
  readonly branch_id: string;
  readonly label: string;
  readonly seats: number;
  readonly default_waiter: PersonRef | null;
  readonly archived: boolean;
  /** The table's open dine-in order, if any (new, preparing or ready). */
  readonly occupied_by: {
    readonly id: string;
    readonly number: number;
    readonly status: string;
  } | null;
}

function name(row: { firstName: string; lastName: string }): string {
  return `${row.firstName} ${row.lastName}`.trim();
}

function rate(value: { toString(): string }): string {
  return money(value).toString();
}

@Injectable()
export class RestaurantSetupService extends TenantScopedService {
  constructor(
    @Inject(PRISMA_CLIENT) prisma: PrismaClient,
    @Inject(AuditDispatcher) private readonly audit: AuditDispatcher,
  ) {
    super(prisma, audit);
  }

  // -------------------------------------------------------------------------
  // Me
  // -------------------------------------------------------------------------

  me(ctx: AuthContext): Promise<RestaurantMePayload> {
    return this.tenant(ctx, async (tx) => {
      const access = await resolveAccess(tx, ctx);
      const company = await tx.company.findUnique({
        where: { id: ctx.companyId },
        select: { currency: true, timezone: true },
      });
      const select = { id: true, name: true, taxRate: true, serviceRate: true } as const;
      const work = (row: {
        id: string;
        name: string;
        taxRate: { toString(): string };
        serviceRate: { toString(): string };
      }): WorkBranch => ({
        id: row.id,
        name: row.name,
        tax_rate: rate(row.taxRate),
        service_rate: rate(row.serviceRate),
      });
      let branches: WorkBranch[] = [];
      let branch: WorkBranch | null = null;
      if (access.owner) {
        const rows = await tx.restaurantBranch.findMany({
          where: { archivedAt: null },
          select,
          orderBy: { name: 'asc' },
        });
        branches = rows.map(work);
      } else if (access.branchId) {
        const row = await tx.restaurantBranch.findFirst({ where: { id: access.branchId }, select });
        branch = row ? work(row) : null;
        branches = branch ? [branch] : [];
      }
      return {
        enabled: access.enabled,
        owner: access.owner,
        employee_id: access.employeeId,
        role: access.role,
        branch,
        branches,
        actions: actionsOf(access),
        currency: company?.currency ?? 'EGP',
        time_zone: company?.timezone ?? 'Africa/Cairo',
      };
    });
  }

  // -------------------------------------------------------------------------
  // Branches
  // -------------------------------------------------------------------------

  branches(ctx: AuthContext): Promise<BranchPayload[]> {
    return this.tenant(ctx, async (tx) => {
      requireOwner(await resolveAccess(tx, ctx));
      const rows = await tx.restaurantBranch.findMany({
        orderBy: [{ archivedAt: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }],
        include: { _count: { select: { staff: true, tables: { where: { archivedAt: null } } } } },
      });
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        address: row.address,
        phone: row.phone,
        tax_rate: rate(row.taxRate),
        service_rate: rate(row.serviceRate),
        archived: row.archivedAt !== null,
        staff_count: row._count.staff,
        table_count: row._count.tables,
      }));
    });
  }

  async createBranch(
    ctx: AuthContext,
    dto: CreateBranchDto,
    origin: RequestOrigin,
  ): Promise<BranchPayload[]> {
    await this.tenant(ctx, async (tx) => {
      requireOwner(await resolveAccess(tx, ctx));
      await this.uniqueBranchName(tx, dto.name, null);
      const id = generateId();
      await tx.restaurantBranch.create({
        data: {
          id,
          companyId: ctx.companyId,
          name: dto.name,
          address: dto.address ?? null,
          phone: dto.phone ?? null,
          ...(dto.tax_rate !== undefined ? { taxRate: dto.tax_rate } : {}),
          ...(dto.service_rate !== undefined ? { serviceRate: dto.service_rate } : {}),
          createdBy: ctx.userId,
        },
      });
      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'RESTAURANT_BRANCH_CREATED',
        entityType: 'restaurant_branch',
        entityId: id,
        newValues: { name: dto.name },
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });
    });
    return this.branches(ctx);
  }

  async updateBranch(
    ctx: AuthContext,
    id: string,
    dto: UpdateBranchDto,
    origin: RequestOrigin,
  ): Promise<BranchPayload[]> {
    await this.tenant(ctx, async (tx) => {
      requireOwner(await resolveAccess(tx, ctx));
      const before = await tx.restaurantBranch.findFirst({ where: { id } });
      if (!before) throw notFound();
      if (dto.name !== undefined) await this.uniqueBranchName(tx, dto.name, id);
      if (dto.archived === true && before.archivedAt === null) {
        const open = await tx.restaurantOrder.count({
          where: { branchId: id, status: { in: ['new', 'preparing', 'ready'] } },
        });
        if (open > 0) throw fieldError({ archived: ['invalid'] });
      }
      await tx.restaurantBranch.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.address !== undefined ? { address: dto.address } : {}),
          ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
          ...(dto.tax_rate !== undefined ? { taxRate: dto.tax_rate } : {}),
          ...(dto.service_rate !== undefined ? { serviceRate: dto.service_rate } : {}),
          ...(dto.archived !== undefined
            ? { archivedAt: dto.archived ? (before.archivedAt ?? new Date()) : null }
            : {}),
        },
      });
      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'RESTAURANT_BRANCH_UPDATED',
        entityType: 'restaurant_branch',
        entityId: id,
        oldValues: { name: before.name, archived: before.archivedAt !== null },
        newValues: { fields: Object.keys(dto).sort() },
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });
    });
    return this.branches(ctx);
  }

  private async uniqueBranchName(
    tx: TenantClient,
    value: string,
    exceptId: string | null,
  ): Promise<void> {
    const clash = await tx.restaurantBranch.findFirst({
      where: {
        name: { equals: value, mode: 'insensitive' },
        ...(exceptId ? { NOT: { id: exceptId } } : {}),
      },
      select: { id: true },
    });
    if (clash) throw fieldError({ name: ['already_taken'] });
  }

  // -------------------------------------------------------------------------
  // Team
  // -------------------------------------------------------------------------

  staff(ctx: AuthContext): Promise<StaffPayload[]> {
    return this.tenant(ctx, async (tx) => {
      requireOwner(await resolveAccess(tx, ctx));
      const rows = await tx.employee.findMany({
        where: { deletedAt: null, status: { not: 'terminated' } },
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
        select: {
          id: true,
          firstName: true,
          lastName: true,
          employeeCode: true,
          email: true,
          phone: true,
          status: true,
          userId: true,
          user: { select: { role: { select: { key: true } } } },
          restaurantStaff: { include: { branch: { select: { id: true, name: true } } } },
        },
      });
      // The owner (a company admin) is not a member of the team.
      return rows
        .filter((row) => !['admin', 'super_admin'].includes(row.user?.role.key ?? ''))
        .map((row) => {
          const r = row.restaurantStaff;
          return {
            employee_id: row.id,
            name: name(row),
            employee_code: row.employeeCode,
            email: row.email,
            phone: row.phone,
            employee_status: row.status,
            has_login: row.userId !== null,
            restaurant: r
              ? {
                  branch: r.branch,
                  role: r.role,
                  job_title: r.jobTitle,
                  working_days: r.workingDays,
                  shift_start: r.shiftStart,
                  shift_end: r.shiftEnd,
                  break_minutes: r.breakMinutes,
                  weekly_minutes:
                    shiftMinutes(r.shiftStart, r.shiftEnd, r.breakMinutes) * r.workingDays.length,
                  active: r.active,
                }
              : null,
          };
        });
    });
  }

  async updateStaff(
    ctx: AuthContext,
    employeeId: string,
    dto: UpdateStaffDto,
    origin: RequestOrigin,
  ): Promise<StaffPayload[]> {
    await this.tenant(ctx, async (tx) => {
      requireOwner(await resolveAccess(tx, ctx));
      const employee = await tx.employee.findFirst({
        where: { id: employeeId, deletedAt: null },
        select: {
          id: true,
          status: true,
          user: { select: { role: { select: { key: true } } } },
          restaurantStaff: true,
        },
      });
      if (!employee) throw notFound();
      if (['admin', 'super_admin'].includes(employee.user?.role.key ?? ''))
        throw fieldError({ employee_id: ['invalid'] });
      if (employee.status === 'terminated') throw fieldError({ employee_id: ['not_active'] });
      const branch = await tx.restaurantBranch.findFirst({
        where: { id: dto.branch_id, archivedAt: null },
        select: { id: true },
      });
      if (!branch) throw fieldError({ branch_id: ['not_found'] });
      if (!(RESTAURANT_ROLES as readonly string[]).includes(dto.role))
        throw fieldError({ role: ['invalid'] });
      const days = [...new Set(dto.working_days)].sort((a, b) => a - b);
      const data = {
        branchId: dto.branch_id,
        role: dto.role,
        jobTitle: dto.job_title ?? null,
        workingDays: days,
        shiftStart: dto.shift_start ?? null,
        shiftEnd: dto.shift_end ?? null,
        breakMinutes: dto.break_minutes ?? 0,
        active: dto.active ?? true,
      };
      const before = employee.restaurantStaff;
      await tx.restaurantStaff.upsert({
        where: { employeeId },
        create: { employeeId, companyId: ctx.companyId, ...data },
        update: data,
      });
      // Moving to another branch leaves that branch's tables to their own waiters.
      if (before && before.branchId !== dto.branch_id) {
        await tx.restaurantTable.updateMany({
          where: { defaultWaiterId: employeeId },
          data: { defaultWaiterId: null },
        });
      }
      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'RESTAURANT_STAFF_CHANGED',
        entityType: 'employee',
        entityId: employeeId,
        oldValues: before
          ? { branch_id: before.branchId, role: before.role, active: before.active }
          : {},
        newValues: {
          branch_id: data.branchId,
          role: data.role,
          active: data.active,
          working_days: days,
        },
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });
    });
    return this.staff(ctx);
  }

  async removeStaff(
    ctx: AuthContext,
    employeeId: string,
    origin: RequestOrigin,
  ): Promise<StaffPayload[]> {
    await this.tenant(ctx, async (tx) => {
      requireOwner(await resolveAccess(tx, ctx));
      const before = await tx.restaurantStaff.findUnique({ where: { employeeId } });
      if (!before) throw notFound();
      await tx.restaurantTable.updateMany({
        where: { defaultWaiterId: employeeId },
        data: { defaultWaiterId: null },
      });
      await tx.restaurantStaff.delete({ where: { employeeId } });
      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'RESTAURANT_STAFF_REMOVED',
        entityType: 'employee',
        entityId: employeeId,
        oldValues: { branch_id: before.branchId, role: before.role },
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });
    });
    return this.staff(ctx);
  }

  /** The active waiters of a branch — for table defaults and order hand-over. */
  waiters(ctx: AuthContext, branchId: string | undefined): Promise<PersonRef[]> {
    return this.tenant(ctx, async (tx) => {
      const access = await resolveAccess(tx, ctx);
      if (!access.owner) requireAction(access, 'tables.view');
      const branch = await resolveBranch(tx, access, branchId);
      return this.branchWaiters(tx, branch);
    });
  }

  private async branchWaiters(tx: TenantClient, branchId: string): Promise<PersonRef[]> {
    const rows = await tx.restaurantStaff.findMany({
      where: {
        branchId,
        role: 'waiter',
        active: true,
        employee: { status: 'active', deletedAt: null },
      },
      select: { employee: { select: { id: true, firstName: true, lastName: true } } },
    });
    return rows
      .map((r) => ({ id: r.employee.id, name: name(r.employee) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // -------------------------------------------------------------------------
  // Tables
  // -------------------------------------------------------------------------

  tables(
    ctx: AuthContext,
    branchId: string | undefined,
    includeArchived: boolean,
  ): Promise<TablePayload[]> {
    return this.tenant(ctx, async (tx) => {
      const access = await resolveAccess(tx, ctx);
      requireAction(access, 'tables.view');
      const branch = await resolveBranch(tx, access, branchId);
      return this.tableList(tx, branch, includeArchived && access.owner);
    });
  }

  private async tableList(
    tx: TenantClient,
    branchId: string,
    includeArchived: boolean,
  ): Promise<TablePayload[]> {
    const rows = await tx.restaurantTable.findMany({
      where: { branchId, ...(includeArchived ? {} : { archivedAt: null }) },
      include: {
        defaultWaiter: { select: { id: true, firstName: true, lastName: true } },
        orders: {
          where: { status: { in: ['new', 'preparing', 'ready'] } },
          select: { id: true, number: true, status: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });
    return rows
      .map((row) => ({
        id: row.id,
        branch_id: row.branchId,
        label: row.label,
        seats: row.seats,
        default_waiter: row.defaultWaiter
          ? { id: row.defaultWaiter.id, name: name(row.defaultWaiter) }
          : null,
        archived: row.archivedAt !== null,
        occupied_by: row.orders[0] ?? null,
      }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  }

  async createTable(
    ctx: AuthContext,
    dto: CreateTableDto,
    origin: RequestOrigin,
  ): Promise<TablePayload[]> {
    return this.tenant(ctx, async (tx) => {
      const access = await resolveAccess(tx, ctx);
      requireOwner(access);
      const branchId = await resolveBranch(tx, access, dto.branch_id);
      await this.uniqueLabel(tx, branchId, dto.label, null);
      if (dto.default_waiter_id) await this.waiterOf(tx, branchId, dto.default_waiter_id);
      const id = generateId();
      await tx.restaurantTable.create({
        data: {
          id,
          companyId: ctx.companyId,
          branchId,
          label: dto.label,
          seats: dto.seats ?? 4,
          defaultWaiterId: dto.default_waiter_id ?? null,
        },
      });
      await this.auditTable(tx, ctx, id, { created: dto.label }, origin);
      return this.tableList(tx, branchId, true);
    });
  }

  async updateTable(
    ctx: AuthContext,
    id: string,
    dto: UpdateTableDto,
    origin: RequestOrigin,
  ): Promise<TablePayload[]> {
    return this.tenant(ctx, async (tx) => {
      requireOwner(await resolveAccess(tx, ctx));
      const before = await tx.restaurantTable.findFirst({ where: { id } });
      if (!before) throw notFound();
      if (dto.label !== undefined) await this.uniqueLabel(tx, before.branchId, dto.label, id);
      if (dto.default_waiter_id) await this.waiterOf(tx, before.branchId, dto.default_waiter_id);
      if (dto.archived === true && before.archivedAt === null) {
        const open = await tx.restaurantOrder.count({
          where: { tableId: id, status: { in: ['new', 'preparing', 'ready'] } },
        });
        if (open > 0) throw fieldError({ archived: ['invalid'] });
      }
      await tx.restaurantTable.update({
        where: { id },
        data: {
          ...(dto.label !== undefined ? { label: dto.label } : {}),
          ...(dto.seats !== undefined ? { seats: dto.seats } : {}),
          ...(dto.default_waiter_id !== undefined
            ? { defaultWaiterId: dto.default_waiter_id }
            : {}),
          ...(dto.archived !== undefined
            ? { archivedAt: dto.archived ? (before.archivedAt ?? new Date()) : null }
            : {}),
        },
      });
      await this.auditTable(tx, ctx, id, { fields: Object.keys(dto).sort() }, origin);
      return this.tableList(tx, before.branchId, true);
    });
  }

  private async uniqueLabel(
    tx: TenantClient,
    branchId: string,
    label: string,
    exceptId: string | null,
  ): Promise<void> {
    const clash = await tx.restaurantTable.findFirst({
      where: {
        branchId,
        label: { equals: label, mode: 'insensitive' },
        ...(exceptId ? { NOT: { id: exceptId } } : {}),
      },
      select: { id: true },
    });
    if (clash) throw fieldError({ label: ['already_taken'] });
  }

  private async waiterOf(tx: TenantClient, branchId: string, employeeId: string): Promise<void> {
    const ok = await tx.restaurantStaff.findFirst({
      where: { employeeId, branchId, role: 'waiter', active: true },
      select: { employeeId: true },
    });
    if (!ok) throw fieldError({ default_waiter_id: ['invalid'] });
  }

  private async auditTable(
    tx: TenantClient,
    ctx: AuthContext,
    id: string,
    values: Prisma.InputJsonObject,
    origin: RequestOrigin,
  ): Promise<void> {
    await this.audit.record(tx, {
      companyId: ctx.companyId,
      userId: ctx.userId,
      action: 'RESTAURANT_TABLE_CHANGED',
      entityType: 'restaurant_table',
      entityId: id,
      newValues: values,
      ipAddress: origin.ipAddress,
      userAgent: origin.userAgent,
    });
  }
}

export type { RestaurantAccess };

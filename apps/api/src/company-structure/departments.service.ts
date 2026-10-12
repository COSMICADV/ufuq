/**
 * `/departments` — DOCUMENT 08 §4.2, DOCUMENT 06 §3.4.
 *
 * Three rules carry the weight here:
 *
 *   - A department is soft-deleted, never removed (DOCUMENT 06 §6): employees,
 *     attendance and payroll history in later phases keep pointing at it.
 *   - Deletion is blocked while something still depends on it: child
 *     departments and positions (Phase 4), and — DOCUMENT 06 §3.4's own rule —
 *     active employees (Phase 5).
 *   - The parent reference is a tree, so a cycle has to be impossible. The
 *     database refuses a department that is its own parent; a longer loop needs
 *     a walk, which is the service's job (DOCUMENT 06 §3.6 splits the same
 *     work the same way for `employees.manager_id`).
 */

import { Inject, Injectable } from '@nestjs/common';
import { generateId } from '@ufuq/db';
import type { Department, Prisma, PrismaClient, TenantClient } from '@ufuq/db';

import type { AuthContext } from '../auth/auth-context.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import { ERROR_CODES } from '../common/errors.js';

import type { CreateDepartmentDto, UpdateDepartmentDto } from './dto/department.dto.js';
import type { ResolvedPage } from './dto/pagination.dto.js';
import { departmentPayload } from './payloads.js';
import type { DepartmentPayload } from './payloads.js';
import {
  conflict,
  fieldError,
  isUniqueViolation,
  notFound,
  TenantScopedService,
} from './tenant-scoped.service.js';

export interface DepartmentList {
  readonly items: readonly DepartmentPayload[];
  readonly total: number;
}

@Injectable()
export class DepartmentsService extends TenantScopedService {
  /** Explicit, so Nest resolves exactly this: the base constructor's optional audit dispatcher is not injectable. This service writes no audit. */
  constructor(@Inject(PRISMA_CLIENT) prisma: PrismaClient) {
    super(prisma);
  }

  async list(ctx: AuthContext, page: ResolvedPage): Promise<DepartmentList> {
    return this.tenant(ctx, async (tx) => {
      const where: Prisma.DepartmentWhereInput = { deletedAt: null };
      const [rows, total] = await Promise.all([
        tx.department.findMany({
          where,
          // A stable order: the Arabic name is the one DOCUMENT 06 §3.4 makes
          // unique, so it can never tie, and `id` is not a meaningful sort key
          // to a reader.
          orderBy: { nameAr: 'asc' },
          skip: page.skip,
          take: page.take,
        }),
        tx.department.count({ where }),
      ]);
      return { items: rows.map(departmentPayload), total };
    });
  }

  async create(ctx: AuthContext, dto: CreateDepartmentDto): Promise<DepartmentPayload> {
    return this.tenant(ctx, async (tx) => {
      const parentId = dto.parent_id ?? null;
      if (parentId !== null) {
        await this.requireDepartment(tx, parentId, 'parent_id');
      }
      const managerEmployeeId = dto.manager_employee_id ?? null;
      if (managerEmployeeId !== null) {
        await this.requireEmployee(tx, managerEmployeeId);
      }

      try {
        const row = await tx.department.create({
          data: {
            id: generateId(),
            companyId: ctx.companyId,
            nameAr: dto.name_ar,
            nameEn: dto.name_en,
            parentId,
            managerEmployeeId,
            ...(dto.status === undefined ? {} : { status: dto.status }),
          },
        });
        return departmentPayload(row);
      } catch (error) {
        throw this.translateWriteError(error);
      }
    });
  }

  async update(ctx: AuthContext, id: string, dto: UpdateDepartmentDto): Promise<DepartmentPayload> {
    return this.tenant(ctx, async (tx) => {
      const existing = await this.requirePathDepartment(tx, id);

      const data: Prisma.DepartmentUpdateInput = {};
      if (dto.name_ar !== undefined) {
        data.nameAr = dto.name_ar;
      }
      if (dto.name_en !== undefined) {
        data.nameEn = dto.name_en;
      }
      if (dto.status !== undefined) {
        data.status = dto.status;
      }

      if (dto.manager_employee_id !== undefined) {
        const managerEmployeeId = dto.manager_employee_id;
        if (managerEmployeeId === null) {
          data.manager = { disconnect: true };
        } else {
          await this.requireEmployee(tx, managerEmployeeId);
          data.manager = { connect: { id: managerEmployeeId } };
        }
      }

      // Absent means "leave the parent alone"; an explicit null means "move
      // this to the top level". Both are legitimate, and they are different.
      if (dto.parent_id !== undefined) {
        const parentId = dto.parent_id;
        if (parentId === null) {
          data.parent = { disconnect: true };
        } else {
          if (parentId === existing.id) {
            throw fieldError({ parent_id: ['would_create_cycle'] });
          }
          await this.requireDepartment(tx, parentId, 'parent_id');
          await this.rejectCycle(tx, existing.id, parentId);
          data.parent = { connect: { id: parentId } };
        }
      }

      try {
        const row = await tx.department.update({ where: { id: existing.id }, data });
        return departmentPayload(row);
      } catch (error) {
        throw this.translateWriteError(error);
      }
    });
  }

  /** DOCUMENT 06 §6 — a soft delete, and only when nothing still depends on it. */
  async remove(ctx: AuthContext, id: string): Promise<void> {
    await this.tenant(ctx, async (tx) => {
      const existing = await this.requirePathDepartment(tx, id);

      const [children, positions, employees] = await Promise.all([
        tx.department.count({ where: { parentId: existing.id, deletedAt: null } }),
        tx.position.count({ where: { departmentId: existing.id, deletedAt: null } }),
        // DOCUMENT 06 §3.4: "Deletion blocked while active employees are
        // assigned" — enforceable from Phase 5, now that employees exist.
        tx.employee.count({
          where: { departmentId: existing.id, status: 'active', deletedAt: null },
        }),
      ]);
      if (children > 0) {
        throw conflict(ERROR_CODES.DEPARTMENT_HAS_CHILDREN);
      }
      if (positions > 0) {
        throw conflict(ERROR_CODES.DEPARTMENT_HAS_POSITIONS);
      }
      if (employees > 0) {
        throw conflict(ERROR_CODES.DEPARTMENT_HAS_EMPLOYEES);
      }

      await tx.department.update({ where: { id: existing.id }, data: { deletedAt: new Date() } });
    });
  }

  /**
   * `manager_employee_id` in a request body — DOCUMENT 08 §5.3. Another
   * company's employee is invisible to this query, so it fails as
   * `not_found`, exactly like an id that does not exist.
   */
  private async requireEmployee(tx: TenantClient, id: string): Promise<void> {
    const row = await tx.employee.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (!row) {
      throw fieldError({ manager_employee_id: ['not_found'] });
    }
  }

  /**
   * A department named in the URL. Missing, soft-deleted, and belonging to
   * another company are all 404 — DOCUMENT 08 §3: "Cross-tenant access returns
   * 404, not 403 — do not confirm that another company's record exists."
   * Row-level security has already made the third case indistinguishable from
   * the first by the time this query runs.
   */
  private async requirePathDepartment(tx: TenantClient, id: string): Promise<Department> {
    const row = await tx.department.findFirst({ where: { id, deletedAt: null } });
    if (!row) {
      throw notFound();
    }
    return row;
  }

  /**
   * A department named in a request *body* — DOCUMENT 08 §5.3, "validate that
   * every referenced id belongs to the caller's company before any business
   * rule runs". This reports 422 with the offending field rather than 404: the
   * resource being addressed exists; one of its fields does not check out. It
   * confirms nothing about another tenant either — "not_found" is what a
   * caller sees whether the id is fictional or belongs to someone else.
   */
  private async requireDepartment(
    tx: TenantClient,
    id: string,
    field: string,
  ): Promise<Department> {
    const row = await tx.department.findFirst({ where: { id, deletedAt: null } });
    if (!row) {
      throw fieldError({ [field]: ['not_found'] });
    }
    return row;
  }

  /**
   * Walk from the proposed parent towards the root. Reaching `id` means the
   * move would close a loop, and a loop in this table would make any later
   * recursive read — an org chart, a department rollup in a report — spin.
   *
   * The walk is bounded by the number of departments, which is also what makes
   * it safe against data that is already cyclic.
   */
  private async rejectCycle(tx: TenantClient, id: string, proposedParentId: string): Promise<void> {
    const limit = await tx.department.count({ where: { deletedAt: null } });
    let cursor: string | null = proposedParentId;
    for (let step = 0; cursor !== null && step <= limit; step += 1) {
      if (cursor === id) {
        throw fieldError({ parent_id: ['would_create_cycle'] });
      }
      const parent: { parentId: string | null } | null = await tx.department.findFirst({
        where: { id: cursor },
        select: { parentId: true },
      });
      cursor = parent?.parentId ?? null;
    }
  }

  /**
   * `(company_id, name_ar)` is unique (DOCUMENT 06 §3.4, no soft-delete
   * predicate), so a soft-deleted department keeps its Arabic name reserved.
   * The caller is told which field collided rather than being handed a 500.
   */
  private translateWriteError(error: unknown): unknown {
    return isUniqueViolation(error) ? fieldError({ name_ar: ['already_taken'] }) : error;
  }
}

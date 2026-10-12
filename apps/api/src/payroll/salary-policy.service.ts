/**
 * The salary policy — DOCUMENT 06 §3.22, DOCUMENT 15 "SALARY CALCULATION
 * ENGINE", DOCUMENT 08 §4.2 (`GET/PATCH /salary-policies`), DOCUMENT 04
 * "Salary policy" settings.
 *
 *   - **One policy per company in V1**, the default one.
 *   - **No invented default** (approved decision). A company has no policy
 *     until an ADMIN saves one, and the first save must state every rule.
 *     Until then salaries cannot be set and payroll cannot be generated
 *     (`SALARY_POLICY_NOT_CONFIGURED`).
 *   - **Changing it never rewrites history.** Finalized lines keep the policy
 *     their snapshot recorded. A draft picks the change up only when it is
 *     recalculated, which is the Admin's explicit action.
 *   - Audited as `salary_policy.changed`, old and new values, after commit.
 */

import { Inject, Injectable } from '@nestjs/common';
import { generateId } from '@ufuq/db';
import type { Prisma, PrismaClient } from '@ufuq/db';
import { Decimal } from '@ufuq/money';

import { AuditDispatcher } from '../auth/audit-dispatcher.js';
import type { AuthContext } from '../auth/auth-context.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import type { RequestOrigin } from '../common/request-context.js';
import { fieldError, TenantScopedService } from '../company-structure/tenant-scoped.service.js';

import type { UpdateSalaryPolicyDto } from './dto/payroll.dto.js';
import { loadPolicy, moneyString, policyConfig } from './payroll-inputs.js';
import type { PolicyRow } from './payroll-inputs.js';

export interface SalaryPolicyPayload {
  readonly id: string;
  readonly name: string;
  readonly daily_wage_basis: string;
  readonly fixed_days_value: number | null;
  readonly unpaid_leave_deduction: string;
  readonly absence_deduction: string;
  readonly lateness_rule: Prisma.JsonValue;
  readonly overtime_rate: string;
  readonly rounding: string;
  readonly updated_at: string;
}

export function salaryPolicyPayload(row: PolicyRow): SalaryPolicyPayload {
  const config = policyConfig(row);
  return {
    id: row.id,
    name: row.name,
    daily_wage_basis: config.dailyWageBasis,
    fixed_days_value: config.fixedDaysValue,
    unpaid_leave_deduction: config.unpaidLeaveDeduction,
    absence_deduction: config.absenceDeduction,
    lateness_rule: row.latenessRule,
    overtime_rate: moneyString(row.overtimeRate),
    rounding: config.rounding,
    updated_at: row.updatedAt.toISOString(),
  };
}

const REQUIRED_ON_CREATE = [
  'name',
  'daily_wage_basis',
  'unpaid_leave_deduction',
  'absence_deduction',
  'lateness_rule',
  'overtime_rate',
  'rounding',
] as const;

@Injectable()
export class SalaryPolicyService extends TenantScopedService {
  constructor(
    @Inject(PRISMA_CLIENT) prisma: PrismaClient,
    @Inject(AuditDispatcher) private readonly audit: AuditDispatcher,
  ) {
    super(prisma, audit);
  }

  async get(ctx: AuthContext): Promise<{ readonly policy: SalaryPolicyPayload | null }> {
    return this.tenant(ctx, async (tx) => {
      const row = await loadPolicy(tx);
      return { policy: row === null ? null : salaryPolicyPayload(row) };
    });
  }

  async update(
    ctx: AuthContext,
    dto: UpdateSalaryPolicyDto,
    origin: RequestOrigin,
  ): Promise<{ readonly policy: SalaryPolicyPayload }> {
    return this.tenant(ctx, async (tx) => {
      // Serialize two saves of the one policy.
      await tx.$queryRaw`SELECT id FROM salary_policies WHERE is_default FOR UPDATE`;
      const before = await loadPolicy(tx);
      const previous = before === null ? null : salaryPolicyPayload(before);

      if (previous === null) {
        const missing = REQUIRED_ON_CREATE.filter((key) => dto[key] === undefined);
        if (missing.length > 0) {
          throw fieldError(Object.fromEntries(missing.map((key) => [key, ['required']])));
        }
      }

      const basis = dto.daily_wage_basis ?? previous?.daily_wage_basis;
      let fixedDays: number | null;
      if (basis === 'fixed_days') {
        fixedDays =
          dto.fixed_days_value === undefined
            ? (previous?.fixed_days_value ?? null)
            : dto.fixed_days_value;
        if (fixedDays === null) throw fieldError({ fixed_days_value: ['required'] });
      } else {
        // The divisor exists only for fixed_days: naming one for another basis
        // is a mistake to report, while one left from an earlier basis is dropped.
        if (dto.fixed_days_value !== undefined && dto.fixed_days_value !== null) {
          throw fieldError({ fixed_days_value: ['invalid'] });
        }
        fixedDays = null;
      }

      const data = {
        name: dto.name ?? (previous?.name as string),
        dailyWageBasis: basis as PolicyRow['dailyWageBasis'],
        fixedDaysValue: fixedDays,
        unpaidLeaveDeduction: (dto.unpaid_leave_deduction ??
          previous?.unpaid_leave_deduction) as PolicyRow['unpaidLeaveDeduction'],
        absenceDeduction: (dto.absence_deduction ??
          previous?.absence_deduction) as PolicyRow['absenceDeduction'],
        latenessRule: (dto.lateness_rule ?? previous?.lateness_rule) as Prisma.InputJsonObject,
        overtimeRate: Decimal.parse(
          dto.overtime_rate ?? (previous?.overtime_rate as string),
          2,
        ).toString(),
        rounding: (dto.rounding ?? previous?.rounding) as PolicyRow['rounding'],
      };

      const row =
        before === null
          ? await tx.salaryPolicy.create({
              data: { id: generateId(), companyId: ctx.companyId, isDefault: true, ...data },
            })
          : await tx.salaryPolicy.update({ where: { id: before.id }, data });
      const after = salaryPolicyPayload(row as PolicyRow);

      const keys = (Object.keys(after) as (keyof SalaryPolicyPayload)[]).filter(
        (key) => key !== 'id' && key !== 'updated_at',
      );
      const changed = keys.filter(
        (key) => previous === null || JSON.stringify(previous[key]) !== JSON.stringify(after[key]),
      );
      if (changed.length > 0) {
        await this.audit.record(tx, {
          companyId: ctx.companyId,
          userId: ctx.userId,
          action: 'SALARY_POLICY_CHANGED',
          entityType: 'salary_policy',
          entityId: row.id,
          ...(previous === null
            ? {}
            : {
                oldValues: Object.fromEntries(
                  changed.map((key) => [key, previous[key] as Prisma.InputJsonValue]),
                ),
              }),
          newValues: Object.fromEntries(
            changed.map((key) => [key, after[key] as Prisma.InputJsonValue]),
          ),
          ipAddress: origin.ipAddress,
          userAgent: origin.userAgent,
        });
      }
      return { policy: after };
    });
  }
}

/**
 * An employee's first salary, written with the employee — an employee is
 * never added without one (product decision, 2026-11-10).
 *
 * A salary row names the company's salary policy. A company adding its first
 * employee may not have set one yet, so it gets the default the product
 * describes: the monthly salary is split over the month's scheduled working
 * days, an absent or unpaid-leave day costs that day's wage, no lateness or
 * overtime rule, no rounding. The Admin can change any of it in Settings.
 */

import { generateId } from '@ufuq/db';
import type { TenantClient } from '@ufuq/db';
import { Decimal } from '@ufuq/money';

import type { AuditDispatcher } from '../auth/audit-dispatcher.js';
import type { AuthContext } from '../auth/auth-context.js';
import type { RequestOrigin } from '../common/request-context.js';

import { loadPolicy, moneyString } from './payroll-inputs.js';

export const DEFAULT_POLICY = {
  name: 'Standard',
  dailyWageBasis: 'scheduled_working_days',
  fixedDaysValue: null,
  unpaidLeaveDeduction: 'daily_wage',
  absenceDeduction: 'daily_wage',
  latenessRule: { type: 'none' },
  overtimeRate: '0.00',
  rounding: 'none',
} as const;

/** The company's salary policy id, creating the default one if there is none. */
export async function ensureSalaryPolicy(
  tx: TenantClient,
  ctx: AuthContext,
  audit: AuditDispatcher,
  origin: RequestOrigin,
): Promise<string> {
  const existing = await loadPolicy(tx);
  if (existing !== null) return existing.id;
  const id = generateId();
  await tx.salaryPolicy.create({
    data: { id, companyId: ctx.companyId, isDefault: true, ...DEFAULT_POLICY },
  });
  await audit.record(tx, {
    companyId: ctx.companyId,
    userId: ctx.userId,
    action: 'SALARY_POLICY_CHANGED',
    entityType: 'salary_policy',
    entityId: id,
    newValues: {
      name: DEFAULT_POLICY.name,
      daily_wage_basis: DEFAULT_POLICY.dailyWageBasis,
      unpaid_leave_deduction: DEFAULT_POLICY.unpaidLeaveDeduction,
      absence_deduction: DEFAULT_POLICY.absenceDeduction,
      lateness_rule: DEFAULT_POLICY.latenessRule,
      overtime_rate: DEFAULT_POLICY.overtimeRate,
      rounding: DEFAULT_POLICY.rounding,
    },
    ipAddress: origin.ipAddress,
    userAgent: origin.userAgent,
  });
  return id;
}

/** Write a new employee's first salary row, from their joining date. */
export async function recordInitialSalary(
  tx: TenantClient,
  ctx: AuthContext,
  audit: AuditDispatcher,
  origin: RequestOrigin,
  input: {
    readonly employeeId: string;
    readonly joiningDate: Date;
    readonly monthlySalary: string;
    readonly transportAllowance: string | undefined;
  },
): Promise<void> {
  const policyId = await ensureSalaryPolicy(tx, ctx, audit, origin);
  const company = await tx.company.findFirstOrThrow({ select: { currency: true } });
  const monthly = Decimal.parse(input.monthlySalary, 2).toString();
  const transport = Decimal.parse(input.transportAllowance ?? '0', 2).toString();
  await tx.employeeSalary.create({
    data: {
      id: generateId(),
      companyId: ctx.companyId,
      employeeId: input.employeeId,
      monthlySalary: monthly,
      transportAllowance: transport,
      currency: company.currency,
      effectiveFrom: input.joiningDate,
      salaryPolicyId: policyId,
      createdBy: ctx.userId,
      note: null,
    },
  });
  await audit.record(tx, {
    companyId: ctx.companyId,
    userId: ctx.userId,
    action: 'EMPLOYEE_SALARY_CHANGED',
    entityType: 'employee',
    entityId: input.employeeId,
    newValues: {
      monthly_salary: moneyString(monthly),
      transport_allowance: moneyString(transport),
      effective_from: input.joiningDate.toISOString().slice(0, 10),
      currency: company.currency,
    },
    ipAddress: origin.ipAddress,
    userAgent: origin.userAgent,
  });
}

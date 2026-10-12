/**
 * Audit rows → the DOCUMENT 08 §1 wire shape — DOCUMENT 21 "Record content"
 * and "UI".
 *
 * The actor is sent as what the viewer needs to write DOCUMENT 21's sentence
 * ("أحمد محمد أضاف …"): the employee's name when the user has one, the email
 * otherwise, and a flag for the designated system actor so it can be named
 * "the system" rather than by its placeholder address. The join cannot break —
 * `audit_logs.user_id` is a foreign key and users are soft-deleted, never
 * removed — so "the viewer shows the stored name" holds without copying the
 * name into every record.
 *
 * **Salary values** are visible only to a caller who also holds
 * `employee.view_salary` (DOCUMENT 21 "Captured with care"). No salary is
 * audited yet — salaries arrive with a later phase — but the rule belongs to
 * the viewer, so it is applied here rather than remembered there.
 */

import type { Prisma } from '@ufuq/db';

import { actionToWire } from './audit-actions.js';

export const AUDIT_LOG_INCLUDE = {
  user: {
    select: {
      id: true,
      email: true,
      isSystem: true,
      employee: { select: { firstName: true, lastName: true } },
    },
  },
} as const;

export type AuditLogRow = Prisma.AuditLogGetPayload<{ include: typeof AUDIT_LOG_INCLUDE }>;

export interface AuditActor {
  readonly id: string;
  readonly name: string | null;
  readonly email: string;
  readonly is_system: boolean;
}

export interface AuditLogPayload {
  readonly id: string;
  readonly action: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly actor: AuditActor;
  readonly old_values: Prisma.JsonValue;
  readonly new_values: Prisma.JsonValue;
  readonly ip_address: string | null;
  readonly user_agent: string | null;
  readonly created_at: string;
}

/** Replaces a withheld value, so the reader sees that a field changed without seeing to what. */
export const REDACTED = '[redacted]';

/** Any key naming a salary — `monthly_salary`, `salary`, `base_salary_amount`. */
const SALARY_KEY = /salary/i;

/**
 * A copy of `values` with every salary-named field replaced by
 * {@link REDACTED}, at any depth. Non-object values are returned unchanged.
 */
export function redactSalary(values: Prisma.JsonValue): Prisma.JsonValue {
  if (Array.isArray(values)) {
    return values.map(redactSalary);
  }
  if (values !== null && typeof values === 'object') {
    const out: Record<string, Prisma.JsonValue> = {};
    for (const [key, value] of Object.entries(values)) {
      out[key] = SALARY_KEY.test(key) ? REDACTED : redactSalary(value ?? null);
    }
    return out;
  }
  return values;
}

/**
 * Actions whose every value is pay: a payroll run's totals, a deduction's
 * amount, an adjustment. Their figures are not under a salary-named key, so a
 * caller without `employee.view_salary` sees which fields changed and nothing
 * of what they changed to (DOCUMENT 21 "Captured with care", Phase 11).
 */
export function isPayAction(action: string): boolean {
  return (
    action.startsWith('payroll.') ||
    action === 'deduction.added' ||
    action === 'bonus.added' ||
    action === 'employee.salary_changed'
  );
}

/** Every value withheld, every key kept. */
export function redactAll(values: Prisma.JsonValue): Prisma.JsonValue {
  if (Array.isArray(values)) {
    return values.map(redactAll);
  }
  if (values !== null && typeof values === 'object') {
    return Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        value !== null && typeof value === 'object' ? redactAll(value) : REDACTED,
      ]),
    );
  }
  return REDACTED;
}

export function auditLogPayload(
  row: AuditLogRow,
  options: { readonly canViewSalary: boolean },
): AuditLogPayload {
  const pay = isPayAction(actionToWire(row.action));
  const view = (values: Prisma.JsonValue | null): Prisma.JsonValue =>
    values === null || options.canViewSalary
      ? values
      : pay
        ? redactAll(values)
        : redactSalary(values);
  const employee = row.user.employee;
  return {
    id: row.id,
    action: actionToWire(row.action),
    entity_type: row.entityType,
    entity_id: row.entityId,
    actor: {
      id: row.user.id,
      name: employee === null ? null : `${employee.firstName} ${employee.lastName}`,
      email: row.user.email,
      is_system: row.user.isSystem,
    },
    old_values: view(row.oldValues),
    new_values: view(row.newValues),
    ip_address: row.ipAddress,
    user_agent: row.userAgent,
    created_at: row.createdAt.toISOString(),
  };
}

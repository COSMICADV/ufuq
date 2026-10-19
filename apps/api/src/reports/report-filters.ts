/**
 * Which filters each report takes, and what they refer to — DOCUMENT 18
 * "Filters", DOCUMENT 09 §4.
 *
 *   - Each report accepts its own set (common: date range · department ·
 *     employee · status; module-specific: work mode · priority · goal type ·
 *     movement type · warehouse · product category). Anything else is a 422
 *     `not_allowed`: a filter is never silently ignored, because the output
 *     states its filters (rule 7).
 *   - `status` is checked against the statuses that report's source has.
 *   - Every id a filter names is resolved inside the tenant first: another
 *     company's id is a 404 (DOCUMENT 09 §4 check 2, never a confirmation it
 *     exists). For a team-scoped reader, an employee outside the team is a
 *     403 (check 4). A filter narrows a scope; it can never widen it.
 *
 * The resolved names travel with the report so a printed or exported report
 * can say "Department: Sales" rather than an id.
 */

import type { TenantClient } from '@ufuq/db';

import { AppException } from '../common/app-exception.js';
import { ERROR_CODES } from '../common/errors.js';
import { fieldError, notFound } from '../company-structure/tenant-scoped.service.js';

import type { ReportFiltersDto, ReportStatus } from './dto/reports.dto.js';
import type { ReportKey, ReportScope } from './report-catalogue.js';

export type FilterField =
  | 'from'
  | 'to'
  | 'department_id'
  | 'employee_id'
  | 'status'
  | 'work_mode'
  | 'priority'
  | 'goal_type'
  | 'warehouse_id'
  | 'category_id'
  | 'product_id'
  | 'product_status'
  | 'movement_type'
  | 'user_id';

const FILTER_FIELDS: readonly FilterField[] = [
  'from',
  'to',
  'department_id',
  'employee_id',
  'status',
  'work_mode',
  'priority',
  'goal_type',
  'warehouse_id',
  'category_id',
  'product_id',
  'product_status',
  'movement_type',
  'user_id',
];

const PEOPLE: readonly FilterField[] = ['from', 'to', 'department_id', 'employee_id', 'status'];

export const ALLOWED_FILTERS: Readonly<Record<ReportKey, readonly FilterField[]>> = {
  attendance: [...PEOPLE, 'work_mode'],
  performance: PEOPLE,
  tasks: [...PEOPLE, 'priority'],
  goals: [...PEOPLE, 'goal_type'],
  payroll: PEOPLE,
  // Inventory is the stock as it stands now: a date range would claim a
  // valuation the ledger is not asked for (documented in PHASE-12-STATUS).
  inventory: ['warehouse_id', 'category_id', 'product_id', 'status', 'product_status'],
  warehouse: ['from', 'to', 'warehouse_id', 'movement_type'],
  'stock-movements': ['from', 'to', 'product_id', 'warehouse_id', 'movement_type', 'user_id'],
};

/** The statuses each report's source has (DOCUMENT 12, 13, 14, 15, 17). */
export const ALLOWED_STATUSES: Readonly<Record<ReportKey, readonly ReportStatus[]>> = {
  attendance: [
    'present',
    'absent',
    'late',
    'on_leave',
    'half_day',
    'holiday',
    'weekend',
    'pending',
  ],
  performance: ['active', 'inactive', 'terminated'],
  tasks: ['not_started', 'in_progress', 'completed', 'cancelled', 'on_hold'],
  goals: ['active', 'achieved', 'missed', 'cancelled'],
  payroll: ['draft', 'under_review', 'approved', 'finalized', 'paid', 'adjusted'],
  inventory: ['in_stock', 'low_stock', 'out_of_stock'],
  warehouse: [],
  'stock-movements': [],
};

/** The filters a request actually set, by field. */
export type ActiveFilters = Partial<Record<FilterField, string>>;

/** 422 for a filter the report does not take, or a status its source does not have. */
export function checkFilters(key: ReportKey, dto: ReportFiltersDto): ActiveFilters {
  const allowed = ALLOWED_FILTERS[key];
  const issues: Record<string, ['not_allowed']> = {};
  const active: ActiveFilters = {};
  for (const field of FILTER_FIELDS) {
    const value = dto[field];
    if (value === undefined) continue;
    if (!allowed.includes(field)) {
      issues[field] = ['not_allowed'];
      continue;
    }
    active[field] = value;
  }
  if (
    active.status !== undefined &&
    !ALLOWED_STATUSES[key].includes(active.status as ReportStatus)
  ) {
    issues.status = ['not_allowed'];
  }
  if (Object.keys(issues).length > 0) {
    throw fieldError(issues);
  }
  return active;
}

/** A filter's human form: the entity's name in both languages. */
export interface FilterLabel {
  readonly ar: string;
  readonly en: string;
}

/**
 * Resolve every referenced id inside the tenant (row-level security already
 * hides other companies' rows, so a foreign id simply is not found → 404).
 * An employee outside a team scope → 403.
 */
export async function resolveFilterLabels(
  tx: TenantClient,
  filters: ActiveFilters,
  scope: ReportScope,
): Promise<Partial<Record<FilterField, FilterLabel>>> {
  const labels: Partial<Record<FilterField, FilterLabel>> = {};
  if (filters.department_id !== undefined) {
    const row = await tx.department.findFirst({
      where: { id: filters.department_id },
      select: { nameAr: true, nameEn: true },
    });
    if (row === null) throw notFound();
    labels.department_id = { ar: row.nameAr, en: row.nameEn };
  }
  if (filters.employee_id !== undefined) {
    const row = await tx.employee.findFirst({
      where: { id: filters.employee_id },
      select: { firstName: true, lastName: true, employeeCode: true, managerId: true },
    });
    if (row === null) throw notFound();
    if (scope.type === 'team' && row.managerId !== scope.manager_employee_id) {
      throw new AppException(ERROR_CODES.FORBIDDEN, 403);
    }
    const name = `${row.firstName} ${row.lastName} (${row.employeeCode})`;
    labels.employee_id = { ar: name, en: name };
  }
  if (filters.warehouse_id !== undefined) {
    const row = await tx.warehouse.findFirst({
      where: { id: filters.warehouse_id, deletedAt: null },
      select: { nameAr: true, nameEn: true },
    });
    if (row === null) throw notFound();
    labels.warehouse_id = { ar: row.nameAr, en: row.nameEn };
  }
  if (filters.category_id !== undefined) {
    const row = await tx.productCategory.findFirst({
      where: { id: filters.category_id, deletedAt: null },
      select: { nameAr: true, nameEn: true },
    });
    if (row === null) throw notFound();
    labels.category_id = { ar: row.nameAr, en: row.nameEn };
  }
  if (filters.product_id !== undefined) {
    const row = await tx.product.findFirst({
      where: { id: filters.product_id },
      select: { nameAr: true, nameEn: true, sku: true },
    });
    if (row === null) throw notFound();
    labels.product_id = { ar: `${row.nameAr} (${row.sku})`, en: `${row.nameEn} (${row.sku})` };
  }
  if (filters.user_id !== undefined) {
    const row = await tx.user.findFirst({
      where: { id: filters.user_id },
      select: { email: true },
    });
    if (row === null) throw notFound();
    labels.user_id = { ar: row.email, en: row.email };
  }
  return labels;
}

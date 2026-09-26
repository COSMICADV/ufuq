/**
 * Roles and the role → permission → scope matrix — DOCUMENT 02 §2, §3, §4.
 *
 * The four V1 roles are system roles (`company_id = NULL` in the `roles`
 * table — DOCUMENT 06 §3.3): every company shares the same four rows rather
 * than each company getting its own copy. Adding a role like HR later is a
 * data insert against `roles` and `role_permissions`, never a code change
 * (DOCUMENT 02 §2 design rule).
 *
 * SUPER_ADMIN is provisioned out-of-band and holds none of the permissions in
 * this catalogue (DOCUMENT 02 §7) — its platform-level capabilities (managing
 * companies and subscriptions) are not part of the V1 permission catalogue and
 * are not built here.
 */

import type { PermissionKey } from './permissions.js';

export const SYSTEM_ROLE_KEYS = ['super_admin', 'admin', 'manager', 'employee'] as const;
export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];

const SYSTEM_ROLE_KEY_SET: ReadonlySet<string> = new Set(SYSTEM_ROLE_KEYS);

/** Narrows an untyped string (e.g. a `roles.key` column value) to {@link SystemRoleKey}. */
export function isSystemRoleKey(value: string): value is SystemRoleKey {
  return SYSTEM_ROLE_KEY_SET.has(value);
}

/**
 * The roles a company may give one of its own users — DOCUMENT 02 §7:
 * "SUPER_ADMIN is provisioned out-of-band. There is no UI to create one." It
 * is platform staff, not a company member, so no company-scoped action —
 * employee creation or a role change — can grant it.
 */
export const ASSIGNABLE_ROLE_KEYS = [
  'admin',
  'manager',
  'employee',
] as const satisfies readonly SystemRoleKey[];
export type AssignableRoleKey = (typeof ASSIGNABLE_ROLE_KEYS)[number];

const ASSIGNABLE_ROLE_KEY_SET: ReadonlySet<string> = new Set(ASSIGNABLE_ROLE_KEYS);

export function isAssignableRoleKey(value: string): value is AssignableRoleKey {
  return ASSIGNABLE_ROLE_KEY_SET.has(value);
}

export interface SystemRoleDefinition {
  readonly key: SystemRoleKey;
  readonly nameEn: string;
  readonly nameAr: string;
}

export const SYSTEM_ROLES: readonly SystemRoleDefinition[] = [
  { key: 'super_admin', nameEn: 'Super Admin', nameAr: 'مدير عام النظام' },
  { key: 'admin', nameEn: 'Admin', nameAr: 'مدير الشركة' },
  { key: 'manager', nameEn: 'Manager', nameAr: 'مدير' },
  { key: 'employee', nameEn: 'Employee', nameAr: 'موظف' },
] as const;

/** DOCUMENT 02 §3. */
export type PermissionScope = 'self' | 'team' | 'company' | 'platform';

export interface RolePermissionGrant {
  readonly role: SystemRoleKey;
  readonly permission: PermissionKey;
  readonly scope: PermissionScope;
}

function grants(
  role: SystemRoleKey,
  entries: ReadonlyArray<readonly [PermissionKey, PermissionScope]>,
): RolePermissionGrant[] {
  return entries.map(([permission, scope]) => ({ role, permission, scope }));
}

/**
 * DOCUMENT 02 §4, transcribed table by table. A permission absent for a role
 * here is a ❌ cell in the document — the role simply has no grant, which
 * `permissionsForRole` reports as "not permitted" rather than as an error.
 */
export const ROLE_PERMISSIONS: readonly RolePermissionGrant[] = [
  ...grants('admin', [
    ['employee.view', 'company'],
    ['employee.create', 'company'],
    ['employee.update', 'company'],
    ['employee.deactivate', 'company'],
    ['employee.view_salary', 'company'],
    ['employee.set_salary', 'company'],
    ['employee.assign_manager', 'company'],
    ['attendance.check_in', 'self'],
    ['attendance.check_out', 'self'],
    ['attendance.view', 'company'],
    ['attendance.update', 'company'],
    ['attendance.request_correction', 'self'],
    ['attendance.approve_correction', 'company'],
    ['leave.request', 'self'],
    ['leave.view', 'company'],
    ['leave.approve', 'company'],
    ['leave.configure_types', 'company'],
    ['leave.adjust_balance', 'company'],
    ['task.view', 'company'],
    ['task.create', 'company'],
    ['task.update', 'company'],
    ['task.delete', 'company'],
    ['task.update_status', 'company'],
    ['task.update_checklist', 'company'],
    ['task.add_progress_note', 'company'],
    ['goal.view', 'company'],
    ['goal.create', 'company'],
    ['goal.update', 'company'],
    ['goal.update_progress', 'company'],
    ['request.create', 'self'],
    ['request.view', 'company'],
    ['request.review', 'company'],
    ['request.cancel', 'self'],
    ['payroll.view', 'company'],
    ['payroll.generate', 'company'],
    ['payroll.add_deduction', 'company'],
    ['payroll.add_bonus', 'company'],
    ['payroll.approve', 'company'],
    ['payroll.finalize', 'company'],
    ['payroll.mark_paid', 'company'],
    ['payroll.adjust', 'company'],
    ['warehouse.view', 'company'],
    ['warehouse.manage', 'company'],
    ['product.view', 'company'],
    ['product.create', 'company'],
    ['product.update', 'company'],
    ['stock.view', 'company'],
    ['stock.movement_create', 'company'],
    ['stock.transfer', 'company'],
    ['report.company', 'company'],
    ['report.team', 'company'],
    ['report.employee_monthly', 'company'],
    ['report.export', 'company'],
    ['settings.view', 'company'],
    ['settings.update', 'company'],
    ['settings.work_schedule', 'company'],
    ['settings.salary_policy', 'company'],
    ['settings.performance_weights', 'company'],
    ['audit.view', 'company'],
  ]),
  ...grants('manager', [
    ['employee.view', 'team'],
    ['attendance.check_in', 'self'],
    ['attendance.check_out', 'self'],
    ['attendance.view', 'team'],
    ['attendance.request_correction', 'self'],
    ['attendance.approve_correction', 'team'],
    ['leave.request', 'self'],
    ['leave.view', 'team'],
    ['leave.approve', 'team'],
    ['task.view', 'team'],
    ['task.create', 'team'],
    ['task.update', 'team'],
    ['task.delete', 'team'],
    ['task.update_status', 'team'],
    ['task.update_checklist', 'team'],
    ['task.add_progress_note', 'team'],
    ['goal.view', 'team'],
    ['goal.create', 'team'],
    ['goal.update', 'team'],
    ['goal.update_progress', 'team'],
    ['request.create', 'self'],
    ['request.view', 'team'],
    ['request.review', 'team'],
    ['request.cancel', 'self'],
    ['report.team', 'team'],
    ['report.employee_monthly', 'team'],
    ['report.export', 'team'],
  ]),
  ...grants('employee', [
    ['employee.view', 'self'],
    ['employee.view_salary', 'self'],
    ['attendance.check_in', 'self'],
    ['attendance.check_out', 'self'],
    ['attendance.view', 'self'],
    ['attendance.request_correction', 'self'],
    ['leave.request', 'self'],
    ['leave.view', 'self'],
    ['task.view', 'self'],
    ['task.update_status', 'self'],
    ['task.update_checklist', 'self'],
    ['task.add_progress_note', 'self'],
    ['goal.view', 'self'],
    ['request.create', 'self'],
    ['request.view', 'self'],
    ['request.cancel', 'self'],
    ['payroll.view', 'self'],
    ['report.employee_monthly', 'self'],
  ]),
  // super_admin: deliberately empty — DOCUMENT 02 §7.
];

/** All grants for one role, as `permission key → scope`. */
export function permissionsForRole(
  role: SystemRoleKey,
): ReadonlyMap<PermissionKey, PermissionScope> {
  const map = new Map<PermissionKey, PermissionScope>();
  for (const grant of ROLE_PERMISSIONS) {
    if (grant.role === role) {
      map.set(grant.permission, grant.scope);
    }
  }
  return map;
}

/**
 * The employees screens' pure logic — DOCUMENT 04 B2/B3/B4, DOCUMENT 03 §3.
 *
 * Everything a screen decides that is not rendering lives here, so it can be
 * tested without a browser: routes, which tabs a caller may see, how the URL
 * holds filters, and how a form becomes a request body. None of it is a
 * security control — the API enforces every rule again (DOCUMENT 09 §5).
 */

import type { ApiError } from './api-client';

// ---------------------------------------------------------------------------
// Payloads, as the API sends them (apps/api/src/employees/employee-payload.ts)
// ---------------------------------------------------------------------------

export interface EmployeeView {
  readonly id: string;
  readonly employee_code: string;
  readonly first_name: string;
  readonly last_name: string;
  readonly photo_path: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly department: {
    readonly id: string;
    readonly name_ar: string;
    readonly name_en: string;
  } | null;
  readonly position: {
    readonly id: string;
    readonly title_ar: string;
    readonly title_en: string;
  } | null;
  readonly manager: {
    readonly id: string;
    readonly employee_code: string;
    readonly first_name: string;
    readonly last_name: string;
  } | null;
  readonly work_schedule: { readonly id: string; readonly name: string };
  readonly joining_date: string;
  readonly status: EmployeeStatus;
  readonly termination_date: string | null;
  readonly account: {
    readonly status: 'invited' | 'active' | 'deactivated';
    readonly role_key: string;
    readonly invitation_expires_at: string | null;
  } | null;
}

export const EMPLOYEE_STATUSES = ['active', 'inactive', 'terminated'] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

/**
 * DOCUMENT 02 §7 — the roles a company can assign; SUPER_ADMIN is never one.
 * Mirrors `ASSIGNABLE_ROLE_KEYS` in `@ufuq/auth`, which `employees.test.ts`
 * asserts so the two cannot drift. The API is what enforces it.
 */
export const ASSIGNABLE_ROLES = ['admin', 'manager', 'employee'] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

// ---------------------------------------------------------------------------
// Routes — DOCUMENT 03 §3. Segments are English and never localized (§9).
// ---------------------------------------------------------------------------

/** DOCUMENT 04 B4's seven tabs, in order. */
export const EMPLOYEE_TABS = [
  'overview',
  'attendance',
  'tasks',
  'goals',
  'salary',
  'requests',
  'reports',
] as const;
export type EmployeeTab = (typeof EMPLOYEE_TABS)[number];

export function employeesPath(locale: string): string {
  return `/${locale}/admin/employees`;
}

export function newEmployeePath(locale: string): string {
  return `${employeesPath(locale)}/new`;
}

/** Overview is the profile's own address; every other tab is a sub-route. */
export function employeePath(locale: string, id: string, tab: EmployeeTab = 'overview'): string {
  const base = `${employeesPath(locale)}/${id}`;
  return tab === 'overview' ? base : `${base}/${tab}`;
}

export function editEmployeePath(locale: string, id: string): string {
  return `${employeesPath(locale)}/${id}/edit`;
}

/**
 * DOCUMENT 04 B4: "tab visibility follows permissions; hidden tabs are also
 * blocked server-side". Each tab shows data owned by a module, and the
 * permission is that module's view permission from DOCUMENT 02 §4 — Salary
 * is the one B4 names (`employee.view_salary`).
 */
export const TAB_PERMISSION: Readonly<Record<EmployeeTab, string | null>> = {
  overview: null,
  attendance: 'attendance.view',
  tasks: 'task.view',
  goals: 'goal.view',
  salary: 'employee.view_salary',
  requests: 'request.view',
  reports: 'report.employee_monthly',
};

export function visibleTabs(permissions: ReadonlySet<string>): readonly EmployeeTab[] {
  return EMPLOYEE_TABS.filter((tab) => {
    const required = TAB_PERMISSION[tab];
    return required === null || permissions.has(required);
  });
}

// ---------------------------------------------------------------------------
// List filters, kept in the URL — DOCUMENT 11 §6, DOCUMENT 26 §9
// ---------------------------------------------------------------------------

export const EMPLOYEE_SORTS = ['name', 'joining_date', 'department'] as const;
export type EmployeeSort = (typeof EMPLOYEE_SORTS)[number];
export const SORT_ORDERS = ['asc', 'desc'] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

export interface EmployeeListParams {
  readonly page: number;
  readonly search: string;
  readonly department_id: string;
  readonly position_id: string;
  readonly manager_id: string;
  readonly status: EmployeeStatus | '';
  readonly sort: EmployeeSort;
  readonly order: SortOrder;
}

export const DEFAULT_LIST_PARAMS: EmployeeListParams = {
  page: 1,
  search: '',
  department_id: '',
  position_id: '',
  manager_id: '',
  status: '',
  sort: 'name',
  order: 'asc',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function oneOf<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function idParam(params: URLSearchParams, key: string): string {
  const value = params.get(key) ?? '';
  return UUID.test(value) ? value : '';
}

/**
 * Read the list state from the address bar. A hand-edited value that is not
 * one the API accepts falls back to the default rather than producing a 422
 * the reader did not cause.
 */
export function listParamsFromSearch(params: URLSearchParams): EmployeeListParams {
  const rawPage = params.get('page') ?? '';
  const page = /^\d+$/.test(rawPage) && Number(rawPage) >= 1 ? Number(rawPage) : 1;
  return {
    page,
    search: (params.get('search') ?? '').slice(0, 100),
    department_id: idParam(params, 'department_id'),
    position_id: idParam(params, 'position_id'),
    manager_id: idParam(params, 'manager_id'),
    status: oneOf<EmployeeStatus | ''>(params.get('status'), EMPLOYEE_STATUSES, ''),
    sort: oneOf(params.get('sort'), EMPLOYEE_SORTS, DEFAULT_LIST_PARAMS.sort),
    order: oneOf(params.get('order'), SORT_ORDERS, DEFAULT_LIST_PARAMS.order),
  };
}

/** The canonical query string: defaults are omitted, so one view has one address. */
export function searchForListParams(value: EmployeeListParams): string {
  const next = new URLSearchParams();
  if (value.page > 1) next.set('page', String(value.page));
  if (value.search.trim() !== '') next.set('search', value.search.trim());
  if (value.department_id !== '') next.set('department_id', value.department_id);
  if (value.position_id !== '') next.set('position_id', value.position_id);
  if (value.manager_id !== '') next.set('manager_id', value.manager_id);
  if (value.status !== '') next.set('status', value.status);
  if (value.sort !== DEFAULT_LIST_PARAMS.sort) next.set('sort', value.sort);
  if (value.order !== DEFAULT_LIST_PARAMS.order) next.set('order', value.order);
  const query = next.toString();
  return query === '' ? '' : `?${query}`;
}

/** The `GET /employees` query for a list state. */
export function apiQueryForListParams(
  value: EmployeeListParams,
  perPage: number,
): Readonly<Record<string, string>> {
  const query: Record<string, string> = {
    page: String(value.page),
    per_page: String(perPage),
    sort: value.sort,
    order: value.order,
  };
  if (value.search.trim() !== '') query['search'] = value.search.trim();
  if (value.department_id !== '') query['department_id'] = value.department_id;
  if (value.position_id !== '') query['position_id'] = value.position_id;
  if (value.manager_id !== '') query['manager_id'] = value.manager_id;
  if (value.status !== '') query['status'] = value.status;
  return query;
}

/** DOCUMENT 11 §8: "filters show an active count". Sorting is not a filter. */
export function activeFilterCount(value: EmployeeListParams): number {
  return [
    value.search.trim(),
    value.department_id,
    value.position_id,
    value.manager_id,
    value.status,
  ].filter((entry) => entry !== '').length;
}

/** Clear every filter and return to page 1, keeping the chosen sort. */
export function clearedFilters(value: EmployeeListParams): EmployeeListParams {
  return { ...DEFAULT_LIST_PARAMS, sort: value.sort, order: value.order };
}

// ---------------------------------------------------------------------------
// Create / edit form — DOCUMENT 04 B3
// ---------------------------------------------------------------------------

export interface EmployeeFormValues {
  readonly first_name: string;
  readonly last_name: string;
  readonly email: string;
  readonly phone: string;
  readonly employee_code: string;
  readonly department_id: string;
  readonly position_id: string;
  readonly manager_id: string;
  readonly work_schedule_id: string;
  readonly joining_date: string;
  readonly role_key: AssignableRole | '';
  readonly send_invitation: boolean;
}

/**
 * A blank form. The schedule defaults to the company's default schedule, if
 * it has one (the Phase 4 settings screen tells the admin exactly that); the
 * role and the joining date have no default — choosing them is the admin's
 * decision, not the form's.
 */
export function emptyEmployeeForm(defaultScheduleId: string | null): EmployeeFormValues {
  return {
    first_name: '',
    last_name: '',
    email: '',
    phone: '',
    employee_code: '',
    department_id: '',
    position_id: '',
    manager_id: '',
    work_schedule_id: defaultScheduleId ?? '',
    joining_date: '',
    role_key: '',
    send_invitation: true,
  };
}

export function formFromEmployee(employee: EmployeeView): EmployeeFormValues {
  const role = employee.account?.role_key ?? '';
  return {
    first_name: employee.first_name,
    last_name: employee.last_name,
    email: employee.email ?? '',
    phone: employee.phone ?? '',
    employee_code: employee.employee_code,
    department_id: employee.department?.id ?? '',
    position_id: employee.position?.id ?? '',
    manager_id: employee.manager?.id ?? '',
    work_schedule_id: employee.work_schedule.id,
    joining_date: employee.joining_date,
    role_key: (ASSIGNABLE_ROLES as readonly string[]).includes(role)
      ? (role as AssignableRole)
      : '',
    send_invitation: false,
  };
}

/** An empty select or input means "none" — an explicit null, not an omission. */
function nullable(value: string): string | null {
  return value.trim() === '' ? null : value;
}

/** `POST /employees`. */
export function createBody(values: EmployeeFormValues): Record<string, unknown> {
  return {
    first_name: values.first_name,
    last_name: values.last_name,
    email: values.email,
    phone: nullable(values.phone),
    employee_code: values.employee_code,
    department_id: nullable(values.department_id),
    position_id: nullable(values.position_id),
    manager_id: nullable(values.manager_id),
    work_schedule_id: values.work_schedule_id,
    joining_date: values.joining_date,
    role_key: values.role_key,
    send_invitation: values.send_invitation,
  };
}

const UPDATABLE_FIELDS = [
  'first_name',
  'last_name',
  'email',
  'phone',
  'employee_code',
  'department_id',
  'position_id',
  'manager_id',
  'work_schedule_id',
  'joining_date',
  'role_key',
] as const;

const NULLABLE_FIELDS: ReadonlySet<string> = new Set([
  'phone',
  'department_id',
  'position_id',
  'manager_id',
]);

/**
 * `PATCH /employees/{id}` — only what changed. Sending an unchanged
 * `manager_id` would still ask for `employee.assign_manager`, and sending an
 * unchanged `role_key` is the kind of no-op that should not exist on the wire.
 */
export function updateBody(
  initial: EmployeeFormValues,
  values: EmployeeFormValues,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const field of UPDATABLE_FIELDS) {
    if (initial[field] !== values[field]) {
      body[field] = NULLABLE_FIELDS.has(field) ? nullable(values[field]) : values[field];
    }
  }
  return body;
}

export function isDirty(initial: EmployeeFormValues, values: EmployeeFormValues): boolean {
  return (Object.keys(initial) as (keyof EmployeeFormValues)[]).some(
    (key) => initial[key] !== values[key],
  );
}

/**
 * The translation key for one field's error. The API's issue vocabulary is
 * shared across modules, and `would_create_cycle` on a manager deserves its
 * own sentence rather than the department one.
 */
export function employeeIssueKey(field: string, error: ApiError): string | null {
  const issue = error.fields[field]?.[0];
  if (issue === undefined) {
    return null;
  }
  if (field === 'manager_id' && issue === 'would_create_cycle') {
    return 'employees.manager_cycle';
  }
  const known = ['required', 'invalid', 'already_taken', 'not_found'];
  return known.includes(issue) ? `validation.${issue}` : 'validation.invalid';
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

export function fullName(person: {
  readonly first_name: string;
  readonly last_name: string;
}): string {
  return `${person.first_name} ${person.last_name}`.trim();
}

/** Avatar initials — first letter of each name, in whichever script it is written. */
export function initials(person: {
  readonly first_name: string;
  readonly last_name: string;
}): string {
  const first = Array.from(person.first_name.trim())[0] ?? '';
  const last = Array.from(person.last_name.trim())[0] ?? '';
  return `${first}${last}`;
}

/** DOCUMENT 10 §6.5 — the badge tone for a status. Colour is never the only signal (§10). */
export function statusTone(status: EmployeeStatus): 'success' | 'cancelled' | 'danger' {
  switch (status) {
    case 'active':
      return 'success';
    case 'inactive':
      return 'cancelled';
    case 'terminated':
      return 'danger';
  }
}

export type InvitationState = 'none' | 'not_sent' | 'pending' | 'expired' | 'accepted';

/** Where the employee's sign-in account stands, for the profile's account card. */
export function invitationState(employee: EmployeeView, now: Date): InvitationState {
  const account = employee.account;
  if (account === null) {
    return 'none';
  }
  if (account.status !== 'invited') {
    return 'accepted';
  }
  if (account.invitation_expires_at === null) {
    return 'not_sent';
  }
  return new Date(account.invitation_expires_at).getTime() > now.getTime() ? 'pending' : 'expired';
}

/** "Resend invitation" is offered exactly when `POST /employees/{id}/invite` would accept it. */
export function canInvite(employee: EmployeeView): boolean {
  return employee.status === 'active' && employee.account?.status === 'invited';
}

// ---------------------------------------------------------------------------
// Invitation acceptance — DOCUMENT 04 A4
// ---------------------------------------------------------------------------

/**
 * DOCUMENT 09 §2 minimum length. Mirrors `MIN_PASSWORD_LENGTH` in
 * `@ufuq/auth` (asserted in `employees.test.ts`); it drives the hint and the
 * length meter only — the API applies the policy, breach check included.
 */
export const PASSWORD_MIN_LENGTH = 10;

export function passwordLengthOk(password: string): boolean {
  return password.length >= PASSWORD_MIN_LENGTH;
}

/** What the acceptance form refuses, as codes the page turns into strings. */
export interface AcceptanceIssues {
  readonly password?: 'too_short';
  readonly confirmation?: 'mismatch';
  readonly terms?: 'required';
}

/**
 * The DOCUMENT 04 A4 form's own gate, reported all at once so the invitee
 * fixes everything in one pass rather than one refusal at a time.
 *
 * This is the page's copy of the rules; the API applies its own — the full
 * password policy, breach check included, and the terms acceptance — and is
 * the one that decides. Checking here only saves a round trip.
 */
export function acceptanceIssues(input: {
  readonly password: string;
  readonly confirmation: string;
  readonly terms: boolean;
}): AcceptanceIssues {
  const issues: {
    password?: 'too_short';
    confirmation?: 'mismatch';
    terms?: 'required';
  } = {};
  if (!passwordLengthOk(input.password)) {
    issues.password = 'too_short';
  }
  if (input.password !== input.confirmation) {
    issues.confirmation = 'mismatch';
  }
  if (!input.terms) {
    issues.terms = 'required';
  }
  return issues;
}

/**
 * The invitation link carries its token in the fragment (`#token=…`) so it is
 * never sent to a server or leaked in a `Referer` (DOCUMENT 20 §6).
 */
export function tokenFromHash(hash: string): string | null {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  const token = new URLSearchParams(fragment).get('token');
  return token === null || token.trim() === '' ? null : token;
}

/**
 * Reports on the web — DOCUMENT 04 B17 (catalogue), B18 (viewer), C13 (my
 * monthly report); DOCUMENT 18; DOCUMENT 08 §4.12.
 *
 * Pure functions and the payload shapes, so the screens' rules are tested
 * without a browser. The API decides every figure and every permission;
 * this file only decides what to show and how to ask.
 */

import type { Locale } from '@ufuq/i18n';

// ---------------------------------------------------------------------------
// The catalogue — DOCUMENT 04 B17 "grouped: Financial · Attendance · Tasks &
// Goals · Inventory"
// ---------------------------------------------------------------------------

export const REPORT_KEYS = [
  'attendance',
  'performance',
  'tasks',
  'goals',
  'payroll',
  'inventory',
  'warehouse',
  'stock-movements',
] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];

export function isReportKey(value: string): value is ReportKey {
  return (REPORT_KEYS as readonly string[]).includes(value);
}

export const REPORT_GROUPS: readonly {
  readonly key: 'financial' | 'attendance' | 'tasks_goals' | 'inventory';
  readonly reports: readonly ReportKey[];
}[] = [
  { key: 'financial', reports: ['payroll'] },
  { key: 'attendance', reports: ['attendance'] },
  { key: 'tasks_goals', reports: ['tasks', 'goals', 'performance'] },
  { key: 'inventory', reports: ['inventory', 'warehouse', 'stock-movements'] },
];

/** DOCUMENT 02: people reports read with report.team; the rest only report.company. */
const PEOPLE: readonly ReportKey[] = ['attendance', 'performance', 'tasks', 'goals'];

export function readPermission(key: ReportKey): 'report.team' | 'report.company' {
  return PEOPLE.includes(key) ? 'report.team' : 'report.company';
}

export function canRead(permissions: ReadonlySet<string>, key: ReportKey): boolean {
  return permissions.has('report.company') || permissions.has(readPermission(key));
}

/** The catalogue as this caller may use it — a manager sees the four people reports. */
export function visibleGroups(
  permissions: ReadonlySet<string>,
): readonly { readonly key: string; readonly reports: readonly ReportKey[] }[] {
  return REPORT_GROUPS.map((group) => ({
    key: group.key,
    reports: group.reports.filter((key) => canRead(permissions, key)),
  })).filter((group) => group.reports.length > 0);
}

export function reportsPath(locale: string): string {
  return `/${locale}/admin/reports`;
}

export function reportPath(locale: string, key: ReportKey): string {
  return `${reportsPath(locale)}/${key}`;
}

export function myMonthlyPath(locale: string, month: string): string {
  return `/${locale}/app/reports/${month}`;
}

// ---------------------------------------------------------------------------
// Filters — DOCUMENT 18 "Filters" (mirrors the API's ALLOWED_FILTERS)
// ---------------------------------------------------------------------------

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

const PEOPLE_FILTERS: readonly FilterField[] = [
  'from',
  'to',
  'department_id',
  'employee_id',
  'status',
];

export const REPORT_FILTERS: Readonly<Record<ReportKey, readonly FilterField[]>> = {
  attendance: [...PEOPLE_FILTERS, 'work_mode'],
  performance: PEOPLE_FILTERS,
  tasks: [...PEOPLE_FILTERS, 'priority'],
  goals: [...PEOPLE_FILTERS, 'goal_type'],
  payroll: PEOPLE_FILTERS,
  inventory: ['warehouse_id', 'category_id', 'status', 'product_status'],
  warehouse: ['from', 'to', 'warehouse_id', 'movement_type'],
  'stock-movements': ['from', 'to', 'warehouse_id', 'product_id', 'movement_type', 'user_id'],
};

/** Each status filter's values, and where their labels live. */
export const REPORT_STATUSES: Readonly<
  Record<ReportKey, { readonly values: readonly string[]; readonly labelPrefix: string } | null>
> = {
  attendance: {
    values: ['present', 'late', 'absent', 'on_leave', 'half_day', 'pending', 'weekend', 'holiday'],
    labelPrefix: 'attendance.status.',
  },
  performance: {
    values: ['active', 'inactive', 'terminated'],
    labelPrefix: 'employees.status_',
  },
  tasks: {
    values: ['not_started', 'in_progress', 'on_hold', 'completed', 'cancelled'],
    labelPrefix: 'tasks.status.',
  },
  goals: { values: ['active', 'achieved', 'missed', 'cancelled'], labelPrefix: 'goals.status.' },
  payroll: {
    values: ['draft', 'under_review', 'approved', 'finalized', 'paid', 'adjusted'],
    labelPrefix: 'payroll.status.',
  },
  inventory: {
    values: ['in_stock', 'low_stock', 'out_of_stock'],
    labelPrefix: 'inventory.stock_status.',
  },
  warehouse: null,
  'stock-movements': null,
};

export type ReportFilters = Partial<Record<FilterField, string>>;

/** `YYYY-MM-DD` arithmetic on the calendar, never on a clock. */
export function monthStart(today: string): string {
  return `${today.slice(0, 7)}-01`;
}

export function monthEnd(month: string): string {
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return `${month.slice(0, 7)}-${String(last).padStart(2, '0')}`;
}

export function addMonths(month: string, delta: number): string {
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const index = year * 12 + (m - 1) + delta;
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** DOCUMENT 18: "Default range is the current month." */
export function defaultFilters(key: ReportKey, today: string): ReportFilters {
  return REPORT_FILTERS[key].includes('from')
    ? { from: monthStart(today), to: monthEnd(today.slice(0, 7)) }
    : {};
}

/** The suggestion an empty report offers: the last three months, to today. */
export function widerRange(today: string): ReportFilters {
  return { from: `${addMonths(today.slice(0, 7), -2)}-01`, to: monthEnd(today.slice(0, 7)) };
}

/** DOCUMENT 18: a range longer than 12 months needs confirmation (the API agrees). */
export function isLargeRange(from: string | undefined, to: string | undefined): boolean {
  if (from === undefined || to === undefined || from === '' || to === '') return false;
  const limit = `${addMonths(from.slice(0, 7), 12)}-${from.slice(8, 10)}`;
  return to >= limit;
}

export function activeFilterCount(key: ReportKey, filters: ReportFilters, today: string): number {
  const defaults = defaultFilters(key, today);
  return Object.entries(filters).filter(
    ([field, value]) =>
      value !== undefined && value !== '' && defaults[field as FilterField] !== value,
  ).length;
}

/** The query a report request sends — only what is set, and the page. */
export function reportQuery(
  key: ReportKey,
  filters: ReportFilters,
  page: number,
  perPage: number,
  confirmLarge: boolean,
): Record<string, string> {
  const query: Record<string, string> = { page: String(page), per_page: String(perPage) };
  for (const field of REPORT_FILTERS[key]) {
    const value = filters[field];
    if (value !== undefined && value.trim() !== '') query[field] = value.trim();
  }
  if (confirmLarge) query.confirm_large_range = 'true';
  return query;
}

/** The export body: the same filters, CSV. */
export function exportBody(
  key: ReportKey,
  filters: ReportFilters,
  confirmLarge: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = { format: 'csv' };
  for (const field of REPORT_FILTERS[key]) {
    const value = filters[field];
    if (value !== undefined && value.trim() !== '') body[field] = value.trim();
  }
  if (confirmLarge) body.confirm_large_range = true;
  return body;
}

// ---------------------------------------------------------------------------
// The payload — DOCUMENT 18 rules 4–7
// ---------------------------------------------------------------------------

export type Cell = string | number | boolean | null;
export type ReportRow = Readonly<Record<string, Cell>>;

export interface ReportPayload {
  readonly report: {
    readonly key: ReportKey;
    readonly scope:
      | { readonly type: 'company' }
      | { readonly type: 'team'; readonly manager_employee_id: string };
    readonly range: { readonly from: string; readonly to: string } | null;
    readonly filters: Readonly<Record<string, string>>;
    readonly filter_labels: Readonly<Record<string, { readonly ar: string; readonly en: string }>>;
    readonly timezone: string;
    readonly generated_at: string;
    readonly provisional: boolean;
    readonly provisional_reason: string | null;
    readonly trend_unit: 'day' | 'month' | null;
  };
  readonly summary: Readonly<Record<string, Cell>>;
  readonly groups: Readonly<Record<string, readonly ReportRow[]>>;
  readonly trend: readonly {
    readonly period: string;
    readonly values: Readonly<Record<string, Cell>>;
  }[];
  readonly rows: readonly ReportRow[];
  readonly pagination: {
    readonly page: number;
    readonly per_page: number;
    readonly total: number;
    readonly total_pages: number;
  };
}

/** How a value is shown. */
export type ColumnKind =
  | 'text'
  | 'count'
  | 'money'
  | 'quantity'
  | 'percent'
  | 'date'
  | 'datetime'
  | 'bool'
  | { readonly enumPrefix: string }
  | { readonly localized: string };

export interface Column {
  readonly field: string;
  /** `reports.column.*` */
  readonly label: string;
  readonly kind: ColumnKind;
}

const c = (field: string, kind: ColumnKind = 'count', label = field): Column => ({
  field,
  label,
  kind,
});

const PERSON: readonly Column[] = [
  c('employee_name', 'text'),
  c('employee_code', 'text'),
  c('department', { localized: 'department_name' }),
];

/** The detail table of each report — the same columns the CSV holds. */
export const REPORT_COLUMNS: Readonly<Record<ReportKey, readonly Column[]>> = {
  attendance: [
    ...PERSON,
    c('working_days'),
    c('present'),
    c('office'),
    c('wfh'),
    c('late'),
    c('half_day'),
    c('absent'),
    c('leave'),
  ],
  performance: [
    c('employee_name', 'text'),
    c('month', 'text'),
    c('department', { localized: 'department_name' }),
    c('attendance_score', 'percent'),
    c('task_score', 'percent'),
    c('goal_score', 'percent'),
    c('overall', 'percent'),
  ],
  tasks: [
    ...PERSON,
    c('assigned'),
    c('completed'),
    c('in_progress'),
    c('overdue'),
    c('completed_on_time'),
    c('completion_rate', 'percent'),
    c('on_time_rate', 'percent'),
  ],
  goals: [
    c('title', 'text'),
    c('employee_name', 'text'),
    c('type', { enumPrefix: 'goals.type.' }),
    c('status', { enumPrefix: 'goals.status.' }),
    c('period_end', 'date'),
    c('target_value', 'quantity'),
    c('current_value', 'quantity'),
    c('progress_percent', 'percent'),
  ],
  payroll: [
    c('employee_name', 'text'),
    c('period', 'text'),
    c('period_status', { enumPrefix: 'payroll.status.' }),
    c('gross', 'money'),
    c('deductions', 'money'),
    c('bonuses', 'money'),
    c('net', 'money'),
    c('adjustments_total', 'money'),
    c('adjusted_net', 'money'),
  ],
  inventory: [
    c('name', { localized: 'name' }),
    c('sku', 'text'),
    c('category', { localized: 'category_name' }),
    c('quantity', 'quantity'),
    c('total_quantity', 'quantity'),
    c('min_stock', 'quantity'),
    c('value', 'money'),
    c('stock_status', { enumPrefix: 'inventory.stock_status.' }),
  ],
  warehouse: [
    c('location', { localized: 'name' }),
    c('type', { enumPrefix: 'warehouse.type.' }),
    c('product_count'),
    c('total_quantity', 'quantity'),
    c('stock_value', 'money'),
    c('movements'),
    c('inbound_quantity', 'quantity'),
    c('outbound_quantity', 'quantity'),
  ],
  'stock-movements': [
    c('created_at', 'datetime'),
    c('product', { localized: 'product_name' }),
    c('type', { enumPrefix: 'warehouse.movement.' }),
    c('warehouse', { localized: 'warehouse_name' }),
    c('quantity', 'quantity'),
    c('unit_cost', 'money'),
    c('balance_after', 'quantity'),
    c('reason', 'text'),
  ],
};

/** The headline figures each report shows above its table. */
export const REPORT_SUMMARY: Readonly<Record<ReportKey, readonly Column[]>> = {
  attendance: [
    c('employees'),
    c('working_days'),
    c('present'),
    c('wfh'),
    c('late'),
    c('absent'),
    c('leave'),
  ],
  performance: [c('rows'), c('employees_with_score'), c('average_overall', 'percent')],
  tasks: [
    c('assigned'),
    c('completed'),
    c('in_progress'),
    c('overdue'),
    c('completion_rate', 'percent'),
    c('on_time_rate', 'percent'),
  ],
  goals: [c('goals'), c('active'), c('achieved'), c('missed'), c('achievement_rate', 'percent')],
  payroll: [
    c('lines'),
    c('gross', 'money'),
    c('deductions', 'money'),
    c('bonuses', 'money'),
    c('net', 'money'),
    c('adjusted_net', 'money'),
  ],
  inventory: [c('products'), c('inventory_value', 'money'), c('low_stock'), c('out_of_stock')],
  warehouse: [c('locations'), c('active_locations'), c('inventory_value', 'money'), c('movements')],
  'stock-movements': [c('movements'), c('types')],
};

/** The breakdowns shown under the summary, in order. */
export const REPORT_GROUP_TABLES: Readonly<
  Record<ReportKey, readonly { readonly name: string; readonly columns: readonly Column[] }[]>
> = {
  attendance: [
    {
      name: 'by_department',
      columns: [
        c('department', { localized: 'department_name' }),
        c('employees'),
        c('present'),
        c('wfh'),
        c('late'),
        c('absent'),
        c('leave'),
      ],
    },
  ],
  performance: [
    {
      name: 'by_department',
      columns: [
        c('department', { localized: 'department_name' }),
        c('month', 'text'),
        c('employees'),
        c('average_overall', 'percent'),
      ],
    },
  ],
  tasks: [
    {
      name: 'by_department',
      columns: [
        c('department', { localized: 'department_name' }),
        c('assigned'),
        c('completed'),
        c('overdue'),
        c('on_time_rate', 'percent'),
      ],
    },
    {
      name: 'by_priority',
      columns: [
        c('priority', { enumPrefix: 'tasks.priority.' }),
        c('assigned'),
        c('completed'),
        c('overdue'),
      ],
    },
  ],
  goals: [
    {
      name: 'by_type',
      columns: [
        c('type', { enumPrefix: 'goals.type.' }),
        c('goals'),
        c('achieved'),
        c('missed'),
        c('achievement_rate', 'percent'),
      ],
    },
    {
      name: 'by_employee',
      columns: [
        c('employee_name', 'text'),
        c('goals'),
        c('achieved'),
        c('missed'),
        c('achievement_rate', 'percent'),
      ],
    },
  ],
  payroll: [
    {
      name: 'by_period',
      columns: [
        c('period', 'text'),
        c('status', { enumPrefix: 'payroll.status.' }),
        c('employees'),
        c('gross', 'money'),
        c('net', 'money'),
        c('adjusted_net', 'money'),
        c('adjusted_net_change', 'money'),
      ],
    },
  ],
  inventory: [
    {
      name: 'by_category',
      columns: [c('category', { localized: 'category_name' }), c('products'), c('value', 'money')],
    },
    {
      name: 'by_location',
      columns: [c('location', { localized: 'name' }), c('products'), c('value', 'money')],
    },
  ],
  warehouse: [],
  'stock-movements': [
    {
      name: 'by_type',
      columns: [
        c('type', { enumPrefix: 'warehouse.movement.' }),
        c('movements'),
        c('quantity', 'quantity'),
      ],
    },
  ],
};

/** The trend series each report draws. */
export const REPORT_CHART: Readonly<Record<ReportKey, string | null>> = {
  attendance: 'present',
  performance: 'average_overall',
  tasks: null,
  goals: null,
  payroll: 'adjusted_net',
  inventory: null,
  warehouse: 'movements',
  'stock-movements': null,
};

/** A value for a bar's height; decimals stay strings everywhere else. */
export function chartMagnitude(value: Cell): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) {
    // Display only: a bar's height, never a figure shown or summed.
    return Number(value);
  }
  return 0;
}

/** The value of a localized pair (`department_name_ar` / `_en`) for the reader. */
export function localizedCell(row: ReportRow, base: string, locale: Locale): Cell {
  return row[`${base}_${locale}`] ?? row[`${base}_${locale === 'ar' ? 'en' : 'ar'}`] ?? null;
}

// ---------------------------------------------------------------------------
// Monthly employee reports — DOCUMENT 04 C13, DOCUMENT 18 "Employee reports"
// ---------------------------------------------------------------------------

export const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isMonthKey(value: string): boolean {
  return MONTH_KEY.test(value);
}

/** A monthly report exists only for a month that has ended (the API agrees). */
export function isClosedMonth(month: string, today: string): boolean {
  return month < today.slice(0, 7);
}

export function previousMonth(today: string): string {
  return addMonths(today.slice(0, 7), -1);
}

export interface SalarySummary {
  readonly source: 'payroll' | 'none';
  readonly period_status: string | null;
  readonly is_provisional: boolean;
  readonly base: string | null;
  readonly deductions: string | null;
  readonly bonuses: string | null;
  readonly net: string | null;
  readonly adjustments_total: string | null;
  readonly adjusted_net: string | null;
}

export type SalaryView =
  | SalarySummary
  | { readonly withheld: 'no_permission' | 'not_finalized'; readonly is_provisional: boolean };

export function isWithheld(salary: SalaryView): salary is {
  readonly withheld: 'no_permission' | 'not_finalized';
  readonly is_provisional: boolean;
} {
  return 'withheld' in salary;
}

export interface MonthlyReport {
  readonly id: string;
  readonly employee: {
    readonly id: string;
    readonly name: string;
    readonly code: string;
    readonly department_name_ar: string | null;
    readonly department_name_en: string | null;
  };
  readonly year: number;
  readonly month: number;
  readonly month_key: string;
  readonly generated_at: string;
  readonly revision: number;
  readonly is_provisional: boolean;
  readonly underlying_data_changed: boolean;
  readonly overall_score: string | null;
  readonly attendance: {
    readonly working_days: number;
    readonly present: number;
    readonly office: number;
    readonly wfh: number;
    readonly late: number;
    readonly absent: number;
    readonly leave: number;
  };
  readonly tasks: {
    readonly assigned: number;
    readonly completed: number;
    readonly in_progress: number;
    readonly overdue: number;
  };
  readonly goals: {
    readonly goals: readonly {
      readonly id: string;
      readonly title: string;
      readonly type: string;
      readonly progress_percent: string;
    }[];
  };
  readonly salary: SalaryView;
  readonly performance: {
    readonly config: {
      readonly weights: {
        readonly attendance: string;
        readonly task: string;
        readonly goal: string;
      };
    };
    readonly components: {
      readonly attendance: {
        readonly score: string | null;
        readonly no_data_reason: string | null;
      };
      readonly task: { readonly score: string | null };
      readonly goal: { readonly score: string | null };
    };
    readonly overall: string | null;
  };
  readonly can_regenerate: boolean;
}

export interface MonthlyReportListItem {
  readonly id: string;
  readonly month_key: string;
  readonly generated_at: string;
  readonly revision: number;
  readonly is_provisional: boolean;
  readonly overall_score: string | null;
}

/** "0.3000" → "30%": a weight as people read it. */
export function weightPercent(weight: string): string {
  const [whole = '0', fraction = ''] = weight.split('.');
  const hundredths = `${fraction}0000`.slice(0, 4);
  const percent = `${String(Number(whole) * 100 + Number(hundredths.slice(0, 2)))}`;
  const rest = hundredths.slice(2).replace(/0+$/, '');
  return rest === '' ? `${percent}%` : `${percent}.${rest}%`;
}

/** Monthly endpoints. */
export function monthlyReportPath(employeeId: string, month: string): string {
  return `/reports/employee/${employeeId}/monthly?month=${month}`;
}

export function monthlyActionPath(
  employeeId: string,
  month: string,
  action: 'generate' | 'regenerate',
): string {
  return `/reports/employee/${employeeId}/monthly/${month.slice(0, 4)}/${String(Number(month.slice(5, 7)))}/${action}`;
}

/**
 * What a report's CSV holds — its columns, in the reader's language, and the
 * self-describing preamble (DOCUMENT 18 rule 7: "Filters are stated on the
 * output, including in exports, so a printed report is self-describing").
 *
 * The columns are the report's detail rows — exactly the rows the caller can
 * page through on screen, no more (DOCUMENT 18 "An export never contains
 * rows the user could not see on screen"). Names that exist in two languages
 * are written in the reader's; enum values use the labels the screens use.
 */

import { createTranslator } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';

import type { CsvColumn } from './csv.js';
import type { ReportKey } from './report-catalogue.js';
import type { FilterField } from './report-filters.js';
import type { Cell, ReportMeta, ReportRow } from './report-types.js';

type Column = CsvColumn<ReportRow>;

function text(row: ReportRow, field: string): Cell {
  return row[field] ?? null;
}

function localized(row: ReportRow, base: string, locale: Locale): Cell {
  return row[`${base}_${locale}`] ?? null;
}

function enumLabel(t: Translator, prefix: string, value: Cell): Cell {
  return typeof value === 'string' ? t(`${prefix}.${value}`) : value;
}

function yesNo(t: Translator, value: Cell): Cell {
  return value === true ? t('reports.value.yes') : value === false ? t('reports.value.no') : value;
}

function col(t: Translator, name: string, value: (row: ReportRow) => Cell): Column {
  return { header: t(`reports.column.${name}`), value };
}

function plain(t: Translator, ...names: readonly string[]): Column[] {
  return names.map((name) => col(t, name, (row) => text(row, name)));
}

export function reportColumns(key: ReportKey, locale: Locale): readonly Column[] {
  const t = createTranslator(locale);
  const department = col(t, 'department', (row) => localized(row, 'department_name', locale));
  const employee = plain(t, 'employee_name', 'employee_code');
  switch (key) {
    case 'attendance':
      return [
        ...employee,
        department,
        ...plain(
          t,
          'working_days',
          'present',
          'office',
          'wfh',
          'late',
          'half_day',
          'absent',
          'leave',
        ),
      ];
    case 'performance':
      return [
        ...plain(t, 'month'),
        ...employee,
        department,
        ...plain(t, 'attendance_score', 'task_score', 'goal_score', 'overall'),
        col(t, 'provisional', (row) => yesNo(t, text(row, 'provisional'))),
      ];
    case 'tasks':
      return [
        ...employee,
        department,
        ...plain(
          t,
          'assigned',
          'completed',
          'in_progress',
          'not_started',
          'on_hold',
          'cancelled',
          'overdue',
          'completed_on_time',
          'completion_rate',
          'on_time_rate',
        ),
      ];
    case 'goals':
      return [
        ...plain(t, 'title'),
        ...employee,
        col(t, 'type', (row) => enumLabel(t, 'goals.type', text(row, 'type'))),
        col(t, 'status', (row) => enumLabel(t, 'goals.status', text(row, 'status'))),
        ...plain(
          t,
          'period_start',
          'period_end',
          'unit',
          'target_value',
          'effective_target_value',
          'current_value',
          'progress_percent',
        ),
      ];
    case 'payroll':
      return [
        ...plain(t, 'period'),
        col(t, 'period_status', (row) =>
          enumLabel(t, 'payroll.status', text(row, 'period_status')),
        ),
        col(t, 'provisional', (row) => yesNo(t, text(row, 'provisional'))),
        ...employee,
        ...plain(
          t,
          'gross',
          'attendance_adjustment',
          'deductions',
          'bonuses',
          'net',
          'adjustments_total',
          'adjusted_net',
        ),
      ];
    case 'inventory':
      return [
        ...plain(t, 'sku'),
        col(t, 'name', (row) => localized(row, 'name', locale)),
        col(t, 'category', (row) => localized(row, 'category_name', locale)),
        ...plain(t, 'unit', 'quantity', 'total_quantity', 'min_stock', 'value'),
        col(t, 'stock_status', (row) =>
          enumLabel(t, 'inventory.stock_status', text(row, 'stock_status')),
        ),
        col(t, 'product_status', (row) =>
          enumLabel(t, 'inventory.status', text(row, 'product_status')),
        ),
      ];
    case 'warehouse':
      return [
        col(t, 'location', (row) => localized(row, 'name', locale)),
        col(t, 'type', (row) => enumLabel(t, 'warehouse.type', text(row, 'type'))),
        col(t, 'is_active', (row) => yesNo(t, text(row, 'is_active'))),
        ...plain(
          t,
          'product_count',
          'total_quantity',
          'stock_value',
          'movements',
          'inbound_quantity',
          'outbound_quantity',
        ),
      ];
    case 'stock-movements':
      return [
        ...plain(t, 'created_at'),
        col(t, 'type', (row) => enumLabel(t, 'warehouse.movement', text(row, 'type'))),
        ...plain(t, 'sku'),
        col(t, 'product', (row) => localized(row, 'product_name', locale)),
        col(t, 'warehouse', (row) => localized(row, 'warehouse_name', locale)),
        ...plain(t, 'quantity', 'unit', 'unit_cost', 'balance_after', 'reason', 'created_by'),
      ];
  }
}

/** The value a filter is shown with: the referenced name, or the enum's label. */
function filterValue(t: Translator, meta: ReportMeta, field: FilterField, locale: Locale): string {
  const label = meta.filter_labels[field];
  if (label !== undefined) return label[locale];
  const value = meta.filters[field as keyof ReportMeta['filters']] ?? '';
  switch (field) {
    case 'work_mode':
      return t(`attendance.mode.${value}`);
    case 'priority':
      return t(`tasks.priority.${value}`);
    case 'goal_type':
      return t(`goals.type.${value}`);
    case 'movement_type':
      return t(`warehouse.movement.${value}`);
    case 'product_status':
      return t(`inventory.status.${value}`);
    case 'status':
      return statusLabel(t, meta.key, value);
    default:
      return value;
  }
}

function statusLabel(t: Translator, key: ReportKey, value: string): string {
  switch (key) {
    case 'attendance':
      return t(`attendance.status.${value}`);
    case 'performance':
      return t(`employees.status_${value}`);
    case 'tasks':
      return t(`tasks.status.${value}`);
    case 'goals':
      return t(`goals.status.${value}`);
    case 'payroll':
      return t(`payroll.status.${value}`);
    case 'inventory':
      return t(`inventory.stock_status.${value}`);
    default:
      return value;
  }
}

/** The preamble facts: report, scope, range, filters, timezone, time, provisional. */
export function reportPreamble(
  meta: ReportMeta,
  locale: Locale,
  companyName: string,
): readonly (readonly [string, string])[] {
  const t = createTranslator(locale);
  const facts: [string, string][] = [
    [t('reports.meta.company'), companyName],
    [t('reports.meta.report'), t(`reports.key.${meta.key}.title`)],
    [
      t('reports.meta.scope'),
      meta.scope.type === 'company'
        ? t('reports.meta.scope_company')
        : t('reports.meta.scope_team'),
    ],
  ];
  if (meta.range === null) {
    facts.push([t('reports.meta.range'), t('reports.meta.range_none')]);
  } else {
    facts.push([t('reports.meta.from'), meta.range.from], [t('reports.meta.to'), meta.range.to]);
  }
  const fields = Object.keys(meta.filters) as FilterField[];
  if (fields.length === 0) {
    facts.push([t('reports.meta.filters'), t('reports.meta.no_filters')]);
  }
  for (const field of fields) {
    facts.push([t(`reports.filter.${field}`), filterValue(t, meta, field, locale)]);
  }
  facts.push(
    [t('reports.meta.timezone'), meta.timezone],
    [t('reports.meta.generated_at'), meta.generated_at],
    [
      t('reports.meta.provisional'),
      meta.provisional
        ? `${t('reports.value.yes')} — ${t(`reports.provisional_reason.${meta.provisional_reason ?? 'period_not_ended'}`)}`
        : t('reports.value.no'),
    ],
  );
  return facts;
}

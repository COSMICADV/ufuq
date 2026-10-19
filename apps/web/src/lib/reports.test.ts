import { createTranslator, LOCALES } from '@ufuq/i18n';
import { describe, expect, it } from 'vitest';

import {
  activeFilterCount,
  addMonths,
  canRead,
  defaultFilters,
  exportBody,
  isClosedMonth,
  isLargeRange,
  isMonthKey,
  isReportKey,
  localizedCell,
  monthEnd,
  monthlyActionPath,
  monthlyReportPath,
  previousMonth,
  REPORT_COLUMNS,
  REPORT_FILTERS,
  REPORT_GROUP_TABLES,
  REPORT_GROUPS,
  REPORT_KEYS,
  REPORT_STATUSES,
  REPORT_SUMMARY,
  reportPath,
  reportQuery,
  visibleGroups,
  weightPercent,
  widerRange,
} from './reports';

const ADMIN = new Set([
  'report.company',
  'report.team',
  'report.export',
  'report.employee_monthly',
]);
const MANAGER = new Set(['report.team', 'report.export', 'report.employee_monthly']);
const EMPLOYEE = new Set(['report.employee_monthly']);

describe('the catalogue — DOCUMENT 04 B17', () => {
  it('groups all eight reports under the four documented headings', () => {
    expect(REPORT_GROUPS.map((group) => group.key)).toEqual([
      'financial',
      'attendance',
      'tasks_goals',
      'inventory',
    ]);
    expect(REPORT_GROUPS.flatMap((group) => group.reports).sort()).toEqual([...REPORT_KEYS].sort());
  });

  it('an ADMIN sees every report; a MANAGER the four people reports; an EMPLOYEE none', () => {
    expect(visibleGroups(ADMIN).flatMap((g) => g.reports)).toHaveLength(8);
    expect(
      visibleGroups(MANAGER)
        .flatMap((g) => g.reports)
        .sort(),
    ).toEqual(['attendance', 'goals', 'performance', 'tasks']);
    expect(visibleGroups(MANAGER).map((g) => g.key)).not.toContain('financial');
    expect(visibleGroups(EMPLOYEE)).toEqual([]);
    for (const key of ['payroll', 'inventory', 'warehouse', 'stock-movements'] as const) {
      expect(canRead(MANAGER, key)).toBe(false);
    }
  });

  it('routes and keys', () => {
    expect(reportPath('ar', 'stock-movements')).toBe('/ar/admin/reports/stock-movements');
    expect(isReportKey('payroll')).toBe(true);
    expect(isReportKey('salaries')).toBe(false);
  });
});

describe('filters and ranges — DOCUMENT 18 "Filters"', () => {
  it('defaults to the current month, and offers the last three months when empty', () => {
    expect(defaultFilters('attendance', '2026-05-10')).toEqual({
      from: '2026-05-01',
      to: '2026-05-31',
    });
    expect(defaultFilters('inventory', '2026-05-10')).toEqual({});
    expect(widerRange('2026-02-10')).toEqual({ from: '2025-12-01', to: '2026-02-28' });
  });

  it('a range over twelve months needs confirmation, exactly as the API decides', () => {
    expect(isLargeRange('2025-05-01', '2026-04-30')).toBe(false);
    expect(isLargeRange('2025-05-01', '2026-05-01')).toBe(true);
    expect(isLargeRange(undefined, '2026-05-01')).toBe(false);
  });

  it('a request carries only the report’s own filters, set ones only', () => {
    expect(
      reportQuery(
        'attendance',
        {
          from: '2026-04-01',
          to: '2026-04-30',
          work_mode: 'wfh',
          priority: 'high',
          employee_id: '',
        },
        2,
        25,
        false,
      ),
    ).toEqual({
      page: '2',
      per_page: '25',
      from: '2026-04-01',
      to: '2026-04-30',
      work_mode: 'wfh',
    });
    expect(reportQuery('tasks', {}, 1, 25, true)).toEqual({
      page: '1',
      per_page: '25',
      confirm_large_range: 'true',
    });
    expect(exportBody('inventory', { warehouse_id: 'w', from: '2026-04-01' }, false)).toEqual({
      format: 'csv',
      warehouse_id: 'w',
    });
    expect(exportBody('tasks', {}, true)).toEqual({ format: 'csv', confirm_large_range: true });
  });

  it('counts only filters that differ from the defaults', () => {
    expect(activeFilterCount('tasks', defaultFilters('tasks', '2026-05-10'), '2026-05-10')).toBe(0);
    expect(
      activeFilterCount(
        'tasks',
        { ...defaultFilters('tasks', '2026-05-10'), priority: 'high' },
        '2026-05-10',
      ),
    ).toBe(1);
  });

  it('calendar arithmetic is on the calendar', () => {
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2025-12', 2)).toBe('2026-02');
    expect(monthEnd('2024-02')).toBe('2024-02-29');
  });
});

/** Every value an enum column can hold, by its label prefix. */
const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  'goals.type.': ['sales', 'task', 'custom'],
  'goals.status.': ['active', 'achieved', 'missed', 'cancelled'],
  'payroll.status.': ['draft', 'under_review', 'approved', 'finalized', 'paid', 'adjusted'],
  'inventory.stock_status.': ['in_stock', 'low_stock', 'out_of_stock'],
  'warehouse.type.': ['main', 'branch', 'store', 'production', 'online'],
  'warehouse.movement.': [
    'purchase',
    'sale',
    'transfer_in',
    'transfer_out',
    'adjustment',
    'return',
    'damage',
    'manual_addition',
    'manual_removal',
  ],
  'tasks.priority.': ['low', 'medium', 'high', 'urgent'],
};

describe('every label a report screen shows exists in both languages — DOCUMENT 27 RULE 25', () => {
  for (const locale of LOCALES) {
    const t = createTranslator(locale);
    it(`${locale}`, () => {
      for (const key of REPORT_KEYS) {
        expect(t(`reports.key.${key}.title`)).not.toBe('');
        expect(t(`reports.key.${key}.description`)).not.toBe('');
        for (const column of [
          ...REPORT_COLUMNS[key],
          ...REPORT_SUMMARY[key],
          ...REPORT_GROUP_TABLES[key].flatMap((g) => g.columns),
        ]) {
          expect(t(`reports.column.${column.label}`), `${key}.${column.label}`).not.toBe('');
          if (typeof column.kind === 'object' && 'enumPrefix' in column.kind) {
            for (const value of ENUM_VALUES[column.kind.enumPrefix] ?? []) {
              expect(
                t(`${column.kind.enumPrefix}${value}`),
                `${column.kind.enumPrefix}${value}`,
              ).not.toBe('');
            }
            expect(ENUM_VALUES[column.kind.enumPrefix], column.kind.enumPrefix).toBeDefined();
          }
        }
        for (const group of REPORT_GROUP_TABLES[key])
          expect(t(`reports.section.${group.name}`)).not.toBe('');
        for (const field of REPORT_FILTERS[key]) expect(t(`reports.filter.${field}`)).not.toBe('');
        const statuses = REPORT_STATUSES[key];
        for (const status of statuses?.values ?? []) {
          expect(t(`${statuses?.labelPrefix ?? ''}${status}`), `${key} ${status}`).not.toBe('');
        }
      }
      for (const group of REPORT_GROUPS) expect(t(`reports.group.${group.key}`)).not.toBe('');
      for (const reason of ['payroll_not_finalized', 'period_not_ended', 'month_not_ended']) {
        expect(t(`reports.provisional_reason.${reason}`)).not.toBe('');
      }
    });
  }
});

describe('monthly reports — DOCUMENT 04 C13', () => {
  it('only a closed month has a report; the default is last month', () => {
    expect(isClosedMonth('2026-04', '2026-05-10')).toBe(true);
    expect(isClosedMonth('2026-05', '2026-05-10')).toBe(false);
    expect(previousMonth('2026-01-03')).toBe('2025-12');
    expect(isMonthKey('2026-13')).toBe(false);
    expect(isMonthKey('2026-04')).toBe(true);
  });

  it('builds the API paths', () => {
    expect(monthlyReportPath('e1', '2026-04')).toBe('/reports/employee/e1/monthly?month=2026-04');
    expect(monthlyActionPath('e1', '2026-04', 'regenerate')).toBe(
      '/reports/employee/e1/monthly/2026/4/regenerate',
    );
  });

  it('shows a weight as a percentage without rounding it', () => {
    expect(weightPercent('0.3000')).toBe('30%');
    expect(weightPercent('1.0000')).toBe('100%');
    expect(weightPercent('0.3333')).toBe('33.33%');
    expect(weightPercent('0.0500')).toBe('5%');
  });

  it('reads a name in the reader’s language, falling back to the other', () => {
    expect(localizedCell({ name_ar: 'قماش', name_en: 'Fabric' }, 'name', 'ar')).toBe('قماش');
    expect(localizedCell({ name_ar: null, name_en: 'Fabric' }, 'name', 'ar')).toBe('Fabric');
  });
});

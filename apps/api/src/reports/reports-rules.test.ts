/**
 * Phase 12 pure rules — DOCUMENT 18 "Filters", "Export & print", DOCUMENT 02
 * "Reports". No database: the range, the access rules, the filter rules, the
 * CSV encoding and the snapshot fingerprint.
 */

import { describe, expect, it } from 'vitest';

import type { AuthContext } from '../auth/auth-context.js';
import { AppException } from '../common/app-exception.js';

import { csvCell, csvLine, csvPreamble } from './csv.js';
import type { ReportFiltersDto } from './dto/reports.dto.js';
import { exportScope, PEOPLE_REPORTS, REPORT_KEYS, reportScope } from './report-catalogue.js';
import type { ReportKey } from './report-catalogue.js';
import { reportColumns } from './report-columns.js';
import { ALLOWED_FILTERS, checkFilters } from './report-filters.js';
import { addMonths, monthsIn, resolveRange, trendUnit } from './report-range.js';
import { canonicalJson } from './snapshot-content.js';

const TODAY = { year: 2026, month: 5, day: 10 };

function errorOf(run: () => unknown): AppException {
  try {
    run();
  } catch (error) {
    if (error instanceof AppException) return error;
    throw error;
  }
  throw new Error('expected an AppException');
}

describe('the date range — DOCUMENT 18 "Filters"', () => {
  it('defaults to the current month, first to last day', () => {
    const range = resolveRange({}, TODAY);
    expect([range.fromKey, range.toKey, range.days]).toEqual(['2026-05-01', '2026-05-31', 31]);
  });

  it('fills a missing end sensibly', () => {
    expect(resolveRange({ from: '2026-03-15' }, TODAY).toKey).toBe('2026-05-31');
    expect(resolveRange({ from: '2026-07-02' }, TODAY).toKey).toBe('2026-07-31');
    expect(resolveRange({ to: '2026-02-11' }, TODAY).fromKey).toBe('2026-02-01');
  });

  it('refuses an end before the start, and an impossible day', () => {
    expect(
      errorOf(() => resolveRange({ from: '2026-04-02', to: '2026-04-01' }, TODAY)).fields,
    ).toEqual({ to: ['end_before_start'] });
    expect(errorOf(() => resolveRange({ from: '2026-02-30' }, TODAY)).fields).toEqual({
      from: ['invalid'],
    });
  });

  it('twelve months run; one day more needs confirmation (409)', () => {
    expect(resolveRange({ from: '2025-05-01', to: '2026-04-30' }, TODAY).large).toBe(false);
    const refused = errorOf(() => resolveRange({ from: '2025-05-01', to: '2026-05-01' }, TODAY));
    expect(refused.getStatus()).toBe(409);
    expect(refused.appErrorCode).toBe('REPORT_RANGE_CONFIRMATION_REQUIRED');
    const confirmed = resolveRange(
      { from: '2025-05-01', to: '2026-05-01', confirm_large_range: true },
      TODAY,
    );
    expect(confirmed.large).toBe(true);
  });

  it('adds calendar months, clamping to the month end', () => {
    expect(addMonths({ year: 2026, month: 1, day: 31 }, 1)).toEqual({
      year: 2026,
      month: 2,
      day: 28,
    });
    expect(addMonths({ year: 2025, month: 12, day: 15 }, 2)).toEqual({
      year: 2026,
      month: 2,
      day: 15,
    });
  });

  it('trends per day up to 92 days, per month beyond', () => {
    expect(trendUnit(resolveRange({ from: '2026-02-01', to: '2026-05-03' }, TODAY))).toBe('day');
    expect(trendUnit(resolveRange({ from: '2026-02-01', to: '2026-05-04' }, TODAY))).toBe('month');
  });

  it('a range’s months stop at the current month', () => {
    const months = monthsIn(resolveRange({ from: '2026-03-20', to: '2026-08-01' }, TODAY), TODAY);
    expect(months.map((m) => m.key)).toEqual(['2026-03', '2026-04', '2026-05']);
  });
});

function ctx(
  grants: Record<string, string>,
  callerEmployeeId: string | null = 'emp-1',
): Pick<AuthContext, 'permissions' | 'callerEmployeeId'> {
  return {
    permissions: new Map(Object.entries(grants)) as AuthContext['permissions'],
    callerEmployeeId,
  };
}

const ADMIN = ctx({
  'report.company': 'company',
  'report.team': 'company',
  'report.employee_monthly': 'company',
  'report.export': 'company',
});
const MANAGER = ctx({
  'report.team': 'team',
  'report.employee_monthly': 'team',
  'report.export': 'team',
});
const EMPLOYEE = ctx({ 'report.employee_monthly': 'self' });

describe('who reads which report — DOCUMENT 02 "Reports", DOCUMENT 18 rule 4', () => {
  it('ADMIN reads every report for the whole company', () => {
    for (const key of REPORT_KEYS) {
      expect(reportScope(ADMIN, key)).toEqual({ type: 'company' });
    }
  });

  it('MANAGER reads the people reports for their team, and nothing else', () => {
    for (const key of REPORT_KEYS) {
      if (PEOPLE_REPORTS.includes(key)) {
        expect(reportScope(MANAGER, key)).toEqual({ type: 'team', manager_employee_id: 'emp-1' });
      } else {
        expect(errorOf(() => reportScope(MANAGER, key)).getStatus()).toBe(403);
      }
    }
  });

  it('a manager without an employee record is refused, never widened', () => {
    const orphan = ctx({ 'report.team': 'team' }, null);
    expect(errorOf(() => reportScope(orphan, 'attendance')).getStatus()).toBe(403);
  });

  it('EMPLOYEE reads no company report', () => {
    for (const key of REPORT_KEYS) {
      expect(errorOf(() => reportScope(EMPLOYEE, key)).getStatus()).toBe(403);
    }
  });

  it('export needs report.export AND the report’s own read — never a way into payroll', () => {
    for (const key of ['payroll', 'inventory', 'warehouse', 'stock-movements'] as const) {
      expect(errorOf(() => exportScope(MANAGER, key)).getStatus()).toBe(403);
    }
    expect(exportScope(MANAGER, 'tasks')).toEqual({ type: 'team', manager_employee_id: 'emp-1' });
    const readerOnly = ctx({ 'report.company': 'company' });
    expect(errorOf(() => exportScope(readerOnly, 'attendance')).getStatus()).toBe(403);
    expect(errorOf(() => exportScope(EMPLOYEE, 'attendance')).getStatus()).toBe(403);
  });
});

describe('filters — each report takes its own, nothing is silently ignored', () => {
  it('accepts the documented filters', () => {
    expect(
      checkFilters('attendance', {
        from: '2026-04-01',
        work_mode: 'wfh',
        status: 'late',
      } as ReportFiltersDto),
    ).toEqual({ from: '2026-04-01', work_mode: 'wfh', status: 'late' });
    expect(checkFilters('tasks', { priority: 'high' } as ReportFiltersDto)).toEqual({
      priority: 'high',
    });
  });

  it('refuses a filter the report does not take, and a status its source does not have', () => {
    expect(
      errorOf(() => checkFilters('attendance', { priority: 'high' } as ReportFiltersDto)).fields,
    ).toEqual({ priority: ['not_allowed'] });
    expect(
      errorOf(() => checkFilters('inventory', { from: '2026-04-01' } as ReportFiltersDto)).fields,
    ).toEqual({ from: ['not_allowed'] });
    expect(
      errorOf(() => checkFilters('tasks', { status: 'late' } as ReportFiltersDto)).fields,
    ).toEqual({ status: ['not_allowed'] });
  });

  it('every report has a filter list and CSV columns in both languages', () => {
    for (const key of REPORT_KEYS as readonly ReportKey[]) {
      expect(ALLOWED_FILTERS[key].length).toBeGreaterThan(0);
      for (const locale of ['ar', 'en'] as const) {
        const columns = reportColumns(key, locale);
        expect(columns.length).toBeGreaterThan(3);
        for (const column of columns) {
          expect(column.header).not.toMatch(/^reports\./);
        }
      }
    }
  });
});

describe('CSV — DOCUMENT 18 "Export & print"', () => {
  it('quotes commas, quotes, line breaks and edge spaces (RFC 4180)', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a, b')).toBe('"a, b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell(' padded')).toBe('" padded"');
    expect(csvLine(['x', null, 3, true])).toBe('x,,3,true\r\n');
  });

  it('keeps exact decimals, including negative ones, as written', () => {
    expect(csvCell('5087.25')).toBe('5087.25');
    expect(csvCell('-3.000')).toBe('-3.000');
    expect(csvCell('0.10')).toBe('0.10');
  });

  it('neutralises spreadsheet formulas in text', () => {
    expect(csvCell('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(csvCell('+201001234567')).toBe("'+201001234567");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('-x')).toBe("'-x");
  });

  it('writes Arabic as it is', () => {
    expect(csvCell('قسم المبيعات')).toBe('قسم المبيعات');
    expect(csvPreamble([['التقرير', 'الحضور']])).toBe('التقرير,الحضور\r\n\r\n');
  });
});

describe('the snapshot fingerprint is over canonical JSON', () => {
  it('equal content, any key order, one spelling', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }),
    );
    expect(canonicalJson({ a: '1.10' })).not.toBe(canonicalJson({ a: '1.1' }));
  });
});

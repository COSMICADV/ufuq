import { describe, expect, it } from 'vitest';

import {
  addDays,
  attendanceTotals,
  attendanceTrend,
  departmentAttendance,
  eachDay,
  formatPercent,
  goalProgress,
  goalTotals,
  myAttendanceCounts,
  periodRange,
  priorityLoad,
  taskTotals,
} from './insights';
import type { ReportPayload } from './reports';

type PayloadInput = Partial<Omit<ReportPayload, 'report'>> & {
  readonly report?: Partial<ReportPayload['report']>;
};

function payload(partial: PayloadInput): ReportPayload {
  return {
    summary: {},
    groups: {},
    trend: [],
    rows: [],
    pagination: { page: 1, per_page: 1, total: 0, total_pages: 1 },
    ...partial,
    report: {
      key: 'attendance',
      scope: { type: 'company' },
      range: { from: '2026-11-01', to: '2026-11-09' },
      filters: {},
      filter_labels: {},
      timezone: 'Africa/Cairo',
      generated_at: '2026-11-09T10:00:00Z',
      provisional: true,
      provisional_reason: null,
      trend_unit: 'day',
      ...partial.report,
    },
  };
}

describe('periods', () => {
  it('computes ranges that end today', () => {
    expect(periodRange('month', '2026-11-09')).toEqual({ from: '2026-11-01', to: '2026-11-09' });
    expect(periodRange('30d', '2026-11-09')).toEqual({ from: '2026-10-11', to: '2026-11-09' });
    expect(periodRange('90d', '2026-03-01')).toEqual({ from: '2025-12-02', to: '2026-03-01' });
  });

  it('walks calendar days across months', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(eachDay('2026-10-30', '2026-11-02')).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ]);
  });
});

describe('attendance', () => {
  it('fills days without records with zero columns, up to today', () => {
    const trend = attendanceTrend(
      payload({
        report: { range: { from: '2026-11-01', to: '2026-11-30' } },
        trend: [
          { period: '2026-11-02', values: { present: 4, late: 1, wfh: 2, absent: 1, leave: 0 } },
        ],
      }),
      '2026-11-03',
    );
    expect(trend.map((d) => d.period)).toEqual(['2026-11-01', '2026-11-02', '2026-11-03']);
    expect(trend[0]?.present).toBe(0);
    expect(trend[1]).toEqual({
      period: '2026-11-02',
      present: 4,
      late: 1,
      wfh: 2,
      absent: 1,
      leave: 0,
    });
  });

  it('keeps a monthly trend as sent', () => {
    const trend = attendanceTrend(
      payload({
        report: { trend_unit: 'month' },
        trend: [{ period: '2026-10', values: { present: 40 } }],
      }),
      '2026-11-09',
    );
    expect(trend).toHaveLength(1);
    expect(trend[0]?.present).toBe(40);
  });

  it('derives the attendance and lateness rates', () => {
    const totals = attendanceTotals({ working_days: 20, present: 15, late: 3, employees: 2 });
    expect(totals.rate).toBe(75);
    expect(totals.lateRate).toBe(20);
    expect(attendanceTotals({ working_days: 0, present: 0 }).rate).toBeNull();
  });

  it('ranks departments by attendance rate in the caller’s language', () => {
    const rows = departmentAttendance(
      [
        {
          department_id: 'a',
          department_name_en: 'Sales',
          department_name_ar: 'المبيعات',
          employees: 2,
          present: 5,
          working_days: 10,
        },
        {
          department_id: 'b',
          department_name_en: 'Ops',
          department_name_ar: 'العمليات',
          employees: 1,
          present: 9,
          working_days: 10,
        },
        {
          department_id: null,
          department_name_en: null,
          department_name_ar: null,
          employees: 1,
          present: 0,
          working_days: 0,
        },
      ],
      'ar',
    );
    expect(rows.map((r) => r.name)).toEqual(['العمليات', 'المبيعات', null]);
    expect(rows[0]?.rate).toBe(90);
    expect(rows[2]?.rate).toBeNull();
  });

  it('counts an employee’s own month, skipping rest days and treating an open day as attended', () => {
    const counts = myAttendanceCounts([
      { status: 'present' },
      { status: 'late' },
      { status: 'weekend' },
      { status: 'absent' },
      { status: 'pending' },
      { status: null },
      { status: 'on_leave' },
    ]);
    expect(counts).toEqual({
      present: 2,
      late: 1,
      half_day: 0,
      absent: 1,
      on_leave: 1,
      workingDays: 5,
    });
  });
});

describe('tasks and goals', () => {
  it('reads task counts and rates', () => {
    const totals = taskTotals({
      assigned: 10,
      not_started: 2,
      in_progress: 3,
      on_hold: 1,
      completed: 4,
      overdue: 2,
      completion_rate: '40.00',
      on_time_rate: null,
    });
    expect(totals.byStatus.in_progress).toBe(3);
    expect(totals.completionRate).toBe(40);
    expect(totals.onTimeRate).toBeNull();
  });

  it('orders priorities most urgent first and drops empty ones', () => {
    const load = priorityLoad([
      { priority: 'low', assigned: 2, completed: 1 },
      { priority: 'urgent', assigned: 1, completed: 0 },
      { priority: 'high', assigned: 0, completed: 0 },
    ]);
    expect(load.map((p) => p.priority)).toEqual(['urgent', 'low']);
  });

  it('reads goal counts and caps progress bars at 100', () => {
    expect(
      goalTotals({ goals: 5, active: 2, achieved: 2, missed: 1, achievement_rate: '66.67' })
        .achievementRate,
    ).toBeCloseTo(66.67);
    expect(goalProgress('150', '100')).toEqual({ bar: 100, value: 150 });
    expect(goalProgress('0', '0')).toEqual({ bar: 0, value: null });
  });

  it('formats percentages for both languages', () => {
    expect(formatPercent(75, 'en')).toBe('75%');
    expect(formatPercent(4.5, 'en')).toBe('4.5%');
    expect(formatPercent(null, 'en')).toBe('—');
    expect(formatPercent(75, 'ar')).toBe('٧٥%');
  });
});

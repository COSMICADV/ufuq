/**
 * The attendance screens' pure logic — DOCUMENT 04 B5–B7, C2–C4, DOCUMENT 12.
 *
 * These are display decisions, not attendance decisions: nothing here computes
 * lateness or overtime, and the tests that matter are the ones that would
 * silently produce a wrong-looking screen — an off-by-one calendar, a filter
 * that does not reach the API, a window that offers an action the server will
 * refuse.
 */

import { describe, expect, it } from 'vitest';

import {
  activeFilterCount,
  boardFiltersFromParams,
  boardQuery,
  boardUrlQuery,
  calendarGrid,
  DEFAULT_CORRECTION_WINDOW_DAYS,
  formatDuration,
  isDate,
  isMonth,
  monthOf,
  shiftMonth,
  STATUS_TONE,
  statusKey,
  summarise,
  withinCorrectionWindow,
  ATTENDANCE_STATUSES,
} from './attendance';
import type { AttendanceStatus, MonthlyCell } from './attendance';

describe('statuses', () => {
  it('names all eight DOCUMENT 12 statuses', () => {
    expect([...ATTENDANCE_STATUSES].sort()).toEqual(
      ['absent', 'half_day', 'holiday', 'late', 'on_leave', 'pending', 'present', 'weekend'].sort(),
    );
  });

  it('gives every status a tone, so no screen invents a colour', () => {
    for (const status of ATTENDANCE_STATUSES) {
      expect(STATUS_TONE[status]).toBeTruthy();
    }
  });

  it('keys every status into the catalogue rather than printing the enum', () => {
    expect(statusKey('half_day')).toBe('attendance.status.half_day');
  });
});

describe('durations', () => {
  it('formats minutes as H:MM with padded minutes', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(59)).toBe('0:59');
    expect(formatDuration(60)).toBe('1:00');
    expect(formatDuration(425)).toBe('7:05');
  });

  it('has nothing to show for a day that is still open', () => {
    expect(formatDuration(null)).toBeNull();
  });
});

describe('months and dates', () => {
  it('accepts a real month and refuses a thirteenth one', () => {
    expect(isMonth('2026-03')).toBe(true);
    expect(isMonth('2026-13')).toBe(false);
    expect(isMonth('2026-00')).toBe(false);
    expect(isMonth('March')).toBe(false);
  });

  it('refuses a date that does not exist', () => {
    expect(isDate('2026-02-28')).toBe(true);
    expect(isDate('2026-02-30')).toBe(false);
    expect(isDate('2024-02-29')).toBe(true);
  });

  it('steps across a year boundary', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-03', 0)).toBe('2026-03');
  });

  it('reads the month out of a date', () => {
    expect(monthOf('2026-03-17')).toBe('2026-03');
  });
});

describe('the daily board’s filters — DOCUMENT 04 B5', () => {
  it('defaults to today and ignores a date that is not real', () => {
    expect(boardFiltersFromParams(new URLSearchParams(''), '2026-03-02').date).toBe('2026-03-02');
    expect(boardFiltersFromParams(new URLSearchParams('date=2026-02-30'), '2026-03-02').date).toBe(
      '2026-03-02',
    );
    expect(boardFiltersFromParams(new URLSearchParams('date=2026-03-09'), '2026-03-02').date).toBe(
      '2026-03-09',
    );
  });

  it('counts only the filters that narrow the board, not the date', () => {
    const filters = boardFiltersFromParams(
      new URLSearchParams('status=late&work_mode=wfh'),
      '2026-03-02',
    );
    expect(activeFilterCount(filters)).toBe(2);
    expect(activeFilterCount({ ...filters, status: '', workMode: '' })).toBe(0);
  });

  it('always sends a date to the API — DOCUMENT 08 §4.4 requires a window', () => {
    const filters = boardFiltersFromParams(new URLSearchParams(''), '2026-03-02');
    const query = new URLSearchParams(boardQuery(filters, 1, 20));
    expect(query.get('date')).toBe('2026-03-02');
    expect(query.get('per_page')).toBe('20');
    expect(query.has('status')).toBe(false);
  });

  it('sends only the filters that are set', () => {
    const filters = boardFiltersFromParams(
      new URLSearchParams('status=late&department_id=d1'),
      '2026-03-02',
    );
    const query = new URLSearchParams(boardQuery(filters, 2, 50));
    expect(query.get('status')).toBe('late');
    expect(query.get('department_id')).toBe('d1');
    expect(query.has('work_mode')).toBe(false);
    expect(query.get('page')).toBe('2');
  });

  it('keeps the board linkable, leaving today implicit', () => {
    const today = boardFiltersFromParams(new URLSearchParams(''), '2026-03-02');
    expect(boardUrlQuery(today, '2026-03-02')).toBe('');

    const narrowed = boardFiltersFromParams(
      new URLSearchParams('date=2026-03-09&status=absent'),
      '2026-03-02',
    );
    const url = new URLSearchParams(boardUrlQuery(narrowed, '2026-03-02').slice(1));
    expect(url.get('date')).toBe('2026-03-09');
    expect(url.get('status')).toBe('absent');
  });
});

describe('the correction window — DOCUMENT 12 rule 13', () => {
  const week = DEFAULT_CORRECTION_WINDOW_DAYS;

  it('offers a correction for a day inside the window', () => {
    expect(withinCorrectionWindow('2026-03-16', '2026-03-20', week)).toBe(true);
  });

  it('does not offer one for today or a future day', () => {
    expect(withinCorrectionWindow('2026-03-20', '2026-03-20', week)).toBe(false);
    expect(withinCorrectionWindow('2026-03-25', '2026-03-20', week)).toBe(false);
  });

  it('stops offering one exactly one day past the window', () => {
    // 7 days before the 20th is the 13th.
    expect(week).toBe(7);
    expect(withinCorrectionWindow('2026-03-13', '2026-03-20', week)).toBe(true);
    expect(withinCorrectionWindow('2026-03-12', '2026-03-20', week)).toBe(false);
  });

  it('follows the company’s own window, not the default', () => {
    // The same day is outside a 7-day window and inside a 30-day one. This is
    // the whole point of DOCUMENT 12 rule 13 being "configurable per company".
    expect(withinCorrectionWindow('2026-03-01', '2026-03-20', 7)).toBe(false);
    expect(withinCorrectionWindow('2026-03-01', '2026-03-20', 30)).toBe(true);
    // A one-day window reaches yesterday and nothing before it.
    expect(withinCorrectionWindow('2026-03-19', '2026-03-20', 1)).toBe(true);
    expect(withinCorrectionWindow('2026-03-18', '2026-03-20', 1)).toBe(false);
  });
});

describe('the month calendar — DOCUMENT 04 C3', () => {
  function cell(date: string, status: AttendanceStatus | null): MonthlyCell {
    return { date, status, work_mode: null, record_id: null };
  }

  it('pads the first row so day one sits under its weekday', () => {
    // 2026-03-01 is a Sunday, the first column — no padding.
    expect(calendarGrid('2026-03', [cell('2026-03-01', 'weekend')])[0]).not.toBeNull();
    // 2026-04-01 is a Wednesday — three blanks before it.
    const april = calendarGrid('2026-04', [cell('2026-04-01', 'present')]);
    expect(april.slice(0, 3)).toEqual([null, null, null]);
    expect(april[3]?.date).toBe('2026-04-01');
  });

  it('is empty for a month that is not one', () => {
    expect(calendarGrid('2026-13', [])).toEqual([]);
  });
});

describe('the summary chips — DOCUMENT 04 C2', () => {
  it('counts each status and leaves the rest at zero', () => {
    const counts = summarise([
      { status: 'present' },
      { status: 'present' },
      { status: 'late' },
      { status: null },
    ]);
    expect(counts.present).toBe(2);
    expect(counts.late).toBe(1);
    expect(counts.absent).toBe(0);
  });

  it('reports every status, so a chip row never has a hole in it', () => {
    const counts = summarise([]);
    expect(Object.keys(counts).sort()).toEqual([...ATTENDANCE_STATUSES].sort());
  });
});

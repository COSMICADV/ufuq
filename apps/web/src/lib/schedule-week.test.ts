/**
 * The working-week model — DOCUMENT 12, DOCUMENT 27 RULE 12.
 *
 * The first test is the one that matters most: a blank week has no working
 * days. If this file ever grows a fixture that quietly says "Sunday to
 * Thursday, nine to five", the product has acquired a default working week in
 * the place least likely to be reviewed.
 */

import { describe, expect, it } from 'vitest';

import {
  blankWeek,
  DAYS_IN_WEEK,
  toRequestDays,
  toWeek,
  weekIssues,
  withDay,
  type WeekDay,
} from './schedule-week';

function workingDay(day: number, start = '09:00', end = '17:00'): WeekDay {
  return { day_of_week: day, is_working_day: true, start_time: start, end_time: end };
}

describe('blankWeek', () => {
  it('assumes nothing about which days are worked', () => {
    const week = blankWeek();
    expect(week).toHaveLength(DAYS_IN_WEEK);
    expect(week.every((day) => !day.is_working_day)).toBe(true);
    expect(week.every((day) => day.start_time === null && day.end_time === null)).toBe(true);
  });

  it('covers every weekday exactly once, in order', () => {
    expect(blankWeek().map((day) => day.day_of_week)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

describe('toWeek', () => {
  it('orders days that arrived out of order', () => {
    const week = toWeek([workingDay(4), workingDay(1), workingDay(6)]);
    expect(week.map((day) => day.day_of_week)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('fills a gap with a non-working day rather than leaving a hole', () => {
    const week = toWeek([workingDay(0)]);
    expect(week).toHaveLength(DAYS_IN_WEEK);
    expect(week[3]).toEqual({
      day_of_week: 3,
      is_working_day: false,
      start_time: null,
      end_time: null,
    });
  });

  it('keeps the hours of the days that were supplied', () => {
    const week = toWeek([workingDay(2, '08:30', '16:30')]);
    expect(week[2]).toMatchObject({ start_time: '08:30', end_time: '16:30' });
  });
});

describe('weekIssues', () => {
  it('reports nothing for a week that is internally consistent', () => {
    const week = toWeek([workingDay(1), workingDay(2), workingDay(3)]);
    expect(weekIssues(week).size).toBe(0);
  });

  it('reports a working day with no hours', () => {
    const week = withDay(blankWeek(), {
      day_of_week: 2,
      is_working_day: true,
      start_time: null,
      end_time: null,
    });
    expect(weekIssues(week).get(2)).toBe('required');
  });

  it('reports a working day missing only its end time', () => {
    const week = withDay(blankWeek(), {
      day_of_week: 2,
      is_working_day: true,
      start_time: '09:00',
      end_time: null,
    });
    expect(weekIssues(week).get(2)).toBe('required');
  });

  it('reports an end time before the start time', () => {
    const week = withDay(blankWeek(), workingDay(5, '17:00', '09:00'));
    expect(weekIssues(week).get(5)).toBe('end_before_start');
  });

  it('reports an end time equal to the start time — a zero-length day', () => {
    const week = withDay(blankWeek(), workingDay(5, '09:00', '09:00'));
    expect(weekIssues(week).get(5)).toBe('end_before_start');
  });

  it('ignores hours left over on a day that is no longer worked', () => {
    const week = withDay(blankWeek(), {
      day_of_week: 5,
      is_working_day: false,
      start_time: '17:00',
      end_time: '09:00',
    });
    expect(weekIssues(week).size).toBe(0);
  });

  it('accepts a week with no working days at all — the server decides, not this', () => {
    expect(weekIssues(blankWeek()).size).toBe(0);
  });
});

describe('toRequestDays', () => {
  it('drops hours from a day the admin unmarked', () => {
    const week = withDay(blankWeek(), {
      day_of_week: 3,
      is_working_day: false,
      start_time: '09:00',
      end_time: '17:00',
    });
    expect(toRequestDays(week)[3]).toEqual({
      day_of_week: 3,
      is_working_day: false,
      start_time: null,
      end_time: null,
    });
  });

  it('always sends all seven days', () => {
    expect(toRequestDays([workingDay(0)])).toHaveLength(DAYS_IN_WEEK);
  });

  it('leaves the hours of a working day alone', () => {
    expect(toRequestDays([workingDay(1, '07:15', '15:45')])[1]).toMatchObject({
      is_working_day: true,
      start_time: '07:15',
      end_time: '15:45',
    });
  });
});

describe('withDay', () => {
  it('changes one day and no other', () => {
    const before = toWeek([workingDay(1), workingDay(2)]);
    const after = withDay(before, workingDay(1, '10:00', '18:00'));

    expect(after[1]).toMatchObject({ start_time: '10:00', end_time: '18:00' });
    expect(after[2]).toEqual(before[2]);
    expect(after).toHaveLength(DAYS_IN_WEEK);
  });
});

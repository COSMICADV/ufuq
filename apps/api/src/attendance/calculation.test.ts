/**
 * The calculation engine against the schedule configuration — DOCUMENT 12
 * business rules 4–7, DOCUMENT 25 Phase 6 exit criterion ("every calculation
 * matching the schedule configuration").
 *
 * Every case states the configuration it is a consequence of. Nothing here
 * assumes a working week: each test builds the schedule it needs, and the
 * cases that matter are the ones where two different configurations give two
 * different answers for identical attendance.
 */

import { describe, expect, it } from 'vitest';

import {
  calculateDay,
  dayWithoutLeave,
  lateMinutesFor,
  overtimeMinutesFor,
  scheduledEndInstant,
  scheduledMinutes,
  workingMinutesFor,
} from './calculation.js';
import type { ScheduleDay, ScheduleSettings } from './calculation.js';
import { instantAt, minutesFromTime, parseCalendarDate } from './zoned-time.js';

const CAIRO = 'Africa/Cairo';
const DATE = parseCalendarDate('2026-03-02') as NonNullable<ReturnType<typeof parseCalendarDate>>;

function schedule(overrides: Partial<ScheduleSettings> = {}): ScheduleSettings {
  return {
    timezone: CAIRO,
    gracePeriodMinutes: 15,
    breakMinutes: 60,
    halfDayThresholdHours: 4,
    overtimePolicy: 'paid',
    ...overrides,
  };
}

/** 09:00–17:00 unless a test says otherwise. */
function workingDay(overrides: Partial<ScheduleDay> = {}): ScheduleDay {
  return { isWorkingDay: true, startMinutes: 9 * 60, endMinutes: 17 * 60, ...overrides };
}

const restDay: ScheduleDay = { isWorkingDay: false, startMinutes: null, endMinutes: null };

/** A wall-clock time on the test date, in the schedule's zone. */
function at(hours: number, minutes = 0, timeZone = CAIRO): Date {
  return instantAt(DATE, hours * 60 + minutes, timeZone);
}

describe('scheduled minutes — the expectation the day is measured against', () => {
  it('is the configured span net of the unpaid break', () => {
    expect(scheduledMinutes(workingDay(), schedule())).toBe(480 - 60);
  });

  it('follows the configuration, not a default week', () => {
    const short = workingDay({ startMinutes: 10 * 60, endMinutes: 14 * 60 });
    expect(scheduledMinutes(short, schedule({ breakMinutes: 0 }))).toBe(240);
  });

  it('is zero on a rest day, so everything worked there is beyond schedule', () => {
    expect(scheduledMinutes(restDay, schedule())).toBe(0);
  });
});

describe('lateness — DOCUMENT 12 rule 4', () => {
  it('is not late within the grace period', () => {
    expect(
      lateMinutesFor({ date: DATE, schedule: schedule(), day: workingDay(), checkInAt: at(9, 15) }),
    ).toBe(0);
  });

  it('is late one minute past grace, and counts from the scheduled start', () => {
    expect(
      lateMinutesFor({ date: DATE, schedule: schedule(), day: workingDay(), checkInAt: at(9, 16) }),
    ).toBe(16);
  });

  it('a longer grace period forgives the same arrival', () => {
    const arrival = at(9, 20);
    expect(
      lateMinutesFor({ date: DATE, schedule: schedule(), day: workingDay(), checkInAt: arrival }),
    ).toBe(20);
    expect(
      lateMinutesFor({
        date: DATE,
        schedule: schedule({ gracePeriodMinutes: 30 }),
        day: workingDay(),
        checkInAt: arrival,
      }),
    ).toBe(0);
  });

  it('an earlier scheduled start makes the same arrival later', () => {
    const arrival = at(9, 30);
    expect(
      lateMinutesFor({
        date: DATE,
        schedule: schedule({ gracePeriodMinutes: 0 }),
        day: workingDay({ startMinutes: 8 * 60 }),
        checkInAt: arrival,
      }),
    ).toBe(90);
  });

  it('arriving early is never negative', () => {
    expect(
      lateMinutesFor({ date: DATE, schedule: schedule(), day: workingDay(), checkInAt: at(8, 30) }),
    ).toBe(0);
  });

  it('is zero on a rest day — there is no start to be late for', () => {
    expect(
      lateMinutesFor({ date: DATE, schedule: schedule(), day: restDay, checkInAt: at(11) }),
    ).toBe(0);
  });

  it('reads the start in the schedule’s zone, not the machine’s', () => {
    // One instant, two schedules. 07:30 UTC is 09:30 in Cairo (UTC+2 on this
    // date) — half an hour late against a 09:00 start — and 07:30 in London
    // (UTC+0), which is early. Only the schedule's own zone decides; a machine
    // set to either would otherwise change the answer.
    const arrival = new Date('2026-03-02T07:30:00Z');
    expect(
      lateMinutesFor({
        date: DATE,
        schedule: schedule({ gracePeriodMinutes: 0 }),
        day: workingDay(),
        checkInAt: arrival,
      }),
    ).toBe(30);
    expect(
      lateMinutesFor({
        date: DATE,
        schedule: schedule({ gracePeriodMinutes: 0, timezone: 'Europe/London' }),
        day: workingDay(),
        checkInAt: arrival,
      }),
    ).toBe(0);
  });
});

describe('working minutes — DOCUMENT 12 rule 5', () => {
  it('is the span less the unpaid break', () => {
    expect(workingMinutesFor(at(9), at(17), schedule())).toBe(420);
  });

  it('follows the configured break', () => {
    expect(workingMinutesFor(at(9), at(17), schedule({ breakMinutes: 0 }))).toBe(480);
    expect(workingMinutesFor(at(9), at(17), schedule({ breakMinutes: 30 }))).toBe(450);
  });

  it('is null while the day is still open', () => {
    expect(workingMinutesFor(at(9), null, schedule())).toBeNull();
    expect(workingMinutesFor(null, null, schedule())).toBeNull();
  });

  it('never goes negative when the break exceeds the time present', () => {
    expect(workingMinutesFor(at(9), at(9, 20), schedule())).toBe(0);
  });
});

describe('overtime — DOCUMENT 12 rule 6', () => {
  it('is the excess over the scheduled day', () => {
    const working = workingMinutesFor(at(9), at(19), schedule());
    expect(
      overtimeMinutesFor(working, scheduledMinutes(workingDay(), schedule()), schedule()),
    ).toBe(120);
  });

  it('is zero when the day is not overrun', () => {
    const working = workingMinutesFor(at(9), at(17), schedule());
    expect(
      overtimeMinutesFor(working, scheduledMinutes(workingDay(), schedule()), schedule()),
    ).toBe(0);
  });

  it('is never negative on a short day — that is what half_day records', () => {
    const working = workingMinutesFor(at(9), at(12), schedule());
    expect(
      overtimeMinutesFor(working, scheduledMinutes(workingDay(), schedule()), schedule()),
    ).toBe(0);
  });

  it('is not recognised at all under the `none` policy', () => {
    const none = schedule({ overtimePolicy: 'none' });
    const working = workingMinutesFor(at(9), at(19), none);
    expect(overtimeMinutesFor(working, scheduledMinutes(workingDay(), none), none)).toBe(0);
  });

  it('records the same number under `paid` and `banked` — the difference is payroll’s', () => {
    const paid = schedule({ overtimePolicy: 'paid' });
    const banked = schedule({ overtimePolicy: 'banked' });
    const working = workingMinutesFor(at(9), at(19), paid);
    expect(overtimeMinutesFor(working, scheduledMinutes(workingDay(), paid), paid)).toBe(
      overtimeMinutesFor(working, scheduledMinutes(workingDay(), banked), banked),
    );
  });

  it('counts a whole rest day worked as overtime', () => {
    const working = workingMinutesFor(at(10), at(14), schedule({ breakMinutes: 0 }));
    expect(
      overtimeMinutesFor(
        working,
        scheduledMinutes(restDay, schedule()),
        schedule({ breakMinutes: 0 }),
      ),
    ).toBe(240);
  });
});

describe('the status of a day — every value DOCUMENT 12 lists', () => {
  const base = { date: DATE, schedule: schedule(), day: workingDay(), isHoliday: false };

  it('present — on time and a full day', () => {
    const result = calculateDay({ ...base, checkInAt: at(9), checkOutAt: at(17) });
    expect(result).toEqual({
      status: 'present',
      workingMinutes: 420,
      overtimeMinutes: 0,
      lateMinutes: 0,
    });
  });

  it('late — past grace, but a full day', () => {
    const result = calculateDay({ ...base, checkInAt: at(9, 30), checkOutAt: at(18) });
    expect(result.status).toBe('late');
    expect(result.lateMinutes).toBe(30);
  });

  it('half_day — below the configured threshold', () => {
    const result = calculateDay({ ...base, checkInAt: at(9), checkOutAt: at(12) });
    expect(result.status).toBe('half_day');
    expect(result.workingMinutes).toBe(120);
  });

  it('the half-day threshold is configuration, not a constant', () => {
    const shift = { ...base, checkInAt: at(9), checkOutAt: at(14) };
    // 09:00–14:00 less the 60-minute break is 240 worked minutes: a half day
    // under a 5-hour threshold, a whole one under a 3-hour threshold. Same
    // attendance, different configuration, different status.
    expect(
      calculateDay({ ...shift, schedule: schedule({ halfDayThresholdHours: 5 }) }).status,
    ).toBe('half_day');
    expect(
      calculateDay({ ...shift, schedule: schedule({ halfDayThresholdHours: 3 }) }).status,
    ).toBe('present');
  });

  it('half_day outranks late, and the lateness is still recorded', () => {
    const result = calculateDay({ ...base, checkInAt: at(10), checkOutAt: at(12) });
    expect(result.status).toBe('half_day');
    expect(result.lateMinutes).toBe(60);
  });

  it('pending — checked in, never checked out', () => {
    const result = calculateDay({ ...base, checkInAt: at(9), checkOutAt: null });
    expect(result).toEqual({
      status: 'pending',
      workingMinutes: null,
      overtimeMinutes: null,
      lateMinutes: 0,
    });
  });

  it('absent — a working day with nothing on it', () => {
    const result = calculateDay({ ...base, checkInAt: null, checkOutAt: null });
    expect(result.status).toBe('absent');
    expect(result.workingMinutes).toBe(0);
  });

  it('weekend — a rest day with nothing on it', () => {
    const result = calculateDay({ ...base, day: restDay, checkInAt: null, checkOutAt: null });
    expect(result.status).toBe('weekend');
  });

  it('holiday — and a holiday outranks a rest day', () => {
    expect(
      calculateDay({ ...base, isHoliday: true, checkInAt: null, checkOutAt: null }).status,
    ).toBe('holiday');
    expect(
      calculateDay({ ...base, day: restDay, isHoliday: true, checkInAt: null, checkOutAt: null })
        .status,
    ).toBe('holiday');
  });

  it('a day actually worked describes itself, whatever the calendar said', () => {
    // DOCUMENT 12's non-working-day confirmation exists so this can happen.
    const onHoliday = calculateDay({
      ...base,
      day: restDay,
      isHoliday: true,
      checkInAt: at(10),
      checkOutAt: at(15),
      schedule: schedule({ breakMinutes: 0 }),
    });
    expect(onHoliday.status).toBe('present');
    expect(onHoliday.workingMinutes).toBe(300);
    expect(onHoliday.lateMinutes).toBe(0);
    expect(onHoliday.overtimeMinutes).toBe(300);
  });
});

describe('closing a forgotten record — DOCUMENT 12 edge case', () => {
  it('closes at the scheduled end time in the schedule’s zone', () => {
    const end = scheduledEndInstant(DATE, workingDay(), schedule());
    expect(end?.toISOString()).toBe(at(17).toISOString());
  });

  it('has nothing to close at on a rest day, rather than inventing a time', () => {
    expect(scheduledEndInstant(DATE, restDay, schedule())).toBeNull();
  });
});

describe('a TIME column is read as wall-clock, not shifted by the host zone', () => {
  it('reads 09:00 as 540 minutes', () => {
    expect(minutesFromTime(new Date('1970-01-01T09:00:00Z'))).toBe(540);
  });
});

describe('a day cancelled leave hands back — reconciled, never deleted', () => {
  function without(input: {
    day: ScheduleDay;
    isHoliday?: boolean;
    beforeToday: boolean;
    checkInAt?: Date | null;
    checkOutAt?: Date | null;
  }) {
    return dayWithoutLeave({
      date: DATE,
      schedule: schedule(),
      day: input.day,
      checkInAt: input.checkInAt ?? null,
      checkOutAt: input.checkOutAt ?? null,
      isHoliday: input.isHoliday ?? false,
      beforeToday: input.beforeToday,
    });
  }

  it('a past working day with no attendance is what the nightly job writes: absent', () => {
    expect(without({ day: workingDay(), beforeToday: true })).toEqual(
      calculateDay({
        date: DATE,
        schedule: schedule(),
        day: workingDay(),
        checkInAt: null,
        checkOutAt: null,
        isHoliday: false,
      }),
    );
    expect(without({ day: workingDay(), beforeToday: true }).status).toBe('absent');
  });

  it('today or a later working day is not an absence yet: pending, no minutes', () => {
    expect(without({ day: workingDay(), beforeToday: false })).toEqual({
      status: 'pending',
      workingMinutes: null,
      overtimeMinutes: null,
      lateMinutes: null,
    });
  });

  it('holidays and rest days take their calendar status, past or future', () => {
    for (const beforeToday of [true, false]) {
      expect(without({ day: workingDay(), isHoliday: true, beforeToday }).status).toBe('holiday');
      expect(without({ day: restDay, beforeToday }).status).toBe('weekend');
    }
  });

  it('real check-in and check-out times are never discarded; they decide the status', () => {
    const worked = without({
      day: workingDay(),
      beforeToday: false,
      checkInAt: at(9, 30),
      checkOutAt: at(17, 0),
    });
    expect(worked.status).toBe('late');
    expect(worked.lateMinutes).toBe(30);
  });
});

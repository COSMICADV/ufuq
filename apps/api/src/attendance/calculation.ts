/**
 * The attendance calculation engine — DOCUMENT 12 business rules 4–7, and the
 * single place any of them is expressed (DOCUMENT 27 RULES 6 and 7).
 *
 * Every function here is pure: a day, a schedule, and what the employee
 * actually did go in; the derived minutes and the status come out. Nothing
 * reads the clock, the database or the environment, which is what makes the
 * whole of DOCUMENT 25 Phase 6's exit criterion — "every calculation matching
 * the schedule configuration" — something a test can state directly.
 *
 * Nothing about a working week is written down here. Start, end, grace, break,
 * the half-day threshold and the overtime policy all arrive as arguments from
 * `work_schedules` / `work_schedule_days` (DOCUMENT 27 RULE 12).
 */

import { hoursToMinutes, minutesBetween } from './minutes.js';
import type { CalendarDate } from './zoned-time.js';
import { instantAt } from './zoned-time.js';

export type AttendanceStatusValue =
  | 'present'
  | 'absent'
  | 'late'
  | 'on_leave'
  | 'half_day'
  | 'holiday'
  | 'weekend'
  | 'pending';

export type OvertimePolicyValue = 'none' | 'paid' | 'banked';

/** The schedule as the engine needs it — DOCUMENT 06 §3.7. */
export interface ScheduleSettings {
  readonly timezone: string;
  readonly gracePeriodMinutes: number;
  readonly breakMinutes: number;
  /** DOCUMENT 06 §3.7 stores this as DECIMAL; 4.5 hours is an ordinary value. */
  readonly halfDayThresholdHours: number;
  readonly overtimePolicy: OvertimePolicyValue;
}

/** One weekday of the schedule — DOCUMENT 06 §3.8. */
export interface ScheduleDay {
  readonly isWorkingDay: boolean;
  /** Minutes from midnight. Null exactly when `isWorkingDay` is false. */
  readonly startMinutes: number | null;
  readonly endMinutes: number | null;
}

export interface DayCalculationInput {
  readonly date: CalendarDate;
  readonly schedule: ScheduleSettings;
  readonly day: ScheduleDay;
  readonly checkInAt: Date | null;
  readonly checkOutAt: Date | null;
  /** A holiday on this date (DOCUMENT 06 §3.9) outranks the weekly pattern. */
  readonly isHoliday: boolean;
}

export interface DayCalculation {
  readonly status: AttendanceStatusValue;
  readonly workingMinutes: number | null;
  readonly overtimeMinutes: number | null;
  readonly lateMinutes: number | null;
}

/**
 * The minutes the schedule expects on this day, net of the unpaid break.
 *
 * Net of the break because `workingMinutes` is also net of it (DOCUMENT 12
 * rule 5), and rule 6 compares the two: measuring one gross and the other net
 * would hand every employee the break as overtime.
 *
 * Zero on a non-working day, which is what makes DOCUMENT 12's "employee works
 * on a rest day" case fall out of rule 6 rather than needing a rule of its
 * own — all of it is beyond what was scheduled.
 */
export function scheduledMinutes(day: ScheduleDay, schedule: ScheduleSettings): number {
  if (!day.isWorkingDay || day.startMinutes === null || day.endMinutes === null) {
    return 0;
  }
  return Math.max(0, day.endMinutes - day.startMinutes - schedule.breakMinutes);
}

/**
 * DOCUMENT 12 rule 4 — `check_in_at > scheduled_start + grace_period`.
 *
 * The grace period decides *whether* the day counts as late; the minutes
 * recorded are measured from the scheduled start, not from the end of grace.
 * Arriving 20 minutes after a 09:00 start with 15 minutes of grace is late by
 * 20, not by 5. DOCUMENT 12 defines the condition and not the quantity — this
 * reading is stated in docs/PHASE-6-STATUS.md, because payroll will divide by
 * it.
 *
 * Returns 0 on a non-working day and whenever the arrival is within grace.
 */
export function lateMinutesFor(input: {
  readonly date: CalendarDate;
  readonly schedule: ScheduleSettings;
  readonly day: ScheduleDay;
  readonly checkInAt: Date | null;
}): number {
  const { date, schedule, day, checkInAt } = input;
  if (checkInAt === null || !day.isWorkingDay || day.startMinutes === null) {
    return 0;
  }
  const start = instantAt(date, day.startMinutes, schedule.timezone);
  const allowed = start.getTime() + schedule.gracePeriodMinutes * 60_000;
  if (checkInAt.getTime() <= allowed) {
    return 0;
  }
  return Math.max(0, minutesBetween(start.getTime(), checkInAt.getTime()));
}

/**
 * DOCUMENT 12 rule 5 — `check_out_at − check_in_at − unpaid break minutes`.
 *
 * Clamped at zero: a break longer than a very short attendance would
 * otherwise produce negative minutes, and a negative count of minutes worked
 * is not a thing the rest of the system should ever have to consider.
 */
export function workingMinutesFor(
  checkInAt: Date | null,
  checkOutAt: Date | null,
  schedule: ScheduleSettings,
): number | null {
  if (checkInAt === null || checkOutAt === null) {
    return null;
  }
  const gross = minutesBetween(checkInAt.getTime(), checkOutAt.getTime());
  return Math.max(0, gross - schedule.breakMinutes);
}

/**
 * DOCUMENT 12 rule 6 — `max(0, working_minutes − scheduled_minutes)`, subject
 * to the schedule's overtime policy.
 *
 * Under `none` the company does not recognise overtime, so the stored value is
 * 0 rather than a number nothing may use. Under `paid` and `banked` the same
 * number is stored and what happens to it is payroll's decision (Phase 11) —
 * the difference between those two is not an attendance difference.
 */
export function overtimeMinutesFor(
  workingMinutes: number | null,
  scheduled: number,
  schedule: ScheduleSettings,
): number | null {
  if (workingMinutes === null) {
    return null;
  }
  if (schedule.overtimePolicy === 'none') {
    return 0;
  }
  return Math.max(0, workingMinutes - scheduled);
}

/**
 * The whole of a day, in the order the statuses outrank each other.
 *
 * The order is not arbitrary, and it is the part worth reading:
 *
 *  1. **A day nobody worked** takes its status from the calendar — `holiday`
 *     ahead of `weekend`, because a holiday falling on a rest day is still
 *     more specific, and `absent` for a working day that simply has nothing.
 *  2. **A day that was worked** describes what happened, whatever the calendar
 *     said. Somebody who comes in on a holiday is `present`, not `holiday`;
 *     DOCUMENT 12's non-working-day confirmation exists precisely so they can.
 *  3. **An open record** — checked in, never checked out — is `pending`. It is
 *     not `present`, because nothing is known yet about how long it lasted.
 *  4. Among worked-and-closed days, **`half_day` outranks `late`**. Both facts
 *     survive: `lateMinutes` is recorded either way, so naming the day by its
 *     duration loses nothing, while naming it `late` would hide that only half
 *     of it was worked. Stated in docs/PHASE-6-STATUS.md.
 *
 * `on_leave` is never produced here: it is written by leave approval (Phase 10)
 * or by an explicit admin adjustment, both of which know something this
 * function cannot.
 */
export function calculateDay(input: DayCalculationInput): DayCalculation {
  const { date, schedule, day, checkInAt, checkOutAt, isHoliday } = input;

  if (checkInAt === null) {
    if (isHoliday) {
      return { status: 'holiday', workingMinutes: null, overtimeMinutes: null, lateMinutes: null };
    }
    if (!day.isWorkingDay) {
      return { status: 'weekend', workingMinutes: null, overtimeMinutes: null, lateMinutes: null };
    }
    return { status: 'absent', workingMinutes: 0, overtimeMinutes: 0, lateMinutes: 0 };
  }

  const lateMinutes = lateMinutesFor({ date, schedule, day, checkInAt });

  if (checkOutAt === null) {
    return { status: 'pending', workingMinutes: null, overtimeMinutes: null, lateMinutes };
  }

  const workingMinutes = workingMinutesFor(checkInAt, checkOutAt, schedule);
  const scheduled = scheduledMinutes(day, schedule);
  const overtimeMinutes = overtimeMinutesFor(workingMinutes, scheduled, schedule);

  const halfDayThresholdMinutes = hoursToMinutes(schedule.halfDayThresholdHours);
  let status: AttendanceStatusValue;
  if ((workingMinutes ?? 0) < halfDayThresholdMinutes) {
    status = 'half_day';
  } else if (lateMinutes > 0) {
    status = 'late';
  } else {
    status = 'present';
  }

  return { status, workingMinutes, overtimeMinutes, lateMinutes };
}

/**
 * DOCUMENT 12 edge case "employee forgets to check out" — the nightly job
 * closes the record at the scheduled end time and marks it `pending`.
 *
 * Returns null on a day with no scheduled end (a rest day worked
 * voluntarily): there is no configured time to close at, and inventing one
 * would be a working-hours default in code (DOCUMENT 27 RULE 12). Such a
 * record stays open for a correction request, which is the documented route.
 */
export function scheduledEndInstant(
  date: CalendarDate,
  day: ScheduleDay,
  schedule: ScheduleSettings,
): Date | null {
  if (!day.isWorkingDay || day.endMinutes === null) {
    return null;
  }
  return instantAt(date, day.endMinutes, schedule.timezone);
}

/**
 * A day that approved leave no longer covers — DOCUMENT 16 rule 15, as
 * corrected after Phase 10: the leave's attendance row is never deleted, it
 * is reconciled in place to the state the day would have had without the
 * leave.
 *
 *  - **A day before today** gets exactly what the nightly job would have
 *    written for it: `absent` on a working day, `holiday` / `weekend` from the
 *    calendar.
 *  - **Today or a later day**, with no check-in, on a holiday or rest day gets
 *    its calendar status. On a working day it is `pending`: the day has not
 *    happened, so it is not an absence yet. Checking in converts it, the same
 *    way checking in converts any generated row. If nobody checks in, the
 *    nightly job turns it into `absent` once the day has ended (a decision
 *    approved in the Phase 10 corrective pass).
 *  - **Real check-in/check-out times are kept** and drive the status, as they
 *    do everywhere else.
 */
export function dayWithoutLeave(
  input: DayCalculationInput & { readonly beforeToday: boolean },
): DayCalculation {
  const calculated = calculateDay(input);
  if (!input.beforeToday && input.checkInAt === null && calculated.status === 'absent') {
    return { status: 'pending', workingMinutes: null, overtimeMinutes: null, lateMinutes: null };
  }
  return calculated;
}

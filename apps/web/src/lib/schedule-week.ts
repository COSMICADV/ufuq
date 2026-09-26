/**
 * The client's model of a working week — DOCUMENT 06 §3.8, DOCUMENT 12.
 *
 * This mirrors the server rule, it does not replace it: the API validates
 * every schedule again, because a client check is a convenience and never a
 * control (DOCUMENT 08 §5.1). What it buys is that an admin filling in a week
 * is told about a missing end time before they submit, rather than after.
 *
 * There is no default week here either. `blankWeek()` produces seven days
 * marked non-working with no hours — the honest starting point for a form the
 * admin must fill in — not a Saturday-to-Thursday assumption wearing a
 * different hat (DOCUMENT 27 RULE 12).
 */

export const DAYS_IN_WEEK = 7;

/** 0 = Sunday … 6 = Saturday, matching `work_schedule_days.day_of_week`. */
export const DAY_INDEXES = [0, 1, 2, 3, 4, 5, 6] as const;

export interface WeekDay {
  readonly day_of_week: number;
  readonly is_working_day: boolean;
  readonly start_time: string | null;
  readonly end_time: string | null;
}

export function blankWeek(): WeekDay[] {
  return DAY_INDEXES.map((day) => ({
    day_of_week: day,
    is_working_day: false,
    start_time: null,
    end_time: null,
  }));
}

/**
 * Normalise whatever the API returned into exactly seven ordered days. A
 * schedule always has seven — the database will not hold anything else — but
 * the form must not depend on the array arriving in order to render correctly.
 */
export function toWeek(days: readonly WeekDay[]): WeekDay[] {
  const byDay = new Map(days.map((day) => [day.day_of_week, day]));
  return DAY_INDEXES.map(
    (index) =>
      byDay.get(index) ?? {
        day_of_week: index,
        is_working_day: false,
        start_time: null,
        end_time: null,
      },
  );
}

export type WeekIssue = 'required' | 'end_before_start';

/**
 * Per-day problems, keyed by `day_of_week`. An empty map means the week is
 * submittable — which is not the same as "the server will accept it", and the
 * screen still renders whatever the server says.
 */
export function weekIssues(days: readonly WeekDay[]): ReadonlyMap<number, WeekIssue> {
  const issues = new Map<number, WeekIssue>();
  for (const day of days) {
    if (!day.is_working_day) {
      continue;
    }
    if (!day.start_time || !day.end_time) {
      issues.set(day.day_of_week, 'required');
      continue;
    }
    // Zero-padded `HH:MM` compares correctly as a string, which avoids
    // inventing a second idea of what a time is on the client.
    if (day.end_time <= day.start_time) {
      issues.set(day.day_of_week, 'end_before_start');
    }
  }
  return issues;
}

/**
 * The `days` array for a request body. Hours are dropped from a non-working
 * day rather than sent and rejected: a day the admin marked as working, then
 * unmarked, must not keep its old times in the payload.
 */
export function toRequestDays(days: readonly WeekDay[]): readonly WeekDay[] {
  return toWeek(days).map((day) =>
    day.is_working_day
      ? day
      : { day_of_week: day.day_of_week, is_working_day: false, start_time: null, end_time: null },
  );
}

/** Replace one day, leaving the rest of the week untouched. */
export function withDay(days: readonly WeekDay[], next: WeekDay): WeekDay[] {
  return toWeek(days).map((day) => (day.day_of_week === next.day_of_week ? next : day));
}

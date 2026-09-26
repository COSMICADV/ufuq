/**
 * Whole minutes.
 *
 * Attendance is counted in minutes — a count of clock ticks, never a monetary
 * or stock value. `Math.round` is right for it and is forbidden everywhere
 * else in this workspace by the DOCUMENT 27 RULE 17 lint rule, so it is
 * written once, here, with the reason, rather than disabled at each of the
 * dozen places a duration is computed.
 *
 * What this is *not* is a rounding policy for money. Minutes become money in
 * payroll (Phase 11), and that conversion must go through `@ufuq/money` and
 * `salary_policies.rounding` (DOCUMENT 15). Nothing in this file may be used
 * for that step.
 */

/** Milliseconds → whole minutes. */
export function minutesBetween(fromMs: number, toMs: number): number {
  // eslint-disable-next-line no-restricted-syntax -- a duration in minutes is a count of clock ticks, not a monetary value; see the note above.
  return Math.round((toMs - fromMs) / 60_000);
}

/** Hours (a schedule threshold, DECIMAL(4,2)) → whole minutes. */
export function hoursToMinutes(hours: number): number {
  // eslint-disable-next-line no-restricted-syntax -- a schedule threshold in hours is configuration, not money; see the note above.
  return Math.round(hours * 60);
}

/**
 * Company-timezone arithmetic — DOCUMENT 12 "Timezone" and "Clock skew".
 *
 * Attendance is evaluated in the schedule's own IANA zone (DOCUMENT 06 §3.7).
 * The browser's zone is never trusted and never reaches this file; the only
 * clock that matters is the server's, and the only zone is the configured one.
 *
 * Everything here is pure and takes the zone as an argument, so a test can ask
 * what 09:00 in Africa/Cairo was on a given date without the machine running
 * the test being in Cairo.
 */

/** A calendar day as the company sees it: no time, no zone, just Y-M-D. */
export interface CalendarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  const cached = FORMATTERS.get(timeZone);
  if (cached) return cached;
  const made = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  FORMATTERS.set(timeZone, made);
  return made;
}

function partsOf(instant: Date, timeZone: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(instant)) {
    if (part.type !== 'literal') {
      // `hour: '2-digit'` with hour12:false renders midnight as "24" in some
      // ICU versions; normalising it here keeps every caller from having to.
      const value = Number(part.value);
      out[part.type] = part.type === 'hour' && value === 24 ? 0 : value;
    }
  }
  return out;
}

/** The zone's offset from UTC, in minutes, at a given instant. */
function offsetMinutes(instant: Date, timeZone: string): number {
  const p = partsOf(instant, timeZone);
  const asUtc = Date.UTC(
    p['year'] as number,
    (p['month'] as number) - 1,
    p['day'] as number,
    p['hour'] as number,
    p['minute'] as number,
    p['second'] as number,
  );
  return (asUtc - instant.getTime()) / 60_000;
}

/**
 * The instant at which a given wall-clock time occurs in a zone.
 *
 * Two passes: guess the offset by reading it at the naive instant, then read
 * it again at the corrected one. The second pass is what makes the day a
 * clock changes come out right — on those days the offset before and after
 * the guess differ, and using the first would be off by the shift.
 */
export function instantAt(date: CalendarDate, minutesFromMidnight: number, timeZone: string): Date {
  const naive = Date.UTC(date.year, date.month - 1, date.day, 0, minutesFromMidnight);
  const firstPass = new Date(naive - offsetMinutes(new Date(naive), timeZone) * 60_000);
  const secondPass = new Date(naive - offsetMinutes(firstPass, timeZone) * 60_000);
  return secondPass;
}

/** The calendar day an instant falls on, as the zone sees it. */
export function calendarDateIn(instant: Date, timeZone: string): CalendarDate {
  const p = partsOf(instant, timeZone);
  return { year: p['year'] as number, month: p['month'] as number, day: p['day'] as number };
}

/** `YYYY-MM-DD` — the wire and storage form (DOCUMENT 08 §1). */
export function formatCalendarDate(date: CalendarDate): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return `${pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)}`;
}

/** Parses `YYYY-MM-DD`, returning null for anything that is not a real day. */
export function parseCalendarDate(value: string): CalendarDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // Round-tripping through UTC is what rejects 2026-02-30: it would otherwise
  // roll over to March and be silently accepted.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

/** 0 = Sunday … 6 = Saturday, matching `work_schedule_days.day_of_week`. */
export function dayOfWeek(date: CalendarDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/** Calendar days from `from` to `to` inclusive. */
export function eachDay(from: CalendarDate, to: CalendarDate): CalendarDate[] {
  const days: CalendarDate[] = [];
  const end = Date.UTC(to.year, to.month - 1, to.day);
  for (
    let cursor = Date.UTC(from.year, from.month - 1, from.day);
    cursor <= end;
    cursor += 86_400_000
  ) {
    const d = new Date(cursor);
    days.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
  }
  return days;
}

/** Compares two calendar days; negative when `a` is earlier. */
export function compareDates(a: CalendarDate, b: CalendarDate): number {
  return Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day);
}

/** Whole days between two calendar days (`b − a`). */
export function daysBetween(a: CalendarDate, b: CalendarDate): number {
  // eslint-disable-next-line no-restricted-syntax -- a count of whole days between two calendar dates; not a monetary value (DOCUMENT 27 RULE 17 guards money, see ./minutes.ts).
  return Math.round(compareDates(b, a) / 86_400_000);
}

/**
 * Minutes from midnight for a `TIME` column. Prisma hands a `@db.Time` back as
 * a Date on 1970-01-01 **in UTC**, so the wall-clock reading is the UTC one —
 * using the local getters would shift every schedule by the test machine's
 * offset.
 */
export function minutesFromTime(time: Date): number {
  return time.getUTCHours() * 60 + time.getUTCMinutes();
}

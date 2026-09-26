/**
 * Shared input rules for the company-structure DTOs — DOCUMENT 08 §5,
 * DOCUMENT 20 §4, DOCUMENT 27 RULE 28.
 *
 * DOCUMENT 08 §5 asks for six things on every endpoint. Three of them —
 * whitelist rejection of unknown fields, enum enforcement, and maximum
 * lengths — `class-validator` already expresses directly. The other three
 * (trimming, Arabic-digit normalisation, rejecting control characters) are
 * written once here rather than per field, because a rule applied "wherever
 * someone remembered" is not a rule (DOCUMENT 27 RULE 6).
 */

import { normaliseDigits } from '@ufuq/i18n';
import { Decimal, DecimalError } from '@ufuq/money';
import { Transform } from 'class-transformer';
import { registerDecorator } from 'class-validator';
import type { ValidationOptions } from 'class-validator';

/** VARCHAR(200) — every name and title column in DOCUMENT 06 §3.4–3.9. */
export const NAME_MAX_LENGTH = 200;
/** VARCHAR(64) — `companies.timezone` and `work_schedules.timezone`. */
export const TIMEZONE_MAX_LENGTH = 64;
/** `half_day_threshold_hours` is DECIMAL(4,2); scale 2 is what a caller may send. */
export const HOURS_SCALE = 2;

/**
 * DOCUMENT 08 §5.5 — trim, and reject control characters.
 *
 * The rejection is deliberately not silent stripping: a name containing a
 * newline or a zero-width joiner is far more likely to be a paste accident or
 * an injection attempt than an intention, and quietly rewriting a user's input
 * is worse than telling them about it.
 *
 * The set is: C0 controls and DEL, the C1 range, the zero-width and
 * directional marks (U+200B–U+200F), the Unicode bidirectional overrides
 * (U+202A–U+202E) and isolates (U+2066–U+2069). The last two groups are
 * invisible and can make stored text render as something other than what it
 * is — a real concern in a bidirectional product. Ordinary Arabic and Latin
 * letters, digits and punctuation are untouched.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point.
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/;

export function TrimmedText(): PropertyDecorator {
  return Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
}

export function NoControlCharacters(options?: ValidationOptions): PropertyDecorator {
  return (target, propertyName) => {
    registerDecorator({
      name: 'noControlCharacters',
      target: target.constructor,
      propertyName: propertyName as string,
      options: options ?? {},
      validator: {
        validate: (value: unknown) => typeof value !== 'string' || !CONTROL_CHARACTERS.test(value),
        defaultMessage: () => 'invalid',
      },
    });
  };
}

/**
 * DOCUMENT 08 §5.5 — "normalise Arabic digits to Latin for numeric fields".
 * An Arabic keyboard produces ٠–٩ (and Persian keyboards ۰–۹); a form that
 * refuses them is a form an Arabic-first product cannot ship.
 */
export function NumericInput(): PropertyDecorator {
  return Transform(({ value }) => {
    if (typeof value !== 'string') {
      return value;
    }
    const normalised = normaliseDigits(value.trim());
    // An empty or non-numeric string is handed on untouched so `@IsInt()`
    // reports it, rather than becoming `NaN` here and losing the original.
    return /^-?\d+$/.test(normalised) ? Number(normalised) : value;
  });
}

/** Same normalisation, but the value stays a string — see `IsDecimalHours`. */
export function DecimalInput(): PropertyDecorator {
  return Transform(({ value }) =>
    typeof value === 'string' ? normaliseDigits(value.trim()) : value,
  );
}

/**
 * A fixed-precision hours value, carried as a string.
 *
 * `half_day_threshold_hours` is DECIMAL(4,2) and 4.5 hours is an ordinary
 * setting, so the value cannot be an integer — and it must not become a
 * JavaScript `number` on the way in either. `@ufuq/money`'s `Decimal` is the
 * one decimal parser in this workspace (DOCUMENT 27 RULES 6 and 17); reusing
 * it here means "what counts as a valid decimal" has exactly one definition.
 */
export function IsDecimalHours(
  bounds: { readonly min: string; readonly max: string },
  options?: ValidationOptions,
): PropertyDecorator {
  return (target, propertyName) => {
    registerDecorator({
      name: 'isDecimalHours',
      target: target.constructor,
      propertyName: propertyName as string,
      options: options ?? {},
      validator: {
        validate: (value: unknown) => {
          if (typeof value !== 'string') {
            return false;
          }
          try {
            const parsed = Decimal.parse(value, HOURS_SCALE);
            return (
              parsed.compare(Decimal.parse(bounds.min, HOURS_SCALE)) > 0 &&
              parsed.compare(Decimal.parse(bounds.max, HOURS_SCALE)) <= 0
            );
          } catch (error) {
            if (error instanceof DecimalError) {
              return false;
            }
            throw error;
          }
        },
        defaultMessage: () => 'invalid',
      },
    });
  };
}

/**
 * A real IANA zone, checked by asking the platform's own tz database rather
 * than against a list this repository would have to maintain and would get
 * wrong the next time a country changes its rules.
 *
 * DOCUMENT 12 makes this load-bearing: every attendance calculation happens in
 * the company's zone, and "the browser timezone is never trusted".
 */
export function IsIanaTimeZone(options?: ValidationOptions): PropertyDecorator {
  return (target, propertyName) => {
    registerDecorator({
      name: 'isIanaTimeZone',
      target: target.constructor,
      propertyName: propertyName as string,
      options: options ?? {},
      validator: {
        validate: (value: unknown) => {
          if (typeof value !== 'string' || value.length === 0) {
            return false;
          }
          try {
            new Intl.DateTimeFormat('en-US', { timeZone: value });
            return true;
          } catch {
            return false;
          }
        },
        defaultMessage: () => 'invalid',
      },
    });
  };
}

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `YYYY-MM-DD`, and a date that actually exists. A regex alone accepts
 * `2026-02-30`, which PostgreSQL would then reject as a 500 rather than the
 * 422 with a field error DOCUMENT 08 §2 promises.
 */
export function IsCalendarDate(options?: ValidationOptions): PropertyDecorator {
  return (target, propertyName) => {
    registerDecorator({
      name: 'isCalendarDate',
      target: target.constructor,
      propertyName: propertyName as string,
      options: options ?? {},
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' && parseCalendarDate(value) !== null,
        defaultMessage: () => 'invalid',
      },
    });
  };
}

/**
 * Parse `YYYY-MM-DD` into the UTC midnight PostgreSQL's `DATE` type stores,
 * returning null when the date does not exist. Shared by the validator above
 * and by the service that writes the row, so the two can never disagree about
 * what a date string means.
 */
export function parseCalendarDate(value: string): Date | null {
  if (!CALENDAR_DATE.test(value)) {
    return null;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  // Round-trip check: `new Date('2026-02-30T…')` is not an error in
  // JavaScript, it is 2 March. Comparing back is what catches that.
  return parsed.toISOString().slice(0, 10) === value ? parsed : null;
}

/** `HH:MM`, 24-hour. `work_schedule_days.start_time` / `end_time`. */
export const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

/** `HH:MM` → the 1970-01-01 instant Prisma writes into a `TIME` column. */
export function parseTimeOfDay(value: string): Date {
  return new Date(`1970-01-01T${value}:00.000Z`);
}

/** A `TIME` column read back → `HH:MM` for the API payload. */
export function formatTimeOfDay(value: Date): string {
  return value.toISOString().slice(11, 16);
}

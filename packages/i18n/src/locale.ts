/**
 * Locale and layout direction.
 *
 * DOCUMENT 01 NFR-01 — Arabic-first, RTL by default, English from day one.
 * DOCUMENT 10 §9 — RTL is the default; LTR is the variant.
 *
 * Direction is derived from the locale in exactly one place. Nothing in the
 * product decides `dir` for itself.
 */

export const LOCALES = ['ar', 'en'] as const;

export type Locale = (typeof LOCALES)[number];

export type Direction = 'rtl' | 'ltr';

/** Arabic is the default. English is the alternative, not the base. */
export const DEFAULT_LOCALE: Locale = 'ar';

const DIRECTION_BY_LOCALE: Record<Locale, Direction> = {
  ar: 'rtl',
  en: 'ltr',
};

/** BCP 47 tags used for Intl formatting. */
const BCP47_BY_LOCALE: Record<Locale, string> = {
  ar: 'ar-EG',
  en: 'en-GB',
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

export function getDirection(locale: Locale): Direction {
  return DIRECTION_BY_LOCALE[locale];
}

export function isRtl(locale: Locale): boolean {
  return getDirection(locale) === 'rtl';
}

export function toBcp47(locale: Locale): string {
  return BCP47_BY_LOCALE[locale];
}

/**
 * Resolve a locale from an `Accept-Language` header or a stored preference.
 * Anything unrecognised falls back to Arabic (DOCUMENT 08 §1).
 */
export function resolveLocale(candidate: string | null | undefined): Locale {
  if (!candidate) {
    return DEFAULT_LOCALE;
  }
  for (const part of candidate.split(',')) {
    const tag = part.split(';')[0]?.trim().toLowerCase();
    if (!tag) {
      continue;
    }
    const base = tag.split('-')[0];
    if (isLocale(base)) {
      return base;
    }
  }
  return DEFAULT_LOCALE;
}

/** The attributes a document root must carry for the given locale. */
export function documentAttributes(locale: Locale): { lang: Locale; dir: Direction } {
  return { lang: locale, dir: getDirection(locale) };
}

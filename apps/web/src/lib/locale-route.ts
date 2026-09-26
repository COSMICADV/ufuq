/**
 * Locale-prefixed routing.
 *
 * The locale is the first path segment, so the URL states the language and the
 * direction that follows from it. Nothing here decides what a locale *is* —
 * that is @ufuq/i18n's job (DOCUMENT 27 RULE 6).
 */

import { isLocale, resolveLocale } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

/** The locale a path is already prefixed with, or null if it is not prefixed. */
export function localeFromPath(pathname: string): Locale | null {
  const segment = pathname.split('/')[1] ?? '';
  return isLocale(segment) ? segment : null;
}

/** The same path expressed in another locale. Used by the language switch. */
export function pathInLocale(pathname: string, locale: Locale): string {
  if (localeFromPath(pathname) === null) {
    return pathname === '/' ? `/${locale}` : `/${locale}${pathname}`;
  }
  const segments = pathname.split('/');
  segments[1] = locale;
  return segments.join('/');
}

/**
 * Where an unprefixed request should go. `Accept-Language` chooses when it
 * names a supported language; anything else falls back to Arabic
 * (DOCUMENT 08 §1, DOCUMENT 01 NFR-01).
 */
export function redirectTarget(pathname: string, acceptLanguage: string | null): string {
  return pathInLocale(pathname, resolveLocale(acceptLanguage));
}

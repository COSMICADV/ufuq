/**
 * Layout direction for React Native.
 *
 * React Native has no document to carry `dir`, so direction is applied as a
 * style. It is still derived from the locale by @ufuq/i18n, in one place, so
 * web and mobile cannot disagree about which language reads which way
 * (DOCUMENT 27 RULES 6 and 24).
 *
 * This module deliberately imports nothing from `react-native`: direction is a
 * decision, not a rendering concern, and keeping it separate means it can be
 * tested without a native runtime.
 */

import { getDirection } from '@ufuq/i18n';
import type { Direction, Locale } from '@ufuq/i18n';

export interface DirectionStyle {
  /** Applied to a container view; Yoga lays its children out accordingly. */
  readonly direction: Direction;
  /** Applied to text so bidirectional runs resolve correctly. */
  readonly writingDirection: Direction;
}

export function directionStyle(locale: Locale): DirectionStyle {
  const direction = getDirection(locale);
  return { direction, writingDirection: direction };
}

/** The locale to show after tapping the switch, given the one on screen. */
export function nextLocale(current: Locale, locales: readonly Locale[]): Locale {
  const index = locales.indexOf(current);
  return locales[(index + 1) % locales.length] ?? current;
}

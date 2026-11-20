import type { Locale } from '@ufuq/i18n';

/**
 * 1to1OS Personal: its sections, in the sidebar's order (the user's reference
 * design). `home` is the workspace root; the others are one path segment each.
 * Each icon is the reference drawing itself, cut out as `/personal/{icon}.webp`.
 */
export const PERSONAL_SECTIONS = [
  'tasks',
  'expenses',
  'calendar',
  'health',
  'car',
  'house',
  'notes',
  'files',
  'reports',
  'settings',
] as const;
export type PersonalSection = (typeof PERSONAL_SECTIONS)[number];

export function isPersonalSection(value: string): value is PersonalSection {
  return (PERSONAL_SECTIONS as readonly string[]).includes(value);
}

/** The Personal workspace root, `/{locale}/personal`. */
export function personalBase(locale: Locale): string {
  return `/${locale}/personal`;
}

/** Where a section lives; `home` is the root. */
export function personalHref(locale: Locale, section: PersonalSection | 'home'): string {
  return section === 'home' ? personalBase(locale) : `${personalBase(locale)}/${section}`;
}

/** The sign-up page, outside the workspace. */
export function personalStart(locale: Locale): string {
  return `${personalBase(locale)}/start`;
}

/** The reference drawing for a sidebar entry. */
export function personalIcon(entry: PersonalSection | 'home' | 'theme'): string {
  return `/personal/${entry}.webp`;
}

/** Which entry a pathname belongs to, for `aria-current`. */
export function currentSection(locale: Locale, pathname: string): PersonalSection | 'home' | null {
  const base = personalBase(locale);
  if (pathname === base || pathname === `${base}/`) return 'home';
  if (!pathname.startsWith(`${base}/`)) return null;
  const segment = pathname.slice(base.length + 1).split('/')[0] ?? '';
  return isPersonalSection(segment) ? segment : null;
}

/** Where a signed-in user belongs after sign-in, by role. */
export function workspaceFor(locale: Locale, roleKey: string): string {
  if (roleKey === 'personal') return personalBase(locale);
  if (roleKey === 'employee') return `/${locale}/app`;
  if (roleKey === 'admin') return `/${locale}/admin/settings/company`;
  return `/${locale}/admin`;
}

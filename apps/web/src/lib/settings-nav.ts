/**
 * The settings section list — DOCUMENT 03 §3's `/admin/settings/*` subtree.
 *
 * The four sections Phase 4 owns, leave types (Phase 10, DOCUMENT 16),
 * performance (Phase 8, DOCUMENT 14) and the audit log (DOCUMENT 21 "UI").
 * DOCUMENT 03 lists three more (salary policy, roles, notifications); each belongs to the phase that builds it, and listing them
 * now as disabled links would be exactly the "coming soon" panel DOCUMENT 27
 * RULE 26 forbids.
 */

export const SETTINGS_SECTIONS = [
  'company',
  'departments',
  'positions',
  'schedules',
  'leave-types',
  'performance',
  'audit-log',
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export function isSettingsSection(value: string): value is SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

/**
 * Route segments are English, lowercase and never localized — DOCUMENT 03 §9.
 * The locale prefix is the *only* localized part of the path.
 */
export function settingsPath(locale: string, section: SettingsSection): string {
  return `/${locale}/admin/settings/${section}`;
}

/**
 * The translation key for a section's own label. A dot is the catalogue's path
 * separator and a hyphen is not an identifier character, so `audit-log` is
 * `settings.audit_log`.
 */
export function sectionLabelKey(section: SettingsSection): string {
  return `settings.${section.replace(/-/g, '_')}`;
}

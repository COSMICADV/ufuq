/**
 * The settings subtree — DOCUMENT 03 §§3 and 9.
 */

import { describe, expect, it } from 'vitest';

import {
  isSettingsSection,
  sectionLabelKey,
  SETTINGS_SECTIONS,
  settingsPath,
} from './settings-nav';

describe('SETTINGS_SECTIONS', () => {
  it('contains the four Phase 4 sections, performance (Phase 8) and the audit log', () => {
    expect([...SETTINGS_SECTIONS]).toEqual([
      'company',
      'departments',
      'positions',
      'schedules',
      'performance',
      'audit-log',
    ]);
  });

  it('does not list a section whose screen does not exist yet', () => {
    // DOCUMENT 03 §3 also lists these; each belongs to a later phase, and a
    // link to a screen that is not built is a "coming soon" panel by another
    // name (DOCUMENT 27 RULE 26).
    for (const later of ['leave-types', 'salary-policy', 'roles', 'notifications']) {
      expect(isSettingsSection(later)).toBe(false);
    }
  });
});

describe('isSettingsSection', () => {
  it('accepts a real section', () => {
    expect(isSettingsSection('departments')).toBe(true);
  });

  it.each(['', 'Departments', 'departments/', '../company'])('rejects %s', (value) => {
    expect(isSettingsSection(value)).toBe(false);
  });
});

describe('settingsPath', () => {
  it('prefixes the locale and keeps the route segments English — DOCUMENT 03 §9', () => {
    expect(settingsPath('ar', 'schedules')).toBe('/ar/admin/settings/schedules');
    expect(settingsPath('en', 'schedules')).toBe('/en/admin/settings/schedules');
  });

  it('does not localize the segment itself in Arabic', () => {
    expect(settingsPath('ar', 'departments')).toContain('/departments');
  });
});

describe('sectionLabelKey', () => {
  it('names a key that exists in both catalogues', () => {
    expect(sectionLabelKey('company')).toBe('settings.company');
  });

  it('turns a hyphenated segment into a catalogue key', () => {
    expect(sectionLabelKey('audit-log')).toBe('settings.audit_log');
    expect(settingsPath('ar', 'audit-log')).toBe('/ar/admin/settings/audit-log');
  });
});

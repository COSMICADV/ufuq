import { describe, expect, it } from 'vitest';

import {
  currentSection,
  isPersonalSection,
  PERSONAL_SECTIONS,
  personalHref,
  personalIcon,
  workspaceFor,
} from './personal';

describe('1to1OS Personal routes', () => {
  it('lists the reference sidebar in order', () => {
    expect([...PERSONAL_SECTIONS]).toEqual([
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
    ]);
  });

  it('builds hrefs and icons', () => {
    expect(personalHref('ar', 'home')).toBe('/ar/personal');
    expect(personalHref('fr', 'car')).toBe('/fr/personal/car');
    expect(personalIcon('theme')).toBe('/personal/theme.webp');
  });

  it('finds the current entry from a pathname', () => {
    expect(currentSection('en', '/en/personal')).toBe('home');
    expect(currentSection('en', '/en/personal/notes')).toBe('notes');
    expect(currentSection('en', '/en/personal/notes/123')).toBe('notes');
    expect(currentSection('en', '/en/personal/start')).toBeNull();
    expect(currentSection('en', '/en/admin')).toBeNull();
    expect(isPersonalSection('start')).toBe(false);
  });

  it('sends each role to its own workspace', () => {
    expect(workspaceFor('de', 'personal')).toBe('/de/personal');
    expect(workspaceFor('de', 'employee')).toBe('/de/app');
    expect(workspaceFor('de', 'admin')).toBe('/de/admin/settings/company');
    expect(workspaceFor('de', 'manager')).toBe('/de/admin');
  });
});

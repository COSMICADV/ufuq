import { describe, expect, it } from 'vitest';

import {
  DEFAULT_THEME,
  isTheme,
  resolveTheme,
  THEME_BOOT_SCRIPT,
  themeAttribute,
  themeLabelKey,
  THEMES,
} from './themes';

describe('themes', () => {
  it('offers the four looks, the default first', () => {
    expect(THEMES).toEqual(['light', 'violet', 'green', 'dark']);
    expect(DEFAULT_THEME).toBe('light');
  });

  it('reads a theme stored before the redesign as its successor', () => {
    expect(resolveTheme('dark-blue')).toBe('dark');
    expect(resolveTheme('red')).toBe('light');
    expect(resolveTheme('violet')).toBe('violet');
    expect(resolveTheme('nonsense')).toBe('light');
  });

  it('recognises only the known themes', () => {
    expect(isTheme('green')).toBe(true);
    expect(isTheme('purple')).toBe(false);
    expect(isTheme(null)).toBe(false);
  });

  it('sets no attribute for the default theme', () => {
    expect(themeAttribute('light')).toBeNull();
    expect(themeAttribute('dark')).toBe('dark');
  });

  it('names each theme with a catalogue key', () => {
    expect(themeLabelKey('dark')).toBe('theme.dark');
    expect(themeLabelKey('violet')).toBe('theme.violet');
  });

  it('boot script applies a stored theme and ignores unknown values', () => {
    const attributes = new Map<string, string>();
    const run = (stored: string | null): void => {
      attributes.clear();
      const localStorage = { getItem: () => stored };
      const document = {
        documentElement: {
          setAttribute: (name: string, value: string) => attributes.set(name, value),
        },
      };
      new Function('localStorage', 'document', THEME_BOOT_SCRIPT)(localStorage, document);
    };
    run('green');
    expect(attributes.get('data-theme')).toBe('green');
    run('purple');
    expect(attributes.size).toBe(0);
    run('dark-blue');
    expect(attributes.get('data-theme')).toBe('dark');
    run('light');
    expect(attributes.size).toBe(0);
    run(null);
    expect(attributes.size).toBe(0);
  });
});

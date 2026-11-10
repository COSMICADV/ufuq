import { describe, expect, it } from 'vitest';

import {
  DEFAULT_THEME,
  isTheme,
  THEME_BOOT_SCRIPT,
  themeAttribute,
  themeLabelKey,
  THEMES,
} from './themes';

describe('themes', () => {
  it('offers the four looks, the original first', () => {
    expect(THEMES).toEqual(['dark-blue', 'light', 'green', 'red']);
    expect(DEFAULT_THEME).toBe('dark-blue');
  });

  it('recognises only the known themes', () => {
    expect(isTheme('green')).toBe(true);
    expect(isTheme('purple')).toBe(false);
    expect(isTheme(null)).toBe(false);
  });

  it('sets no attribute for the default theme', () => {
    expect(themeAttribute('dark-blue')).toBeNull();
    expect(themeAttribute('light')).toBe('light');
  });

  it('names each theme with a catalogue key', () => {
    expect(themeLabelKey('dark-blue')).toBe('theme.dark_blue');
    expect(themeLabelKey('red')).toBe('theme.red');
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
    expect(attributes.size).toBe(0);
    run(null);
    expect(attributes.size).toBe(0);
  });
});

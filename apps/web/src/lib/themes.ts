/**
 * The visitor's colour theme — four looks over the same design tokens
 * (packages/design-tokens/src/tokens.css, `<html data-theme="…">`).
 *
 * The choice is the visitor's alone and lives in their browser
 * (`localStorage`); nothing is sent to the API. A small inline script in the
 * root layout applies it before first paint, so a page never flashes the
 * default theme first.
 */

export const THEMES = ['light', 'violet', 'green', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

/** White, navy and blue: what a visitor sees until they choose. */
export const DEFAULT_THEME: Theme = 'light';

/**
 * Names a browser may still hold from before the redesign, and the theme each
 * now means: the old dark blue is the new dark, the old red has no successor.
 */
export const LEGACY_THEMES: Readonly<Record<string, Theme>> = { 'dark-blue': 'dark', red: 'light' };

/** A stored value, read as one of today's themes. */
export function resolveTheme(value: unknown): Theme {
  if (isTheme(value)) return value;
  return typeof value === 'string' ? (LEGACY_THEMES[value] ?? DEFAULT_THEME) : DEFAULT_THEME;
}

export const THEME_STORAGE_KEY = '1to1os.theme';

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

/** The catalogue key for a theme's name — both languages. */
export function themeLabelKey(theme: Theme): string {
  return `theme.${theme}`;
}

/**
 * The `data-theme` value for a theme: none for the default, so the tokens'
 * plain `:root` block applies.
 */
export function themeAttribute(theme: Theme): string | null {
  return theme === DEFAULT_THEME ? null : theme;
}

/**
 * Runs inline in `<head>`, before the body paints. Kept tiny and defensive:
 * storage can throw (private windows, blocked site data), and an unknown
 * stored value falls back to the default.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});var l=${JSON.stringify(LEGACY_THEMES)};if(t&&l[t])t=l[t];if(t&&t!=='${DEFAULT_THEME}'&&${JSON.stringify(
  THEMES,
)}.indexOf(t)>-1){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`;

/** The theme stored in this browser, or the default. */
export function readStoredTheme(): Theme {
  try {
    return resolveTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

/** Apply a theme to the document and remember it in this browser. */
export function applyTheme(theme: Theme): void {
  const attribute = themeAttribute(theme);
  if (attribute === null) {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', attribute);
  }
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage blocked: the theme still applies for this page view.
  }
}

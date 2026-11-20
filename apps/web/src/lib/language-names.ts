import { LOCALES } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';

/** Every locale's name, in its own language, from the catalogue (for LanguageSwitch). */
export function languageNames(t: Translator): Readonly<Record<Locale, string>> {
  return Object.fromEntries(LOCALES.map((locale) => [locale, t(`language.${locale}`)])) as Record<
    Locale,
    string
  >;
}

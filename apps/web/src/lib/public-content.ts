import type { Locale } from '@ufuq/i18n';

export const PUBLIC_PAGES = [
  'home',
  'about',
  'features',
  'for-companies',
  'for-individuals',
  'pricing',
  'contact',
  'login',
  'register',
] as const;
export type PublicPage = (typeof PUBLIC_PAGES)[number];
export function publicPath(locale: Locale, page: PublicPage): string {
  return `${locale === 'ar' ? '' : '/en'}${page === 'home' ? '' : `/${page}`}` || '/';
}
export { publicCopy, publicFeatures as features } from '@ufuq/i18n';

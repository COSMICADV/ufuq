import type { MetadataRoute } from 'next';
import { LOCALES } from '@ufuq/i18n';
import { publicPath } from '../lib/public-content';
import type { PublicPage } from '../lib/public-content';

/** The pages outside the product: the language choice, then each language's front door. */
const PAGES: readonly PublicPage[] = ['home', 'for-individuals', 'contact'];

export default function sitemap(): MetadataRoute.Sitemap {
  const origin = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
  return [
    { url: new URL('/', origin).href },
    ...PAGES.flatMap((page) =>
      LOCALES.map((locale) => ({
        url: new URL(publicPath(locale, page), origin).href,
        alternates: {
          languages: Object.fromEntries(
            LOCALES.map((l) => [l, new URL(publicPath(l, page), origin).href]),
          ),
        },
      })),
    ),
  ];
}

import type { MetadataRoute } from 'next';
import { PUBLIC_PAGES, publicPath } from '../lib/public-content';
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
  return PUBLIC_PAGES.filter((p) => p !== 'login' && p !== 'register').flatMap((page) =>
    (['ar', 'en'] as const).map((locale) => ({
      url: new URL(publicPath(locale, page), origin).href,
      alternates: {
        languages: {
          ar: new URL(publicPath('ar', page), origin).href,
          en: new URL(publicPath('en', page), origin).href,
        },
      },
    })),
  );
}

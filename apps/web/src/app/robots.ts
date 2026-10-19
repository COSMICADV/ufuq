import type { MetadataRoute } from 'next';
export default function robots(): MetadataRoute.Robots {
  const origin = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: [
        '/ar/admin',
        '/en/admin',
        '/ar/app',
        '/en/app',
        '/admin',
        '/app',
        '/api/',
        '/ar/accept-invitation',
        '/en/accept-invitation',
        '/login',
        '/register',
        '/ar/login',
        '/ar/register',
        '/en/login',
        '/en/register',
      ],
    },
    sitemap: new URL('/sitemap.xml', origin).href,
  };
}

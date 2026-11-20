/**
 * Locale prefixing (Next's `proxy` file convention).
 *
 * Every page lives under `/{locale}`, because the root layout reads the locale
 * from the path to set `lang` and `dir`. `/` itself is the language choice; any
 * other request without a prefix is redirected to the language the browser
 * asked for, defaulting to Arabic.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { localeFromPath, redirectTarget } from './lib/locale-route';

export default function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  if (localeFromPath(pathname) !== null) {
    return NextResponse.next();
  }

  const url = request.nextUrl.clone();
  // The first screen: the five languages.
  if (pathname === '/') {
    url.pathname = '/en/language';
    return NextResponse.rewrite(url);
  }
  // Older unprefixed links keep working, in Arabic.
  const publicPaths = new Set([
    '/',
    '/about',
    '/features',
    '/for-companies',
    '/for-individuals',
    '/pricing',
    '/contact',
    '/login',
    '/register',
    '/business',
  ]);
  if (publicPaths.has(pathname)) {
    url.pathname = `/ar${pathname}`;
    return NextResponse.rewrite(url);
  }
  url.pathname = redirectTarget(pathname, request.headers.get('accept-language'));
  return NextResponse.redirect(url);
}

export const config = {
  /**
   * Everything except Next's own assets, files with an extension, the API
   * path the staging rewrite in `next.config.mjs` forwards (`/api/v1`), and
   * QR Studio's scan links (`/q/{slug}`), which are the same in every language.
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/|q/|.*\\..*).*)'],
};

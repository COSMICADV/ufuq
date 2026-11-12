/**
 * `/q/{slug}` — what a QR Studio code opens when it is scanned.
 *
 * The scan is counted by the API (`POST /public/qr/{slug}/scan`), which answers
 * with the code's page or, for a website code, where to send the visitor. A
 * page is the studio's own view mode: the studio file with the code's content
 * handed to it as `window.QRV`, as 1to1QR's scan page did.
 *
 * A first scan from a browser counts as a new visitor; a cookie per code
 * remembers it for a year.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const SLUG = /^[A-Za-z0-9_-]{2,64}$/;
const SEEN_MAX_AGE = 60 * 60 * 24 * 365;

/** The API as this server reaches it (in the hosted image, the local process). */
function serverApi(): string {
  const origin =
    process.env.API_PROXY_TARGET ?? process.env.NEXT_PUBLIC_API_ORIGIN ?? 'http://localhost:4000';
  return `${origin.replace(/\/$/, '')}/api/v1`;
}

/** The API as the visitor's browser reaches it, for the page's rating and click calls. */
function browserApi(): string {
  const origin = process.env.NEXT_PUBLIC_API_ORIGIN ?? 'http://localhost:4000';
  return `${origin.replace(/\/$/, '')}/api/v1`;
}

interface ScanPage {
  readonly slug: string;
  readonly type: string;
  readonly data: unknown;
  readonly page: unknown;
  readonly redirect: string | null;
}

let studio: Promise<string> | null = null;
function studioHtml(): Promise<string> {
  studio ??= readFile(path.join(process.cwd(), 'public', 'qr-studio', 'studio.html'), 'utf8');
  return studio;
}

/** JSON that is safe inside a `<script>` element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function notFound(lang: 'ar' | 'en'): NextResponse {
  const ar = lang === 'ar';
  const html = `<!doctype html><html lang="${lang}" dir="${ar ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${ar ? 'الكود ده مش موجود' : 'Code not found'}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:Alexandria,Inter,system-ui,sans-serif;background:#0f172a;color:#f1f5f9;padding:24px;box-sizing:border-box}.b{max-width:380px;width:100%;background:#141e33;border:1px solid #233049;border-radius:16px;padding:28px 24px;text-align:center}h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#a3b0c4;line-height:1.6}small{display:block;margin-top:18px;color:#8d9ab0}</style></head>
<body><div class="b"><h1>${ar ? 'الكود ده مش موجود' : 'This code does not exist'}</h1><p>${ar ? 'ممكن يكون اتمسح أو الرابط غلط.' : 'It may have been removed, or the link is wrong.'}</p><small dir="ltr">1to1OS QR Studio</small></div></body></html>`;
  return new NextResponse(html, {
    status: 404,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  const acceptLanguage = request.headers.get('accept-language') ?? '';
  const lang = acceptLanguage.toLowerCase().startsWith('ar') ? 'ar' : 'en';
  if (!SLUG.test(slug)) return notFound(lang);

  const seenCookie = `qr_seen_${slug}`;
  const country = request.headers.get('cf-ipcountry');
  let page: ScanPage;
  try {
    const response = await fetch(`${serverApi()}/public/qr/${encodeURIComponent(slug)}/scan`, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': request.headers.get('user-agent') ?? '',
        'Accept-Language': acceptLanguage,
      },
      body: JSON.stringify({
        unique: request.cookies.get(seenCookie) === undefined,
        ...(country !== null && /^[A-Za-z]{2}$/.test(country) ? { country } : {}),
      }),
    });
    if (response.status === 404) return notFound(lang);
    if (!response.ok) throw new Error(`scan answered ${String(response.status)}`);
    page = ((await response.json()) as { data: ScanPage }).data;
  } catch {
    return new NextResponse(
      lang === 'ar' ? 'حصلت مشكلة. جرّب تاني.' : 'Something went wrong. Try again.',
      {
        status: 502,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      },
    );
  }

  let result: NextResponse;
  if (page.redirect !== null) {
    result = NextResponse.redirect(page.redirect, 302);
  } else {
    const html = (await studioHtml()).replace(
      '<meta charset="utf-8">',
      `<meta charset="utf-8">\n<meta name="robots" content="noindex">\n<script>window.QRV=${scriptJson(
        {
          slug: page.slug,
          type: page.type,
          data: page.data,
          page: page.page,
        },
      )};window.QR_API=${scriptJson(browserApi())};</script>`,
    );
    result = new NextResponse(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
  result.headers.set('Cache-Control', 'no-store');
  result.cookies.set(seenCookie, '1', {
    path: `/q/${slug}`,
    maxAge: SEEN_MAX_AGE,
    sameSite: 'lax',
    httpOnly: true,
    secure: request.nextUrl.protocol === 'https:',
  });
  return result;
}

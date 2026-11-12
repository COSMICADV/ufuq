/**
 * QR Studio — the rules the server applies to the studio's records and scans.
 *
 * The studio (the ported 1to1QR app, `apps/web/public/qr-studio`) describes a
 * code as one JSON record: its content, design and landing page. The server
 * stores that record as written and reads only what a scan needs from it: the
 * type, and for a website code which address to send the visitor to.
 */

/** A short link: what follows `/q/` in the code's URL. */
export const QR_SLUG_PATTERN = /^[A-Za-z0-9_-]{2,64}$/;

/** Every type the studio offers. */
export const QR_TYPES = [
  'card',
  'website',
  'pdf',
  'images',
  'vcard',
  'video',
  'links',
  'social',
  'location',
  'business',
  'menu',
  'coupon',
  'event',
  'feedback',
  'app',
  'mp3',
  'whatsapp',
  'wifi',
  'email',
  'text',
] as const;
export type QrType = (typeof QR_TYPES)[number];

/**
 * The largest record kept. The studio embeds compressed pictures (logo, cover,
 * gallery, a preview of the code) in the record itself; files go up separately.
 */
export const QR_MAX_RECORD_BYTES = 8 * 1024 * 1024;

/** What one code's statistics carry back to the studio at most. */
export const QR_SCAN_LOG_LIMIT = 5000;

/** Files a code may carry (PDF, video, audio, pictures). */
export const QR_FILE_TYPES: ReadonlyMap<string, string> = new Map([
  ['application/pdf', 'pdf'],
  ['video/mp4', 'mp4'],
  ['video/webm', 'webm'],
  ['video/quicktime', 'mov'],
  ['audio/mpeg', 'mp3'],
  ['audio/mp4', 'm4a'],
  ['audio/x-m4a', 'm4a'],
  ['audio/ogg', 'ogg'],
  ['audio/wav', 'wav'],
  ['audio/x-wav', 'wav'],
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
]);

export function isQrType(value: unknown): value is QrType {
  return typeof value === 'string' && (QR_TYPES as readonly string[]).includes(value);
}

/** The fields the studio keeps per code but the server owns: never taken from a save. */
const SERVER_FIELDS = new Set(['scanLog', 'scans', 'feedback']);

export interface CleanRecord {
  readonly slug: string;
  readonly name: string;
  readonly type: QrType;
  readonly record: Record<string, unknown>;
}

/**
 * The record as stored: the studio's own object without the fields the server
 * keeps itself, or null when it is not a record the studio could have written.
 */
export function cleanRecord(slug: string, input: unknown): CleanRecord | null {
  if (!QR_SLUG_PATTERN.test(slug)) return null;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  if (!isQrType(raw.type)) return null;
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!SERVER_FIELDS.has(key)) record[key] = value;
  }
  record.id = slug;
  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : slug;
  return { slug, name: name.slice(0, 200), type: raw.type, record };
}

// ---------------------------------------------------------------------------
// Website codes: which address a scan goes to
// ---------------------------------------------------------------------------

interface WebRange {
  readonly id?: unknown;
  readonly days?: unknown;
  readonly start?: unknown;
  readonly end?: unknown;
}

interface WebSite {
  readonly urls?: unknown;
  readonly countries?: unknown;
  readonly ranges?: unknown;
  readonly params?: unknown;
}

interface WebConfig {
  readonly timeOn?: unknown;
  readonly tz?: unknown;
  readonly ranges?: unknown;
  readonly ml?: unknown;
  readonly mc?: unknown;
  readonly langs?: unknown;
  readonly sites?: unknown;
}

export interface ScanContext {
  /** ISO country code of the visitor, upper case, when known. */
  readonly country: string | null;
  /** The visitor's preferred language (`ar`, `en`, …), when known. */
  readonly lang: string | null;
  readonly now: Date;
}

const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Only web addresses: a stored `javascript:` link must never become a redirect. */
export function safeHttpUrl(value: unknown): string | null {
  const text = asString(value).trim();
  if (text === '') return null;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Day (1 = Monday … 7 = Sunday) and minutes past midnight in `timeZone`. */
export function localDayAndMinutes(now: Date, timeZone: string): { day: number; minutes: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
  } catch {
    return localDayAndMinutes(now, 'Africa/Cairo');
  }
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const day = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday')) + 1;
  return { day, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

const toMinutes = (hhmm: unknown): number | null => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(asString(hhmm));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

/** Whether `range` covers this moment; a range past midnight (20:00–02:00) wraps. */
export function rangeCovers(range: WebRange, day: number, minutes: number): boolean {
  const days = asArray(range.days).map(Number);
  const start = toMinutes(range.start);
  const end = toMinutes(range.end);
  if (start === null || end === null) return false;
  if (start <= end) return days.includes(day) && minutes >= start && minutes < end;
  // Overnight: the evening part belongs to the listed day, the morning part to the day after.
  const yesterday = day === 1 ? 7 : day - 1;
  return (days.includes(day) && minutes >= start) || (days.includes(yesterday) && minutes < end);
}

function siteUrl(site: WebSite, web: WebConfig, lang: string | null): string | null {
  const urls =
    typeof site.urls === 'object' && site.urls !== null
      ? (site.urls as Record<string, unknown>)
      : {};
  const langs = asArray(web.langs).map(asString);
  const order = [
    ...(web.ml === true && lang !== null ? [lang] : []),
    ...langs,
    ...Object.keys(urls),
  ];
  for (const key of order) {
    const url = safeHttpUrl(urls[key]);
    if (url !== null) return url;
  }
  return null;
}

function withParams(url: string, params: unknown): string {
  const target = new URL(url);
  for (const param of asArray(params)) {
    if (typeof param !== 'object' || param === null) continue;
    const key = asString((param as { k?: unknown }).k).trim();
    if (key !== '') target.searchParams.set(key, asString((param as { v?: unknown }).v));
  }
  return target.toString();
}

/**
 * Where a scan of a website code goes: the first site that matches the
 * visitor's country (when the code is set per country) and the time of day
 * (when it is scheduled), in the visitor's language when the code has more
 * than one. With no match, the first site; with no sites, the plain address.
 */
export function websiteTarget(
  record: Record<string, unknown>,
  context: ScanContext,
): string | null {
  const data = (record.data ?? {}) as Record<string, unknown>;
  const page = (record.page ?? {}) as Record<string, unknown>;
  const web = (page.web ?? null) as WebConfig | null;
  const plain = safeHttpUrl(data.url);
  if (web === null) return plain;

  const sites = asArray(web.sites).filter((s): s is WebSite => typeof s === 'object' && s !== null);
  if (sites.length === 0) return plain;

  const { day, minutes } = localDayAndMinutes(context.now, asString(web.tz) || 'Africa/Cairo');
  const ranges = new Map(
    asArray(web.ranges)
      .filter((r): r is WebRange => typeof r === 'object' && r !== null)
      .map((r) => [asString(r.id), r]),
  );
  const matches = (site: WebSite): boolean => {
    if (web.mc === true) {
      const countries = asArray(site.countries).map((c) => asString(c).toUpperCase());
      if (
        countries.length > 0 &&
        (context.country === null || !countries.includes(context.country))
      )
        return false;
    }
    if (web.timeOn === true) {
      const own = asArray(site.ranges).map(asString);
      if (own.length > 0) {
        const covered = own.some((id) => {
          const range = ranges.get(id);
          return range !== undefined && rangeCovers(range, day, minutes);
        });
        if (!covered) return false;
      }
    }
    return true;
  };

  const chosen = sites.find(matches) ?? sites[0];
  const url = chosen === undefined ? null : siteUrl(chosen, web, context.lang);
  if (url === null) return plain;
  return withParams(url, chosen?.params);
}

// ---------------------------------------------------------------------------
// Scans
// ---------------------------------------------------------------------------

/** The visitor's system and browser, from the User-Agent header. */
export function describeAgent(userAgent: string | null): { os: string; browser: string } {
  const ua = userAgent ?? '';
  const os = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'Other';
  const browser = /SamsungBrowser/.test(ua)
    ? 'Samsung Internet'
    : /Edg\//.test(ua)
      ? 'Edge'
      : /OPR\/|Opera/.test(ua)
        ? 'Opera'
        : /FBAN|FBAV|Instagram|Line\//.test(ua)
          ? 'In-app'
          : /CriOS|Chrome\//.test(ua)
            ? 'Chrome'
            : /FxiOS|Firefox\//.test(ua)
              ? 'Firefox'
              : /Safari\//.test(ua)
                ? 'Safari'
                : 'Other';
  return { os, browser };
}

/** The first language of an Accept-Language header (`ar-EG,ar;q=0.9` → `ar`). */
export function primaryLanguage(acceptLanguage: string | null): string | null {
  const first = (acceptLanguage ?? '').split(',')[0]?.trim().split(/[-;]/)[0]?.toLowerCase() ?? '';
  return /^[a-z]{2,3}$/.test(first) ? first : null;
}

/** A two-letter country code, or null (`XX` and `T1` are Cloudflare's "unknown" and "Tor"). */
export function countryCode(value: string | null): string | null {
  const code = (value ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) && code !== 'XX' ? code : null;
}

/** One entry of a code's scan log, as the studio's statistics read it. */
export interface ScanLogEntry {
  readonly t: string;
  readonly k: string;
  readonly u: boolean;
  readonly os: string | null;
  readonly browser: string | null;
  readonly lang: string | null;
  readonly country: string | null;
  readonly city: string | null;
  readonly event: string | null;
  readonly name: string | null;
}

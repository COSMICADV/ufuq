/**
 * Business Identity — the shapes /business-identity returns, the calls the
 * screens make, and the thermal-printer copy of a logo (made in the browser:
 * black and white, 80 mm wide at most, judged for whether it prints well).
 */

import type { Locale } from '@ufuq/i18n';

import { fetchOne, sendRaw, uploadForm } from './api-client';

export type LogoType = 'png' | 'jpeg' | 'svg';

export interface Identity {
  readonly company_name: string;
  readonly activity: string | null;
  readonly name_ar: string | null;
  readonly name_en: string | null;
  readonly primary_color: string | null;
  readonly secondary_color: string | null;
  readonly phone: string | null;
  readonly whatsapp: string | null;
  readonly email: string | null;
  readonly website: string | null;
  readonly address_ar: string | null;
  readonly address_en: string | null;
  readonly instagram: string | null;
  readonly facebook: string | null;
  readonly tiktok: string | null;
  readonly logo: {
    readonly type: LogoType;
    readonly width: number | null;
    readonly height: number | null;
    readonly version: number;
    readonly has_thermal: boolean;
  } | null;
  readonly print_logo: boolean;
  readonly can_edit: boolean;
  readonly onboarding: { readonly applies: boolean; readonly pending: boolean };
  readonly updated_at: string | null;
}

export type IdentityText = Pick<
  Identity,
  | 'name_ar'
  | 'name_en'
  | 'primary_color'
  | 'secondary_color'
  | 'phone'
  | 'whatsapp'
  | 'email'
  | 'website'
  | 'address_ar'
  | 'address_en'
  | 'instagram'
  | 'facebook'
  | 'tiktok'
>;

export const DEFAULT_PRIMARY = '#1E7AFF';
export const DEFAULT_SECONDARY = '#0B1E4B';
export const ACCEPTED_LOGO = 'image/png,image/jpeg,image/svg+xml,.svg';
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

/** One shared request per page load: the shell, reports and settings all read it. */
let cached: { locale: Locale; promise: Promise<Identity> } | null = null;

export function loadIdentity(locale: Locale, fresh = false): Promise<Identity> {
  if (!fresh && cached?.locale === locale) return cached.promise;
  const promise = fetchOne<Identity>('/business-identity', { locale });
  cached = { locale, promise };
  promise.catch(() => {
    if (cached?.promise === promise) cached = null;
  });
  return promise;
}

function remember(locale: Locale, identity: Identity): Identity {
  cached = { locale, promise: Promise.resolve(identity) };
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('ufuq:identity', { detail: identity }));
  return identity;
}

export async function saveIdentity(locale: Locale, body: Partial<IdentityText> & { print_logo?: boolean }): Promise<Identity> {
  return remember(locale, await fetchOne<Identity>('/business-identity', { locale, method: 'PATCH', body }));
}

export async function uploadLogo(locale: Locale, logo: Blob, logoName: string, thermal: Blob | null, printLogo: boolean): Promise<Identity> {
  const form = new FormData();
  form.append('print_logo', String(printLogo));
  form.append('logo', logo, logoName);
  if (thermal) form.append('thermal', thermal, 'thermal.png');
  return remember(locale, await uploadForm<Identity>('/business-identity/logo', form, { locale }));
}

export async function removeLogo(locale: Locale): Promise<Identity> {
  return remember(locale, await fetchOne<Identity>('/business-identity/logo', { locale, method: 'DELETE' }));
}

export async function finishOnboarding(locale: Locale, action: 'complete' | 'skip'): Promise<Identity> {
  return remember(locale, await fetchOne<Identity>('/business-identity/onboarding', { locale, method: 'POST', body: { action } }));
}

/** The logo as an object URL (the API streams it to members of this company only). */
const blobs = new Map<string, Promise<Blob>>();

export async function logoUrl(locale: Locale, variant: 'main' | 'thermal', version: number): Promise<string> {
  // One download per logo version, shared by every part of the page that shows it.
  const key = `${variant}:${String(version)}`;
  let blob = blobs.get(key);
  if (!blob) {
    blob = sendRaw('/business-identity/logo', { locale, query: { variant, v: String(version) } }).then((r) => r.blob());
    blobs.set(key, blob);
    blob.catch(() => blobs.delete(key));
  }
  return URL.createObjectURL(await blob);
}

/** The name to show in this language, falling back to the other, then the company. */
export function displayName(identity: Pick<Identity, 'name_ar' | 'name_en' | 'company_name'>, locale: Locale): string {
  const primary = locale === 'ar' ? identity.name_ar : identity.name_en;
  const other = locale === 'ar' ? identity.name_en : identity.name_ar;
  return primary?.trim() || other?.trim() || identity.company_name;
}

function channel(hex: string, start: number): number {
  const c = parseInt(hex.slice(start, start + 2), 16) / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG contrast ratio of two #RRGGBB colours. */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string): number => 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

export function isHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

/** Light checks the browser can do before upload; the API checks the bytes again. */
export function svgLooksUnsafe(text: string): boolean {
  return (
    !/<svg[\s>]/i.test(text) ||
    /<\s*(script|foreignObject|iframe|embed|object)\b|\son[a-z]+\s*=|javascript\s*:|<!\s*(DOCTYPE|ENTITY)|@import/i.test(text) ||
    /\b(xlink:)?href\s*=\s*['"]\s*(?!#|data:image\/(png|jpe?g|gif|webp);base64,)/i.test(text)
  );
}

// ---------------------------------------------------------------------------
// Thermal copy
// ---------------------------------------------------------------------------

/** 80 mm paper at 203 dpi is 576 dots wide; the logo uses at most half the height. */
export const THERMAL_WIDTH = 576;
export const THERMAL_HEIGHT = 288;

export interface ThermalCopy {
  readonly blob: Blob;
  readonly url: string;
  /** Share of the logo area printed black. */
  readonly ink: number;
  /** Prints recognisably: neither almost empty nor a black block. */
  readonly suitable: boolean;
}

/** Share of black pixels → whether the logo prints well on a thermal printer. */
export function thermalSuitable(ink: number): boolean {
  return ink >= 0.02 && ink <= 0.55;
}

/**
 * Turn a logo into a 1-bit image for 58/80 mm thermal paper: transparent
 * becomes paper, then a luminance threshold. Pure pixel arithmetic, no AI.
 */
export async function makeThermal(source: CanvasImageSource, width: number, height: number): Promise<ThermalCopy> {
  const scale = Math.min(THERMAL_WIDTH / width, THERMAL_HEIGHT / height);
  const w = Math.max(1, Math.floor(width * scale));
  const h = Math.max(1, Math.floor(height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(source, 0, 0, w, h);
  const image = ctx.getImageData(0, 0, w, h);
  const px = image.data;
  let dark = 0;
  for (let i = 0; i < px.length; i += 4) {
    const lum = 0.2126 * (px[i] as number) + 0.7152 * (px[i + 1] as number) + 0.0722 * (px[i + 2] as number);
    const ink = lum < 160;
    if (ink) dark += 1;
    const v = ink ? 0 : 255;
    px[i] = v;
    px[i + 1] = v;
    px[i + 2] = v;
    px[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/png');
  });
  const ink = dark / (w * h);
  return { blob, url: URL.createObjectURL(blob), ink, suitable: thermalSuitable(ink) };
}

/** An SVG drawn as an image (never inserted into the page), at a size the canvas can use. */
export async function svgImage(text: string): Promise<{ image: HTMLImageElement; width: number; height: number }> {
  const viewBox = /viewBox\s*=\s*['"]\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(text);
  const vw = viewBox ? Number(viewBox[1]) : 512;
  const vh = viewBox ? Number(viewBox[2]) : 512;
  const scale = 1024 / Math.max(vw, vh);
  const width = Math.max(1, Math.floor(vw * scale));
  const height = Math.max(1, Math.floor(vh * scale));
  const sized = text.replace(/<svg\b([^>]*)>/i, (_match, attrs: string) => {
    const rest = attrs.replace(/\s(width|height)\s*=\s*(['"])[^'"]*\2/gi, '');
    return `<svg${rest} width="${String(width)}" height="${String(height)}">`;
  });
  const url = URL.createObjectURL(new Blob([sized], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    image.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('svg failed to load'));
      image.src = url;
    });
    return { image, width, height };
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

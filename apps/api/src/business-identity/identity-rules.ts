/**
 * Business Identity — what a logo file may be, read from its bytes (never from
 * its name or the browser's declared type), and the colour rules.
 */

export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
export const MAX_SVG_BYTES = 512 * 1024;
export const MAX_LOGO_EDGE = 4096;
export const MIN_LOGO_EDGE = 64;
/** 80 mm paper at 203 dpi; 58 mm paper (384 dots) scales the same image down. */
export const THERMAL_MAX_WIDTH = 576;
export const MAX_THERMAL_BYTES = 256 * 1024;

export type LogoType = 'png' | 'jpeg' | 'svg';

export interface InspectedImage {
  readonly type: LogoType;
  readonly width: number | null;
  readonly height: number | null;
}

export type LogoProblem = 'unsupported_type' | 'too_large' | 'too_small' | 'unsafe_svg' | 'corrupt';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function jpegSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1] as number;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

/**
 * Patterns an SVG logo may not contain: anything that runs code, loads from
 * elsewhere, or embeds another document. Such a file is refused outright
 * rather than "cleaned", so what is stored is exactly what was checked.
 */
const SVG_FORBIDDEN: readonly RegExp[] = [
  /<\s*script\b/i,
  /<\s*foreignObject\b/i,
  /<\s*(iframe|embed|object|audio|video|canvas|link|meta|base|form|input|button)\b/i,
  /<!\s*(DOCTYPE|ENTITY)/i,
  /<\?xml-stylesheet/i,
  /\son[a-z]+\s*=/i,
  /javascript\s*:/i,
  /vbscript\s*:/i,
  /data\s*:\s*(?!image\/(png|jpe?g|gif|webp);base64,)/i,
  /@import/i,
  /url\(\s*['"]?\s*(?![#'"])/i,
  /\b(xlink:)?href\s*=\s*['"]\s*(?!#|data:image\/(png|jpe?g|gif|webp);base64,)/i,
  /<\s*(animate|set|animateTransform|animateMotion)\b[^>]*\battributeName\s*=\s*['"](xlink:)?href/i,
];

export function svgProblem(text: string): LogoProblem | null {
  if (!/<svg[\s>]/i.test(text)) return 'unsupported_type';
  if (!/<\/svg\s*>\s*$/i.test(text.trim())) return 'corrupt';
  for (const pattern of SVG_FORBIDDEN) if (pattern.test(text)) return 'unsafe_svg';
  return null;
}

function svgSize(text: string): { width: number | null; height: number | null } {
  const viewBox = /viewBox\s*=\s*['"]\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(text);
  if (viewBox) return { width: Math.floor(Number(viewBox[1])), height: Math.floor(Number(viewBox[2])) };
  return { width: null, height: null };
}

/** What the uploaded logo really is, or why it is refused. */
export function inspectLogo(bytes: Buffer): InspectedImage | LogoProblem {
  const png = pngSize(bytes);
  const jpeg = png ? null : jpegSize(bytes);
  const raster = png ?? jpeg;
  if (raster) {
    if (bytes.length > MAX_LOGO_BYTES) return 'too_large';
    if (raster.width > MAX_LOGO_EDGE || raster.height > MAX_LOGO_EDGE) return 'too_large';
    if (raster.width < MIN_LOGO_EDGE && raster.height < MIN_LOGO_EDGE) return 'too_small';
    return { type: png ? 'png' : 'jpeg', ...raster };
  }
  if (bytes.length > MAX_SVG_BYTES) return 'too_large';
  // A text file: an SVG must be valid UTF-8 without a BOM trick or NUL bytes.
  if (bytes.includes(0)) return 'unsupported_type';
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
  const problem = svgProblem(text);
  if (problem) return problem;
  return { type: 'svg', ...svgSize(text) };
}

/** The thermal copy must be a small PNG no wider than 80 mm paper. */
export function thermalProblem(bytes: Buffer): LogoProblem | null {
  const size = pngSize(bytes);
  if (!size) return 'unsupported_type';
  if (bytes.length > MAX_THERMAL_BYTES || size.width > THERMAL_MAX_WIDTH || size.height > THERMAL_MAX_WIDTH) {
    return 'too_large';
  }
  return null;
}

export const CONTENT_TYPES: Readonly<Record<LogoType, string>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  svg: 'image/svg+xml',
};

export function normaliseColor(value: string): string {
  return value.trim().toUpperCase();
}

function channel(hex: string, start: number): number {
  const c = parseInt(hex.slice(start, start + 2), 16) / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG contrast ratio of two #RRGGBB colours (1 … 21). */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string): number => 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * What a file actually is — DOCUMENT 20 §7: "Allowlist by MIME **and** magic
 * bytes, not by extension."
 *
 * Pure: bytes in, an allowed type (or nothing) out. The service then requires
 * the type the client *declared* to equal the type the bytes *are*, so a
 * renamed executable, an HTML page labelled `image/png`, or a PNG labelled
 * `application/pdf` are all refused.
 *
 * DOCX and XLSX are ZIP containers, so the ZIP signature alone proves nothing.
 * They are recognised by the parts OOXML requires (`[Content_Types].xml` plus
 * `word/document.xml` or `xl/workbook.xml`), whose names a ZIP stores
 * uncompressed. A container holding `vbaProject.bin` — a macro-enabled
 * document wearing a `.docx` or `.xlsx` name — is refused: DOCUMENT 20 §7
 * "Execution: storage must not execute anything".
 */

export const MIME = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;

export type AllowedMime = (typeof MIME)[keyof typeof MIME];

/** DOCUMENT 20 §7 "Allowed: PDF, PNG, JPG, WebP, DOCX, XLSX". Mirrors the database CHECK. */
export const ALLOWED_MIME_TYPES: readonly AllowedMime[] = Object.values(MIME);

export function isAllowedMime(value: string): value is AllowedMime {
  return (ALLOWED_MIME_TYPES as readonly string[]).includes(value);
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const RIFF = [0x52, 0x49, 0x46, 0x46]; // RIFF
const WEBP = [0x57, 0x45, 0x42, 0x50]; // WEBP, at offset 8
const ZIP = [0x50, 0x4b, 0x03, 0x04]; // PK\x03\x04

/** The OOXML part names, read as Latin-1 so every byte maps to one character. */
function ooxmlKind(bytes: Uint8Array): 'docx' | 'xlsx' | null {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
  if (!text.includes('[Content_Types].xml')) return null;
  if (text.includes('vbaProject.bin')) return null;
  const word = text.includes('word/document.xml');
  const excel = text.includes('xl/workbook.xml');
  if (word === excel) return null; // neither, or an ambiguous both
  return word ? 'docx' : 'xlsx';
}

/** The allowed type these bytes are, or `null` when they are none of them. */
export function detectMime(bytes: Uint8Array): AllowedMime | null {
  if (startsWith(bytes, PDF)) return MIME.pdf;
  if (startsWith(bytes, PNG)) return MIME.png;
  if (startsWith(bytes, JPEG)) return MIME.jpeg;
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return MIME.webp;
  if (startsWith(bytes, ZIP)) {
    const kind = ooxmlKind(bytes);
    return kind === null ? null : MIME[kind];
  }
  return null;
}

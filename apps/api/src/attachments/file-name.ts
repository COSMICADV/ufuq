/**
 * The original file name, made safe to keep — DOCUMENT 20 §4 "Uploaded file
 * names sanitised and never used as storage paths", §7 "Original name stored
 * as metadata only".
 *
 * The name never reaches storage (the key is generated), so this is not a
 * path-traversal defence. It is what makes the name safe to store, render and
 * send back in a `Content-Disposition` header: no directory part, no control
 * characters or null bytes (DOCUMENT 20 §4), none of the characters that are
 * reserved in file names on common systems, no leading dots, and a length the
 * column holds. Arabic and every other script are kept as they are.
 */

export const MAX_NAME_LENGTH = 255;

/** Used when nothing usable is left — an empty, all-dots or all-control name. */
export const FALLBACK_NAME = 'file';

// eslint-disable-next-line no-control-regex -- matching control characters is the point.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const RESERVED = /[<>:"/\\|?*]/g;

export function sanitizeFileName(raw: string): string {
  // Only the last path segment: a browser on Windows may send "C:\\x\\a.pdf".
  const base = raw.split(/[/\\]/).pop() ?? '';
  let name = base
    .normalize('NFC')
    .replace(CONTROL, '')
    .replace(RESERVED, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');

  if (name.length > MAX_NAME_LENGTH) {
    // Keep the extension — it is what tells the person what they are opening.
    const dot = name.lastIndexOf('.');
    const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
    name = name.slice(0, MAX_NAME_LENGTH - extension.length) + extension;
  }
  return name === '' ? FALLBACK_NAME : name;
}

/**
 * The `Content-Disposition` value for a download. Always `attachment`, never
 * `inline`, so the browser saves the file rather than rendering it in the
 * application's origin (DOCUMENT 20 §7 "Execution"). RFC 6266 / RFC 5987: an
 * ASCII fallback for old clients, and the real UTF-8 name in `filename*`.
 */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * DOCUMENT 20 §§4 and 7 — what a file is, and what its name may be.
 */

import { describe, expect, it } from 'vitest';

import {
  contentDisposition,
  FALLBACK_NAME,
  MAX_NAME_LENGTH,
  sanitizeFileName,
} from './file-name.js';
import { ALLOWED_MIME_TYPES, detectMime, MIME } from './file-type.js';

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const ascii = (text: string): number[] => [...Buffer.from(text, 'latin1')];

/** The smallest byte sequence each allowed type is recognised by. */
const SAMPLES = {
  pdf: bytes(...ascii('%PDF-1.7\n%âãÏÓ\n')),
  png: bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13),
  jpeg: bytes(0xff, 0xd8, 0xff, 0xe0, 0, 16, ...ascii('JFIF')),
  webp: bytes(...ascii('RIFF'), 0x24, 0, 0, 0, ...ascii('WEBPVP8 ')),
  docx: bytes(0x50, 0x4b, 0x03, 0x04, ...ascii('....[Content_Types].xml....word/document.xml')),
  xlsx: bytes(0x50, 0x4b, 0x03, 0x04, ...ascii('....[Content_Types].xml....xl/workbook.xml')),
} as const;

describe('detectMime — magic bytes, not extensions', () => {
  it.each(Object.entries(SAMPLES))('recognises %s', (kind, sample) => {
    expect(detectMime(sample)).toBe(MIME[kind as keyof typeof MIME]);
  });

  it('allows exactly DOCUMENT 20 §7’s six types', () => {
    expect([...ALLOWED_MIME_TYPES].sort()).toEqual(
      [
        'application/pdf',
        'image/jpeg',
        'image/png',
        'image/webp',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ].sort(),
    );
  });

  it.each([
    ['a Windows executable', bytes(0x4d, 0x5a, 0x90, 0x00)],
    ['an ELF binary', bytes(0x7f, 0x45, 0x4c, 0x46)],
    ['an HTML page', bytes(...ascii('<!DOCTYPE html><script>'))],
    ['an SVG image', bytes(...ascii('<svg xmlns="http://www.w3.org/2000/svg">'))],
    ['a GIF', bytes(...ascii('GIF89a'))],
    ['a plain ZIP', bytes(0x50, 0x4b, 0x03, 0x04, ...ascii('notes.txt'))],
    [
      'a macro-enabled workbook named .xlsx',
      bytes(
        0x50,
        0x4b,
        0x03,
        0x04,
        ...ascii('[Content_Types].xml xl/workbook.xml xl/vbaProject.bin'),
      ),
    ],
    ['a RIFF that is not WebP', bytes(...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVEfmt '))],
    ['nothing at all', bytes()],
    ['a truncated PNG signature', bytes(0x89, 0x50, 0x4e)],
  ])('refuses %s', (_label, sample) => {
    expect(detectMime(sample)).toBeNull();
  });
});

describe('sanitizeFileName — metadata only, never a path', () => {
  it('keeps an ordinary name, Arabic included', () => {
    expect(sanitizeFileName('تقرير الربع الأول.pdf')).toBe('تقرير الربع الأول.pdf');
    expect(sanitizeFileName('Q1 report.xlsx')).toBe('Q1 report.xlsx');
  });

  it('drops any directory part, Unix or Windows', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('C:\\Users\\me\\scan.png')).toBe('scan.png');
  });

  it('removes control characters, null bytes and bidi overrides', () => {
    expect(sanitizeFileName('inv\u0000oice\u0007.pdf')).toBe('invoice.pdf');
    // U+202E would render "fdp.exe" as "exe.pdf" — the classic disguise.
    expect(sanitizeFileName('photo\u202egnp.exe')).toBe('photognp.exe');
  });

  it('replaces reserved characters and leading dots', () => {
    expect(sanitizeFileName('a<b>:c"d|e?f*.pdf')).toBe('a_b__c_d_e_f_.pdf');
    expect(sanitizeFileName('.hidden.pdf')).toBe('hidden.pdf');
  });

  it('falls back when nothing usable is left', () => {
    for (const name of ['', '   ', '...', '\u0000\u0001']) {
      expect(sanitizeFileName(name)).toBe(FALLBACK_NAME);
    }
  });

  it('fits the column, keeping the extension', () => {
    const name = sanitizeFileName(`${'a'.repeat(400)}.pdf`);
    expect(name).toHaveLength(MAX_NAME_LENGTH);
    expect(name.endsWith('.pdf')).toBe(true);
  });
});

describe('contentDisposition', () => {
  it('is always an attachment, with an ASCII fallback and the UTF-8 name', () => {
    expect(contentDisposition('تقرير.pdf')).toBe(
      `attachment; filename="_____.pdf"; filename*=UTF-8''${encodeURIComponent('تقرير.pdf')}`,
    );
    expect(contentDisposition('report.pdf')).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    );
  });
});

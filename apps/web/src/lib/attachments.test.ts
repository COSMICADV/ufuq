/**
 * The attachment helpers — DOCUMENT 20 §7, DOCUMENT 08 §4.14.
 */

import { createTranslator, LOCALES } from '@ufuq/i18n';
import { describe, expect, it } from 'vitest';

import {
  ACCEPT_ATTRIBUTE,
  ATTACHMENT_TYPES,
  downloadUrl,
  formatBytes,
  typeLabel,
  uploadErrorKey,
} from './attachments';

describe('the file picker', () => {
  it('offers exactly DOCUMENT 20 §7’s six types, by MIME and by extension', () => {
    expect(Object.values(ATTACHMENT_TYPES)).toEqual(['PDF', 'PNG', 'JPG', 'WebP', 'DOCX', 'XLSX']);
    for (const piece of ['application/pdf', 'image/webp', '.docx', '.xlsx', '.jpg', '.jpeg']) {
      expect(ACCEPT_ATTRIBUTE.split(',')).toContain(piece);
    }
    expect(ACCEPT_ATTRIBUTE).not.toMatch(/svg|html|zip|exe|\*/);
  });

  it('labels a type, and falls back to the MIME it does not know', () => {
    expect(typeLabel('image/jpeg')).toBe('JPG');
    expect(typeLabel('application/x-new')).toBe('application/x-new');
  });
});

describe('formatBytes', () => {
  it('uses the reader’s digits and units', () => {
    expect(formatBytes(512, 'en')).toBe('512 byte');
    expect(formatBytes(1536, 'en')).toBe('1.5 kB');
    expect(formatBytes(10 * 1024 * 1024, 'en')).toBe('10 MB');
    expect(formatBytes(1536, 'ar')).toMatch(/[٠-٩]/);
  });
});

describe('downloadUrl', () => {
  it('is the authorization-checked endpoint, never a storage URL', () => {
    expect(downloadUrl('abc')).toMatch(/\/api\/v1\/attachments\/abc$/);
  });
});

describe('uploadErrorKey — every refusal has a sentence in both languages', () => {
  const cases: readonly (readonly [number, string | null, string])[] = [
    [429, null, 'attachments.error_rate_limited'],
    [404, null, 'attachments.error_not_found'],
    [403, null, 'attachments.error_forbidden'],
    [422, 'too_large', 'attachments.error_too_large'],
    [422, 'unsupported_type', 'attachments.error_unsupported_type'],
    [422, 'required', 'attachments.error_required'],
    [500, null, 'attachments.error_generic'],
  ];
  it.each(cases)('%i %s → %s', (status, issue, key) => {
    expect(uploadErrorKey(status, issue)).toBe(key);
  });

  for (const locale of LOCALES) {
    it(`${locale}: each key resolves`, () => {
      const t = createTranslator(locale);
      for (const [, , key] of cases) {
        expect(t(key)).not.toBe('');
      }
    });
  }
});

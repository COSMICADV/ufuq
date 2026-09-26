/**
 * The client contract that has to hold on every request — DOCUMENT 08 §§1–2,
 * DOCUMENT 20 §6, DOCUMENT 27 RULE 25.
 *
 * These are the parts a screen cannot see going wrong: a missing CSRF header
 * looks like an intermittent 403, and an English constraint message leaking
 * into an Arabic form looks like a translation someone forgot.
 */

import { describe, expect, it } from 'vitest';

import {
  API_BASE_PATH,
  ApiError,
  apiUrl,
  buildHeaders,
  CSRF_HEADER_NAME,
  issueKeyFor,
  issueKeys,
  readCookie,
} from './api-client';

describe('apiUrl', () => {
  it('builds a versioned path — DOCUMENT 08 §1', () => {
    expect(apiUrl('/departments')).toContain(`${API_BASE_PATH}/departments`);
  });

  it('appends query parameters without the caller composing a string', () => {
    const url = new URL(apiUrl('/departments', { page: '2', per_page: '20' }));
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('per_page')).toBe('20');
  });

  it('encodes a value rather than letting it break the query string', () => {
    const url = new URL(apiUrl('/departments', { page: 'a b&c=d' }));
    expect(url.searchParams.get('page')).toBe('a b&c=d');
  });
});

describe('readCookie', () => {
  it('finds a cookie among several', () => {
    expect(readCookie('a=1; ufuq_csrf=token-value; b=2', 'ufuq_csrf')).toBe('token-value');
  });

  it('returns null when the cookie is absent', () => {
    expect(readCookie('a=1; b=2', 'ufuq_csrf')).toBeNull();
  });

  it('returns null for an empty cookie header', () => {
    expect(readCookie('', 'ufuq_csrf')).toBeNull();
  });

  it('does not match a cookie whose name merely ends with the one asked for', () => {
    expect(readCookie('not_ufuq_csrf=wrong', 'ufuq_csrf')).toBeNull();
  });

  it('decodes a percent-encoded value', () => {
    expect(readCookie('ufuq_csrf=a%2Bb', 'ufuq_csrf')).toBe('a+b');
  });
});

describe('buildHeaders — DOCUMENT 20 §6 double-submit', () => {
  it('sends the CSRF token on every mutating method', () => {
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      const headers = buildHeaders(method, 'ar', true, 'the-token');
      expect(headers[CSRF_HEADER_NAME]).toBe('the-token');
    }
  });

  it('does not send it on a safe method', () => {
    expect(buildHeaders('GET', 'ar', false, 'the-token')[CSRF_HEADER_NAME]).toBeUndefined();
  });

  it('omits the header entirely when there is no cookie to echo', () => {
    expect(buildHeaders('POST', 'ar', true, null)[CSRF_HEADER_NAME]).toBeUndefined();
  });

  it('always states the locale — DOCUMENT 08 §1', () => {
    expect(buildHeaders('GET', 'en', false, null)['Accept-Language']).toBe('en');
    expect(buildHeaders('GET', 'ar', false, null)['Accept-Language']).toBe('ar');
  });

  it('declares a JSON body only when there is one', () => {
    expect(buildHeaders('POST', 'ar', true, null)['Content-Type']).toBe('application/json');
    expect(buildHeaders('DELETE', 'ar', false, null)['Content-Type']).toBeUndefined();
  });
});

describe('ApiError', () => {
  it('keeps the code the server chose', () => {
    const error = new ApiError(409, {
      code: 'DEPARTMENT_HAS_POSITIONS',
      message_ar: 'ـ',
      message_en: '-',
    });
    expect(error.code).toBe('DEPARTMENT_HAS_POSITIONS');
    expect(error.status).toBe(409);
  });

  it('survives a response that is not the documented envelope', () => {
    const error = new ApiError(502, null);
    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.fields).toEqual({});
  });

  it('tells an expired session apart from a failure', () => {
    expect(new ApiError(401, null).isUnauthenticated).toBe(true);
    expect(new ApiError(500, null).isUnauthenticated).toBe(false);
  });
});

describe('issue mapping — DOCUMENT 27 RULE 25', () => {
  function withFields(fields: Record<string, string[]>): ApiError {
    return new ApiError(422, {
      code: 'VALIDATION_FAILED',
      message_ar: 'ـ',
      message_en: '-',
      fields,
    });
  }

  it('maps a deliberate issue code to its own translation key', () => {
    const error = withFields({ name_ar: ['already_taken'] });
    expect(issueKeyFor(error, 'name_ar')).toBe('validation.already_taken');
  });

  it('never surfaces a class-validator constraint sentence to a user', () => {
    const error = withFields({
      name_ar: ['name_ar must be shorter than or equal to 200 characters'],
    });
    expect(issueKeyFor(error, 'name_ar')).toBe('validation.invalid');
  });

  it('returns null for a field the server did not complain about', () => {
    expect(issueKeyFor(withFields({ name_ar: ['required'] }), 'name_en')).toBeNull();
  });

  it('maps every complained-about field at once', () => {
    const error = withFields({
      name_ar: ['already_taken'],
      parent_id: ['would_create_cycle'],
      name_en: ['name_en should not be empty'],
    });
    expect(issueKeys(error)).toEqual({
      name_ar: 'validation.already_taken',
      parent_id: 'validation.would_create_cycle',
      name_en: 'validation.invalid',
    });
  });

  it('maps a nested day index the schedule form uses as its key', () => {
    const error = withFields({ 'days.3': ['end_before_start'] });
    expect(issueKeyFor(error, 'days.3')).toBe('validation.end_before_start');
  });
});

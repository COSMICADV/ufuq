/**
 * The Requests Centre's screen rules — DOCUMENT 04 B13 / C8–C10.
 */

import { describe, expect, it } from 'vitest';

import {
  ageInDays,
  apiQueryForInboxFilters,
  createRequestBody,
  decisionBody,
  DEFAULT_INBOX_FILTERS,
  EMPTY_REQUEST_FORM,
  inboxFiltersFromParams,
  isNarrowed,
  newRequestPath,
  pendingWidgetQuery,
  requestPath,
  requestsPath,
  searchForInboxFilters,
  summaryOf,
  validateRequestForm,
} from './requests';

const EMPLOYEE = '00000000-0000-7000-8000-000000000001';

describe('B13 — the inbox filters', () => {
  it('defaults to Pending in every category', () => {
    expect(inboxFiltersFromParams(new URLSearchParams())).toEqual(DEFAULT_INBOX_FILTERS);
    expect(searchForInboxFilters(DEFAULT_INBOX_FILTERS)).toBe('');
    expect(apiQueryForInboxFilters(DEFAULT_INBOX_FILTERS, 20)).toEqual({
      page: '1',
      per_page: '20',
      status: 'pending',
    });
  });

  it('“all statuses” is explicit in the URL and absent from the API query', () => {
    const all = inboxFiltersFromParams(new URLSearchParams('status=all'));
    expect(all.status).toBe('');
    expect(searchForInboxFilters(all)).toBe('?status=all');
    expect(apiQueryForInboxFilters(all, 20)).not.toHaveProperty('status');
  });

  it('round-trips a tab, a status, an employee and a date range', () => {
    const filters = {
      category: 'attendance' as const,
      status: 'approved' as const,
      employee: EMPLOYEE,
      from: '2026-03-01',
      to: '2026-03-31',
      page: 2,
    };
    const search = searchForInboxFilters(filters);
    expect(inboxFiltersFromParams(new URLSearchParams(search.slice(1)))).toEqual(filters);
    expect(apiQueryForInboxFilters(filters, 20)).toEqual({
      page: '2',
      per_page: '20',
      category: 'attendance',
      status: 'approved',
      employee_id: EMPLOYEE,
      from: '2026-03-01',
      to: '2026-03-31',
    });
  });

  it('ignores values the API would refuse', () => {
    expect(
      inboxFiltersFromParams(
        new URLSearchParams('category=vacation&status=done&employee=x&from=March&page=-1'),
      ),
    ).toEqual(DEFAULT_INBOX_FILTERS);
  });

  it('knows when the list is narrowed beyond the default', () => {
    expect(isNarrowed(DEFAULT_INBOX_FILTERS)).toBe(false);
    expect(isNarrowed({ ...DEFAULT_INBOX_FILTERS, category: 'salary' })).toBe(false);
    expect(isNarrowed({ ...DEFAULT_INBOX_FILTERS, status: '' })).toBe(true);
    expect(isNarrowed({ ...DEFAULT_INBOX_FILTERS, from: '2026-03-01' })).toBe(true);
  });
});

describe('B13 — summary and age', () => {
  it('an attendance row is summarised by the day it corrects; a native one by its subject', () => {
    expect(summaryOf({ subject: 'Laptop', attendance: null })).toEqual({
      kind: 'text',
      text: 'Laptop',
    });
    expect(
      summaryOf({
        subject: null,
        attendance: { date: '2026-03-09' } as never,
      }),
    ).toEqual({ kind: 'attendance', date: '2026-03-09' });
  });

  it('counts whole days in the company’s calendar, not the browser’s', () => {
    const now = new Date('2026-03-10T08:00:00Z'); // 10:00 in Cairo
    expect(ageInDays('2026-03-10T07:00:00Z', 'Africa/Cairo', now)).toBe(0);
    // 23:30 on the 9th in Cairo is 21:30 UTC — yesterday there, one day old.
    expect(ageInDays('2026-03-09T21:30:00Z', 'Africa/Cairo', now)).toBe(1);
    // …but 22:30 UTC is already the 10th in Cairo.
    expect(ageInDays('2026-03-09T22:30:00Z', 'Africa/Cairo', now)).toBe(0);
    expect(ageInDays('2026-03-01T08:00:00Z', 'Africa/Cairo', now)).toBe(9);
  });
});

describe('C9 — the submission form', () => {
  it('requires a subject and a description', () => {
    expect(validateRequestForm(EMPTY_REQUEST_FORM)).toEqual({
      subject: 'validation.required',
      description: 'validation.required',
    });
    expect(
      validateRequestForm({ ...EMPTY_REQUEST_FORM, subject: 'x'.repeat(256), description: 'ok' }),
    ).toEqual({ subject: 'validation.too_long' });
    expect(validateRequestForm({ ...EMPTY_REQUEST_FORM, subject: 'a', description: 'b' })).toEqual(
      {},
    );
  });

  it('only a task request sends a task', () => {
    const base = {
      ...EMPTY_REQUEST_FORM,
      subject: ' Laptop ',
      description: ' Mine broke ',
      task_id: 't1',
    };
    expect(createRequestBody({ ...base, category: 'general' })).toEqual({
      category: 'general',
      subject: 'Laptop',
      description: 'Mine broke',
    });
    expect(createRequestBody({ ...base, category: 'task' })).toMatchObject({ task_id: 't1' });
    expect(createRequestBody({ ...base, category: 'task', task_id: '' })).not.toHaveProperty(
      'task_id',
    );
  });
});

describe('B13 — decisions', () => {
  it('reject requires a reason; approve’s response is optional', () => {
    expect(decisionBody('reject', '  ')).toEqual({ ok: false });
    expect(decisionBody('reject', ' Not in policy ')).toEqual({
      ok: true,
      body: { admin_response: 'Not in policy' },
    });
    expect(decisionBody('approve', '')).toEqual({ ok: true, body: {} });
  });
});

describe('paths', () => {
  it('names both surfaces', () => {
    expect(requestsPath('ar')).toBe('/ar/admin/requests');
    expect(requestsPath('en', 'app')).toBe('/en/app/requests');
    expect(requestPath('en', 'r1', 'app')).toBe('/en/app/requests/r1');
    expect(newRequestPath('ar')).toBe('/ar/app/requests/new');
  });
});

describe('B1 widget 7 — the dashboard’s pending requests', () => {
  it('asks for the five most recent pending requests the caller may decide', () => {
    expect(pendingWidgetQuery()).toEqual({ status: 'pending', reviewable: 'true', per_page: '5' });
  });
});

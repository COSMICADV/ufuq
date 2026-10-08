/**
 * Leave's screen rules — DOCUMENT 16, DOCUMENT 04 C1 / C9 / B13 / B25.
 */

import { describe, expect, it } from 'vitest';

import {
  affectsFutureCalculations,
  calculateQuery,
  EMPTY_LEAVE_FORM,
  EMPTY_LEAVE_TYPE_FORM,
  formatDays,
  formFromLeaveType,
  isNegative,
  leaveSubmission,
  leaveTypeBody,
  typeName,
  validateLeaveForm,
  validateLeaveTypeForm,
} from './leave';

describe('day figures', () => {
  it('reads two-place day strings the way a person does', () => {
    expect(formatDays('3.00')).toBe('3');
    expect(formatDays('11.67')).toBe('11.67');
    expect(formatDays('10.50')).toBe('10.5');
    expect(formatDays('-1.00')).toBe('-1');
    expect(isNegative('-1.00')).toBe(true);
    expect(isNegative('0.00')).toBe(false);
  });

  it('names a type in the reader’s language', () => {
    expect(typeName({ name_ar: 'سنوية', name_en: 'Annual' }, 'ar')).toBe('سنوية');
    expect(typeName({ name_ar: 'سنوية', name_en: 'Annual' }, 'en')).toBe('Annual');
  });
});

describe('C9 — the leave form', () => {
  it('asks the server to count only once both dates are chosen', () => {
    expect(calculateQuery({ ...EMPTY_LEAVE_FORM, start_date: '2026-03-15' })).toBeNull();
    expect(
      calculateQuery({ leave_type_id: 't1', start_date: '2026-03-15', end_date: '2026-03-19' }),
    ).toEqual({ start_date: '2026-03-15', end_date: '2026-03-19', leave_type_id: 't1' });
  });

  it('validates before submitting: type, dates in order, a 3-character reason, a required file', () => {
    expect(
      validateLeaveForm(EMPTY_LEAVE_FORM, { requiresAttachment: true, hasFile: false }),
    ).toEqual({
      leave_type_id: 'validation.required',
      start_date: 'validation.required',
      end_date: 'validation.required',
      reason: 'validation.reason_too_short',
      file: 'validation.required',
    });
    expect(
      validateLeaveForm(
        { leave_type_id: 't', start_date: '2026-03-19', end_date: '2026-03-15', reason: 'Trip' },
        { requiresAttachment: false, hasFile: false },
      ),
    ).toEqual({ end_date: 'validation.end_before_start' });
  });

  it('never sends a day count; a file makes the body multipart', () => {
    const form = {
      leave_type_id: 't',
      start_date: '2026-03-15',
      end_date: '2026-03-16',
      reason: ' Trip ',
    };
    const json = leaveSubmission(form, null);
    expect(json).toEqual({
      kind: 'json',
      body: {
        leave_type_id: 't',
        start_date: '2026-03-15',
        end_date: '2026-03-16',
        reason: 'Trip',
      },
    });
    expect(JSON.stringify(json)).not.toContain('days_count');
    const multipart = leaveSubmission(
      form,
      new File(['x'], 'note.pdf', { type: 'application/pdf' }),
    );
    expect(multipart.kind).toBe('form');
    if (multipart.kind === 'form') {
      expect(multipart.body.get('reason')).toBe('Trip');
      expect(multipart.body.get('file')).toBeInstanceOf(File);
      expect(multipart.body.has('days_count')).toBe(false);
    }
  });
});

describe('B25 — leave types', () => {
  it('a capped policy needs a cap; allowances are decimals as strings', () => {
    expect(
      validateLeaveTypeForm({
        ...EMPTY_LEAVE_TYPE_FORM,
        name_ar: 'أ',
        name_en: 'A',
        carry_over_policy: 'capped',
      }),
    ).toEqual({
      carry_over_cap: 'validation.required',
    });
    expect(
      validateLeaveTypeForm({
        ...EMPTY_LEAVE_TYPE_FORM,
        name_ar: 'أ',
        name_en: 'A',
        default_days_per_year: '1.234',
      }),
    ).toEqual({
      default_days_per_year: 'validation.invalid',
    });
    expect(
      leaveTypeBody({ ...EMPTY_LEAVE_TYPE_FORM, name_ar: 'أ', name_en: 'A', carry_over_cap: '5' }),
    ).toMatchObject({
      default_days_per_year: '0',
      carry_over_cap: null,
    });
  });

  it('warns when a change shapes future balances, not for a rename', () => {
    const type = formFromLeaveType({
      id: 't',
      name_ar: 'سنوية',
      name_en: 'Annual',
      is_paid: true,
      default_days_per_year: '14.00',
      requires_attachment: false,
      allows_negative_balance: false,
      carry_over_policy: 'none',
      carry_over_cap: null,
      is_active: true,
    });
    expect(type.default_days_per_year).toBe('14');
    expect(affectsFutureCalculations(type, { ...type, name_en: 'Yearly' })).toBe(false);
    expect(affectsFutureCalculations(type, { ...type, default_days_per_year: '21' })).toBe(true);
    expect(affectsFutureCalculations(type, { ...type, carry_over_policy: 'full' })).toBe(true);
  });
});

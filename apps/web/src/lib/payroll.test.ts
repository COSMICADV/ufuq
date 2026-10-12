/**
 * The payroll client rules — DOCUMENT 15, DOCUMENT 26 (web): forms validated
 * before they are sent and kept as typed, money always shown with its
 * piastres, the provisional estimate, and finalization never offered on a
 * phone.
 */

import { createTranslator } from '@ufuq/i18n';
import { describe, expect, it } from 'vitest';

import { ApiError } from './api-client';
import {
  ABSENCE_RULES,
  asDeduction,
  DAILY_WAGE_BASES,
  LATENESS_TYPES,
  PERIOD_STATUSES,
  REVIEW_REASONS,
  ROUNDING_RULES,
  UNPAID_LEAVE_RULES,
  attemptedNet,
  confirmationMatches,
  EMPTY_POLICY_FORM,
  entryBody,
  finalizationOffered,
  formFromPolicy,
  isDesktopWidth,
  isNegativeAmount,
  issueLabelKey,
  listedIssues,
  money,
  payrollPath,
  policyBody,
  salaryBody,
  salaryPath,
  statusTone,
  validateAdjustmentForm,
  validateEntryForm,
  validatePolicyForm,
  validateSalaryForm,
} from './payroll';
import type { PeriodAbilities, PolicyForm, SalaryPolicy } from './payroll';

const NONE: PeriodAbilities = {
  can_recalculate: false,
  can_submit_review: false,
  can_approve: false,
  can_return_to_draft: false,
  can_return_to_review: false,
  can_finalize: false,
  can_mark_paid: false,
  can_add_entries: false,
  can_adjust: false,
};

describe('finalization is never offered on a phone (DOCUMENT 15 "Mobile behaviour")', () => {
  const approved = { ...NONE, can_finalize: true };

  it('is offered only on a desktop viewport, when the period allows it', () => {
    expect(finalizationOffered(approved, true)).toBe(true);
    expect(finalizationOffered(approved, false)).toBe(false);
    expect(finalizationOffered(NONE, true)).toBe(false);
  });

  it('is not offered before the viewport is known', () => {
    expect(finalizationOffered(approved, null)).toBe(false);
  });

  it('treats 1024px and up as desktop, anything narrower as not', () => {
    expect(isDesktopWidth(1024)).toBe(true);
    expect(isDesktopWidth(1440)).toBe(true);
    expect(isDesktopWidth(1023)).toBe(false);
    expect(isDesktopWidth(375)).toBe(false);
    expect(isDesktopWidth(768)).toBe(false);
  });

  it('the typed confirmation must name the period exactly, Arabic digits accepted', () => {
    expect(confirmationMatches('2026-03', '2026-03')).toBe(true);
    expect(confirmationMatches(' 2026-03 ', '2026-03')).toBe(true);
    expect(confirmationMatches('٢٠٢٦-٠٣', '2026-03')).toBe(true);
    expect(confirmationMatches('2026-3', '2026-03')).toBe(false);
    expect(confirmationMatches('March', '2026-03')).toBe(false);
  });
});

describe('money is shown with its piastres, never truncated', () => {
  it('keeps the fraction in both languages', () => {
    expect(money('22401.86', 'EGP', 'en')).toBe('22,401.86 EGP');
    expect(money('22401.86', 'EGP', 'ar')).toBe('22,401.86 ج.م');
    expect(money('20000.00', 'EGP', 'en')).toBe('20,000.00 EGP');
  });

  it('knows a negative amount from a zero one, and shows a deduction as what it takes', () => {
    expect(isNegativeAmount('-728.57')).toBe(true);
    expect(isNegativeAmount('-0.00')).toBe(false);
    expect(isNegativeAmount('0.00')).toBe(false);
    expect(asDeduction('666.67')).toBe('-666.67');
    expect(asDeduction('0.00')).toBe('0.00');
    expect(asDeduction('-5.00')).toBe('-5.00');
  });

  it('tones each state', () => {
    expect(statusTone('draft')).toBe('info');
    expect(statusTone('finalized')).toBe('success');
    expect(statusTone('adjusted')).toBe('warning');
  });
});

describe('the salary policy form invents nothing', () => {
  it('starts empty and requires every rule', () => {
    const issues = validatePolicyForm(EMPTY_POLICY_FORM);
    expect(Object.keys(issues).sort()).toEqual(
      [
        'absence_deduction',
        'daily_wage_basis',
        'lateness_rule',
        'name',
        'overtime_rate',
        'rounding',
        'unpaid_leave_deduction',
      ].sort(),
    );
  });

  const valid: PolicyForm = {
    name: 'Standard',
    daily_wage_basis: 'fixed_days',
    fixed_days_value: '30',
    unpaid_leave_deduction: 'daily_wage',
    absence_deduction: 'daily_wage',
    lateness_type: 'per_minute',
    lateness_multiplier: '1.00',
    lateness_amount: '',
    overtime_rate: '1.50',
    rounding: 'none',
  };

  it('needs a fixed divisor of 1–31 days only for fixed_days, and a positive multiplier', () => {
    expect(validatePolicyForm(valid)).toEqual({});
    expect(validatePolicyForm({ ...valid, fixed_days_value: '0' }).fixed_days_value).toBeDefined();
    expect(validatePolicyForm({ ...valid, fixed_days_value: '32' }).fixed_days_value).toBeDefined();
    expect(
      validatePolicyForm({ ...valid, daily_wage_basis: 'calendar_days', fixed_days_value: '' }),
    ).toEqual({});
    expect(validatePolicyForm({ ...valid, lateness_multiplier: '0' }).lateness_rule).toBeDefined();
    expect(
      validatePolicyForm({ ...valid, lateness_type: 'fixed_per_incident', lateness_amount: '' })
        .lateness_rule,
    ).toBeDefined();
    expect(validatePolicyForm({ ...valid, overtime_rate: '1.555' }).overtime_rate).toBeDefined();
  });

  it('sends exactly the documented shape, strings for every decimal, Arabic digits normalised', () => {
    expect(policyBody({ ...valid, overtime_rate: '١٫٥٠'.replace('٫', '.') })).toEqual({
      name: 'Standard',
      daily_wage_basis: 'fixed_days',
      fixed_days_value: 30,
      unpaid_leave_deduction: 'daily_wage',
      absence_deduction: 'daily_wage',
      lateness_rule: { type: 'per_minute', multiplier: '1.00' },
      overtime_rate: '1.50',
      rounding: 'none',
    });
    expect(policyBody({ ...valid, daily_wage_basis: 'calendar_days' }).fixed_days_value).toBeNull();
    expect(policyBody({ ...valid, lateness_type: 'none' }).lateness_rule).toEqual({ type: 'none' });
  });

  it('reads a saved policy back into the form', () => {
    const policy: SalaryPolicy = {
      id: 'p',
      name: 'Standard',
      daily_wage_basis: 'scheduled_working_days',
      fixed_days_value: null,
      unpaid_leave_deduction: 'scheduled_day_wage',
      absence_deduction: 'none',
      lateness_rule: { type: 'fixed_per_incident', amount: '50.00' },
      overtime_rate: '0.00',
      rounding: 'nearest',
      updated_at: '2026-04-01T00:00:00.000Z',
    };
    expect(formFromPolicy(policy)).toMatchObject({
      fixed_days_value: '',
      lateness_type: 'fixed_per_incident',
      lateness_amount: '50.00',
    });
  });
});

describe('salary, deduction, bonus and adjustment forms', () => {
  it('a salary is a positive DECIMAL(15,2) with an effective date', () => {
    expect(
      validateSalaryForm({ monthly_salary: '20000.00', effective_from: '2026-03-16', note: '' }),
    ).toEqual({});
    expect(
      validateSalaryForm({ monthly_salary: '0', effective_from: '2026-03-16', note: '' })
        .monthly_salary,
    ).toBeDefined();
    expect(
      validateSalaryForm({ monthly_salary: '1.234', effective_from: '2026-03-16', note: '' })
        .monthly_salary,
    ).toBeDefined();
    expect(
      validateSalaryForm({ monthly_salary: '100', effective_from: '', note: '' }).effective_from,
    ).toBeDefined();
    expect(
      salaryBody({ monthly_salary: '٢٠٠٠٠', effective_from: '2026-03-16', note: ' ' }),
    ).toEqual({
      monthly_salary: '20000',
      effective_from: '2026-03-16',
    });
  });

  it('a deduction or bonus needs an amount above zero and a reason of 3+ characters', () => {
    expect(validateEntryForm({ amount: '500.00', reason: 'Laptop', type: '' })).toEqual({});
    expect(validateEntryForm({ amount: '0.00', reason: 'Laptop', type: '' }).amount).toBeDefined();
    expect(validateEntryForm({ amount: '-5', reason: 'Laptop', type: '' }).amount).toBeDefined();
    expect(validateEntryForm({ amount: '5', reason: 'ab', type: '' }).reason).toBeDefined();
    expect(entryBody({ amount: '500', reason: ' Laptop ', type: '' })).toEqual({
      amount: '500',
      reason: 'Laptop',
    });
  });

  it('an adjustment is signed, never zero', () => {
    expect(validateAdjustmentForm({ amount: '-150.25', reason: 'Overpaid' })).toEqual({});
    expect(validateAdjustmentForm({ amount: '150.25', reason: 'Underpaid' })).toEqual({});
    expect(validateAdjustmentForm({ amount: '0', reason: 'Nothing' }).amount).toBeDefined();
    expect(validateAdjustmentForm({ amount: '-0.00', reason: 'Nothing' }).amount).toBeDefined();
  });
});

describe('the server’s refusals, read', () => {
  it('shows the attempted net of an OD-06 refusal', () => {
    const error = new ApiError(422, {
      code: 'PAYROLL_NEGATIVE_NET',
      message_ar: '',
      message_en: '',
      fields: { resulting_net: ['-7249.50'] },
    });
    expect(attemptedNet(error)).toBe('-7249.50');
  });

  it('turns a blocking list into employees, issues and details', () => {
    const error = new ApiError(422, {
      code: 'PAYROLL_PREFLIGHT_BLOCKED',
      message_ar: '',
      message_en: '',
      fields: {
        e1: ['salary_missing:2026-03-01'],
        e2: ['pending:2026-03-04', 'missing:2026-03-31'],
      },
    });
    expect(listedIssues(error)).toEqual([
      { employeeId: 'e1', issue: 'salary_missing', detail: '2026-03-01' },
      { employeeId: 'e2', issue: 'pending', detail: '2026-03-04' },
      { employeeId: 'e2', issue: 'missing', detail: '2026-03-31' },
    ]);
    expect(issueLabelKey('salary_missing')).toBe('payroll.issue.salary_missing');
    expect(issueLabelKey('something_new')).toBe('payroll.issue.other');
  });
});

describe('paths are English and never localized (DOCUMENT 03 §9)', () => {
  it('admin and employee routes', () => {
    expect(payrollPath('ar')).toBe('/ar/admin/payroll');
    expect(payrollPath('en', 'p1')).toBe('/en/admin/payroll/p1');
    expect(payrollPath('en', 'p1', 'e1')).toBe('/en/admin/payroll/p1/e1');
    expect(salaryPath('ar')).toBe('/ar/app/salary');
    expect(salaryPath('ar', 'history')).toBe('/ar/app/salary/history');
  });
});

describe('every key the payroll screens build resolves in both languages', () => {
  const keys = [
    ...PERIOD_STATUSES.map((s) => `payroll.status.${s}`),
    ...DAILY_WAGE_BASES.map((b) => `payroll.basis.${b}`),
    ...[...UNPAID_LEAVE_RULES, ...ABSENCE_RULES].map((r) => `payroll.deduction_rule.${r}`),
    ...LATENESS_TYPES.map((l) => `payroll.lateness_type.${l}`),
    ...ROUNDING_RULES.map((r) => `payroll.rounding_rule.${r}`),
    ...REVIEW_REASONS.map((r) => `payroll.review.${r}`),
    ...[
      'salary_missing',
      'schedule_missing',
      'schedule_incomplete',
      'no_working_days_in_month',
      'negative_net',
      'no_longer_eligible_with_entries',
      'pending',
      'missing',
      'unknown',
    ].map(issueLabelKey),
    ...[
      'recalculate',
      'submit-review',
      'return-to-draft',
      'approve',
      'return-to-review',
      'mark-paid',
      'finalize',
      'deduction',
      'bonus',
      'adjustment',
    ].map((d) => `payroll.done.${d}`),
    ...['deduction', 'bonus', 'adjustment'].map((k) => `payroll.add_${k}`),
    // Labels that share a prefix with a group of keys.
    'payroll.lateness',
    'payroll.lateness_rule',
    'payroll.rounding',
    'payroll.deductions',
    'payroll.unpaid_leave',
    ...[
      'salary_policy_not_configured',
      'not_employed_this_month',
      'salary_missing',
      'schedule_incomplete',
      'schedule_missing',
      'no_working_days_in_month',
      'negative_net',
      'unavailable',
      'other',
    ].map((r) => `salary.unavailable.${r}`),
  ];
  for (const locale of ['ar', 'en'] as const) {
    it(`${locale}: ${String(keys.length)} keys`, () => {
      const t = createTranslator(locale);
      for (const key of keys) {
        expect(
          () => t(key, { detail: 'x', net: 'x', period: 'x', from: 'x', to: 'x', count: '1' }),
          key,
        ).not.toThrow();
        expect(
          typeof t(key, { detail: 'x', net: 'x', period: 'x', from: 'x', to: 'x', count: '1' }),
        ).toBe('string');
      }
    });
  }
});

'use client';

import { useCallback, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { ApiError, fetchOne, issueKeys } from '../../lib/api-client';
import {
  ABSENCE_RULES,
  DAILY_WAGE_BASES,
  EMPTY_POLICY_FORM,
  formFromPolicy,
  LATENESS_TYPES,
  policyBody,
  ROUNDING_RULES,
  UNPAID_LEAVE_RULES,
  validatePolicyForm,
} from '../../lib/payroll';
import type { PolicyForm, SalaryPolicy } from '../../lib/payroll';
import { Alert, Button, Card, Field, Input, Select } from '../design-system';
import { loadSession } from '../employees/use-session';
import {
  describeError,
  ErrorState,
  LoadingState,
  optionalError,
  SuccessNotice,
} from '../settings/screen-states';
import { SettingsHeading } from '../settings/settings-shell';
import { useResource } from '../settings/use-resource';

/**
 * `/admin/settings/salary-policy` — DOCUMENT 04 "Salary policy" (daily-wage
 * basis, unpaid-leave handling, lateness rule, overtime rule, rounding),
 * DOCUMENT 15 "SALARY CALCULATION ENGINE".
 *
 * - Exposes exactly the documented settings and nothing else.
 * - **No default is invented** (approved decision): until an ADMIN saves a
 *   policy the form is empty, and salaries and payroll are refused.
 * - Saving is confirmed first: the policy shapes every future and draft
 *   calculation; a finalized payroll is never recalculated.
 * - The server validates everything again; its field errors are shown on
 *   the fields, and the typed values are kept.
 */
export function SalaryPolicySettings({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const load = useCallback(
    async (signal: AbortSignal) => {
      const [session, current] = await Promise.all([
        loadSession(locale, signal),
        fetchOne<{ readonly policy: SalaryPolicy | null }>('/salary-policies', { locale, signal }),
      ]);
      return { session, policy: current.policy };
    },
    [locale],
  );
  const resource = useResource(load);
  const [form, setForm] = useState<PolicyForm | null>(null);
  const [issues, setIssues] = useState<Readonly<Record<string, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const heading = (
    <SettingsHeading
      title={t('settings.salary_policy')}
      description={t('payroll.policy_description')}
    />
  );
  if (resource.state.status === 'loading') {
    return (
      <>
        {heading}
        <LoadingState t={t} rows={8} />
      </>
    );
  }
  if (resource.state.status === 'error') {
    return (
      <>
        {heading}
        <ErrorState error={resource.state.error} t={t} onRetry={resource.reload} />
      </>
    );
  }
  const { session, policy } = resource.state.value;
  const canEdit = session.permissions.has('settings.salary_policy');
  const values = form ?? (policy === null ? EMPTY_POLICY_FORM : formFromPolicy(policy));
  const set = (patch: Partial<PolicyForm>): void => {
    setForm({ ...values, ...patch });
    setConfirming(false);
  };
  const issue = (field: string): string | undefined =>
    issues[field] === undefined ? undefined : t(issues[field]);

  const save = (): void => {
    const found = validatePolicyForm(values);
    setIssues(found);
    if (Object.keys(found).length > 0) {
      setFormError(t('validation.generic'));
      return;
    }
    if (!confirming) {
      setConfirming(true);
      setFormError(null);
      return;
    }
    setSaving(true);
    setFormError(null);
    fetchOne<{ readonly policy: SalaryPolicy }>('/salary-policies', {
      locale,
      method: 'PATCH',
      body: policyBody(values),
    })
      .then((saved) => {
        setConfirming(false);
        setForm(formFromPolicy(saved.policy));
        setNotice(t('payroll.policy_saved'));
        resource.replace({ session, policy: saved.policy });
      })
      .catch((error: unknown) => {
        setConfirming(false);
        if (error instanceof ApiError && Object.keys(error.fields).length > 0) {
          setIssues(issueKeys(error));
          setFormError(t('validation.generic'));
          return;
        }
        setFormError(describeError(error, t));
      })
      .finally(() => {
        setSaving(false);
      });
  };

  return (
    <>
      {heading}
      <SuccessNotice message={notice} t={t} />
      {policy === null ? (
        <Alert tone="warning" title={t('payroll.policy_missing_title')}>
          {t('payroll.policy_missing')}
        </Alert>
      ) : null}
      <Card>
        <div className="tasks-form__grid">
          {formError === null ? null : (
            <Alert tone="danger" title={t('validation.generic_title')}>
              {formError}
            </Alert>
          )}
          <Field label={t('payroll.policy_name')} required {...optionalError(issue('name'))}>
            <Input
              dir="auto"
              value={values.name}
              maxLength={100}
              disabled={!canEdit}
              onChange={(event) => {
                set({ name: event.target.value });
              }}
            />
          </Field>
          <Field
            label={t('payroll.daily_wage_basis')}
            helper={t('payroll.daily_wage_basis_helper')}
            required
            {...optionalError(issue('daily_wage_basis'))}
          >
            <Select
              value={values.daily_wage_basis}
              disabled={!canEdit}
              onChange={(event) => {
                set({ daily_wage_basis: event.target.value as PolicyForm['daily_wage_basis'] });
              }}
            >
              <option value="">{t('payroll.choose')}</option>
              {DAILY_WAGE_BASES.map((basis) => (
                <option key={basis} value={basis}>
                  {t(`payroll.basis.${basis}`)}
                </option>
              ))}
            </Select>
          </Field>
          {values.daily_wage_basis === 'fixed_days' ? (
            <Field
              label={t('payroll.fixed_days_value')}
              helper={t('payroll.fixed_days_helper')}
              required
              {...optionalError(issue('fixed_days_value'))}
            >
              <Input
                dir="ltr"
                inputMode="numeric"
                value={values.fixed_days_value}
                disabled={!canEdit}
                onChange={(event) => {
                  set({ fixed_days_value: event.target.value });
                }}
              />
            </Field>
          ) : null}
          <Field
            label={t('payroll.absence_deduction')}
            required
            {...optionalError(issue('absence_deduction'))}
          >
            <Select
              value={values.absence_deduction}
              disabled={!canEdit}
              onChange={(event) => {
                set({ absence_deduction: event.target.value as PolicyForm['absence_deduction'] });
              }}
            >
              <option value="">{t('payroll.choose')}</option>
              {ABSENCE_RULES.map((rule) => (
                <option key={rule} value={rule}>
                  {t(`payroll.deduction_rule.${rule}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label={t('payroll.unpaid_leave_deduction')}
            required
            {...optionalError(issue('unpaid_leave_deduction'))}
          >
            <Select
              value={values.unpaid_leave_deduction}
              disabled={!canEdit}
              onChange={(event) => {
                set({
                  unpaid_leave_deduction: event.target
                    .value as PolicyForm['unpaid_leave_deduction'],
                });
              }}
            >
              <option value="">{t('payroll.choose')}</option>
              {UNPAID_LEAVE_RULES.map((rule) => (
                <option key={rule} value={rule}>
                  {t(`payroll.deduction_rule.${rule}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label={t('payroll.lateness_rule')}
            required
            {...optionalError(issue('lateness_rule'))}
          >
            <Select
              value={values.lateness_type}
              disabled={!canEdit}
              onChange={(event) => {
                set({ lateness_type: event.target.value as PolicyForm['lateness_type'] });
              }}
            >
              <option value="">{t('payroll.choose')}</option>
              {LATENESS_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`payroll.lateness_type.${type}`)}
                </option>
              ))}
            </Select>
          </Field>
          {values.lateness_type === 'per_minute' ? (
            <Field
              label={t('payroll.lateness_multiplier')}
              helper={t('payroll.lateness_multiplier_helper')}
              required
            >
              <Input
                dir="ltr"
                inputMode="decimal"
                value={values.lateness_multiplier}
                disabled={!canEdit}
                onChange={(event) => {
                  set({ lateness_multiplier: event.target.value });
                }}
              />
            </Field>
          ) : null}
          {values.lateness_type === 'fixed_per_incident' ? (
            <Field label={t('payroll.lateness_amount')} required>
              <Input
                dir="ltr"
                inputMode="decimal"
                value={values.lateness_amount}
                disabled={!canEdit}
                onChange={(event) => {
                  set({ lateness_amount: event.target.value });
                }}
              />
            </Field>
          ) : null}
          <Field
            label={t('payroll.overtime_rate')}
            helper={t('payroll.overtime_rate_helper')}
            required
            {...optionalError(issue('overtime_rate'))}
          >
            <Input
              dir="ltr"
              inputMode="decimal"
              value={values.overtime_rate}
              disabled={!canEdit}
              onChange={(event) => {
                set({ overtime_rate: event.target.value });
              }}
            />
          </Field>
          <Field
            label={t('payroll.rounding')}
            helper={t('payroll.rounding_helper')}
            required
            {...optionalError(issue('rounding'))}
          >
            <Select
              value={values.rounding}
              disabled={!canEdit}
              onChange={(event) => {
                set({ rounding: event.target.value as PolicyForm['rounding'] });
              }}
            >
              <option value="">{t('payroll.choose')}</option>
              {ROUNDING_RULES.map((rule) => (
                <option key={rule} value={rule}>
                  {t(`payroll.rounding_rule.${rule}`)}
                </option>
              ))}
            </Select>
          </Field>
          {confirming ? (
            <Alert tone="warning" title={t('payroll.policy_confirm_title')}>
              {t('payroll.policy_confirm')}
            </Alert>
          ) : null}
          {canEdit ? (
            <div className="tasks-toolbar">
              <Button loading={saving} onClick={save}>
                {confirming ? t('payroll.policy_confirm_save') : t('action.save')}
              </Button>
            </div>
          ) : null}
        </div>
      </Card>
    </>
  );
}

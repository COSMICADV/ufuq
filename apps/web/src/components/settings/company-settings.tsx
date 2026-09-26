'use client';

import { useCallback, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import { LOCALES } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { ApiError, fetchOne, issueKeys } from '../../lib/api-client';
import { Alert, Button, Card, Field, Input, Select } from '../design-system';
import { ErrorState, LoadingState, Ltr, optionalError, SuccessNotice } from './screen-states';
import { SettingsHeading } from './settings-shell';
import { useResource } from './use-resource';

/**
 * `/admin/settings/company` — DOCUMENT 04 B25, DOCUMENT 08 §4.2.
 *
 * Six editable fields, by the approved Phase 4 decision. `slug` and `status`
 * are shown because an admin looking at company settings expects to see them,
 * and are not editable because they are not in that decision — a read-only
 * field is honest; a field that looks editable and is rejected by the server
 * is not.
 *
 * The four states (DOCUMENT 11 §2) are all here: a skeleton while loading, an
 * error card with a retry that keeps the screen usable, the loaded form, and a
 * success notice in a live region. There is no *empty* state, and this is the
 * one screen where that is correct rather than an omission: an authenticated
 * session always belongs to a company, so "no company" is unreachable — and
 * if the record somehow cannot be read, that is the error state, not an
 * invitation to create one (company creation is Phase 16).
 */

interface CompanyPayload {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly logo_path: string | null;
  readonly timezone: string;
  readonly currency: string;
  readonly default_locale: string;
  readonly fiscal_month_start_day: number;
  readonly correction_window_days: number;
  readonly status: string;
}

/** Sent as-is; the server is the authority on what is acceptable. */
interface CompanyForm {
  name: string;
  logo_path: string;
  timezone: string;
  currency: string;
  default_locale: string;
  fiscal_month_start_day: string;
  correction_window_days: string;
}

function toForm(company: CompanyPayload): CompanyForm {
  return {
    name: company.name,
    logo_path: company.logo_path ?? '',
    timezone: company.timezone,
    currency: company.currency,
    default_locale: company.default_locale,
    fiscal_month_start_day: String(company.fiscal_month_start_day),
    correction_window_days: String(company.correction_window_days),
  };
}

export function CompanySettings({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);

  const load = useCallback(
    (signal: AbortSignal) => fetchOne<CompanyPayload>('/company', { locale, signal }),
    [locale],
  );
  const { state, reload, replace } = useResource(load);

  const [form, setForm] = useState<CompanyForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [fieldIssues, setFieldIssues] = useState<Readonly<Record<string, string>>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  const heading = (
    <SettingsHeading
      title={t('settings.company_title')}
      description={t('settings.company_description')}
    />
  );

  if (state.status === 'loading') {
    return (
      <>
        {heading}
        <LoadingState t={t} rows={6} />
      </>
    );
  }

  if (state.status === 'error') {
    return (
      <>
        {heading}
        <ErrorState error={state.error} t={t} onRetry={reload} />
      </>
    );
  }

  const company = state.value;
  // The form is seeded from the loaded record on first render and owned by the
  // user afterwards — DOCUMENT 11 §2, error state: "form input stays entered".
  const values = form ?? toForm(company);

  const set = (key: keyof CompanyForm, value: string): void => {
    setForm({ ...values, [key]: value });
    setSaved(null);
  };

  const issueFor = (field: string): string | undefined => {
    const key = fieldIssues[field];
    return key === undefined ? undefined : t(key);
  };

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setSaving(true);
    setSaved(null);
    setSubmitError(null);
    setFieldIssues({});

    fetchOne<CompanyPayload>('/company', {
      locale,
      method: 'PATCH',
      body: {
        name: values.name,
        // An empty box means "no logo", which is a real value for a nullable
        // column, not the same as leaving the field out.
        logo_path: values.logo_path === '' ? null : values.logo_path,
        timezone: values.timezone,
        currency: values.currency,
        default_locale: values.default_locale,
        fiscal_month_start_day: values.fiscal_month_start_day,
        correction_window_days: values.correction_window_days,
      },
    })
      .then((updated) => {
        replace(updated);
        setForm(toForm(updated));
        setSaved(t('state.success'));
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && Object.keys(error.fields).length > 0) {
          setFieldIssues(issueKeys(error));
          setSubmitError(t('validation.generic'));
          return;
        }
        setSubmitError(
          error instanceof ApiError && error.isUnauthenticated
            ? t('state.session_required')
            : t('state.error'),
        );
      })
      .finally(() => {
        setSaving(false);
      });
  };

  return (
    <>
      {heading}
      <SuccessNotice message={saved} t={t} />

      {/* DOCUMENT 04 B25: "All settings screens warn before saving changes
          that affect historical calculations, and state explicitly that
          finalized payroll is not recalculated." */}
      <Alert tone="warning" title={t('settings.historical_warning_title')}>
        {t('settings.historical_warning')}
      </Alert>

      <Card>
        <form className="settings-form" onSubmit={submit} noValidate>
          {submitError === null ? null : (
            <div className="settings-form__summary">
              <Alert tone="danger" title={t('validation.generic_title')}>
                {submitError}
              </Alert>
            </div>
          )}

          <Field label={t('settings.name')} required {...optionalError(issueFor('name'))}>
            <Input
              name="name"
              value={values.name}
              onChange={(event) => {
                set('name', event.target.value);
              }}
              maxLength={200}
              required
            />
          </Field>

          <Field
            label={t('settings.timezone')}
            required
            helper={t('settings.timezone_helper')}
            {...optionalError(issueFor('timezone'))}
          >
            {/* An IANA identifier is a Latin token: it stays LTR inside an
                Arabic form (DOCUMENT 10 §9.7). */}
            <Input
              name="timezone"
              dir="ltr"
              value={values.timezone}
              onChange={(event) => {
                set('timezone', event.target.value);
              }}
              maxLength={64}
              required
            />
          </Field>

          <Field
            label={t('settings.currency')}
            required
            helper={t('settings.currency_helper')}
            {...optionalError(issueFor('currency'))}
          >
            <Input
              name="currency"
              dir="ltr"
              value={values.currency}
              onChange={(event) => {
                set('currency', event.target.value);
              }}
              maxLength={3}
              required
            />
          </Field>

          <Field
            label={t('settings.default_locale')}
            required
            {...optionalError(issueFor('default_locale'))}
          >
            <Select
              name="default_locale"
              value={values.default_locale}
              onChange={(event) => {
                set('default_locale', event.target.value);
              }}
            >
              {LOCALES.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {t(`language.${candidate}`)}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label={t('settings.fiscal_month_start_day')}
            required
            helper={t('settings.fiscal_month_start_day_helper')}
            {...optionalError(issueFor('fiscal_month_start_day'))}
          >
            {/* Deliberately not `type="number"`: a number input silently
                discards Arabic-Indic digits, so an admin typing ٢٦ on an
                Arabic keyboard would watch the field empty itself. The
                server normalises the digits (DOCUMENT 08 §5.5) and validates
                the range, which is where both belong anyway — a browser's
                spinner is not a validation rule. */}
            <Input
              name="fiscal_month_start_day"
              inputMode="numeric"
              dir="ltr"
              value={values.fiscal_month_start_day}
              onChange={(event) => {
                set('fiscal_month_start_day', event.target.value);
              }}
              required
            />
          </Field>

          <Field
            label={t('settings.correction_window_days')}
            required
            helper={t('settings.correction_window_days_helper')}
            {...optionalError(issueFor('correction_window_days'))}
          >
            {/* Same reasoning as the field above: not `type="number"`, so
                Arabic-Indic digits survive being typed. */}
            <Input
              name="correction_window_days"
              inputMode="numeric"
              dir="ltr"
              value={values.correction_window_days}
              onChange={(event) => {
                set('correction_window_days', event.target.value);
              }}
              required
            />
          </Field>

          <Field
            label={t('settings.logo_path')}
            helper={t('settings.logo_path_helper')}
            {...optionalError(issueFor('logo_path'))}
          >
            <Input
              name="logo_path"
              dir="ltr"
              value={values.logo_path}
              onChange={(event) => {
                set('logo_path', event.target.value);
              }}
              maxLength={500}
            />
          </Field>

          <div className="settings-form__readonly">
            <dl>
              <dt>{t('settings.slug')}</dt>
              <dd>
                <Ltr>{company.slug}</Ltr>
              </dd>
              <dt>{t('settings.status')}</dt>
              <dd>{t(`settings.status_${company.status}`)}</dd>
            </dl>
          </div>

          <div className="settings-form__actions">
            <Button type="submit" loading={saving}>
              {saving ? t('state.saving') : t('action.save')}
            </Button>
          </div>
        </form>
      </Card>
    </>
  );
}

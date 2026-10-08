'use client';

import { useCallback, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';

import { ApiError, fetchOne, issueKeys } from '../../lib/api-client';
import { COMPONENTS, bodyFromForm, formFromConfig, weightSum } from '../../lib/performance';
import type { Component, PerformanceConfig, PerformanceForm } from '../../lib/performance';
import { Alert, Button, Card, Field, Input } from '../design-system';
import { ErrorState, LoadingState, Ltr, optionalError, SuccessNotice } from './screen-states';
import { SettingsHeading } from './settings-shell';
import { useResource } from './use-resource';

/**
 * `/admin/settings/performance` — DOCUMENT 04 B25 "Weights for attendance /
 * tasks / goals, and each sub-metric", DOCUMENT 14 "Performance".
 *
 * The whole model is edited and saved together. Each group of weights shows
 * its live sum, and a sum that is not exactly 1 blocks the save with that sum
 * shown (DOCUMENT 14 "Error states"); the API refuses it again. The numbers
 * this screen first shows are the company's stored configuration — DOCUMENT
 * 14's default model, written when the company was created — never values
 * held by the screen.
 *
 * Reading needs `settings.view` and saving `settings.performance_weights`
 * (DOCUMENT 08 §4.2); both are ADMIN-only in V1, and the API checks both.
 */
export function PerformanceSettings({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const load = useCallback(
    (signal: AbortSignal) => fetchOne<PerformanceConfig>('/performance-config', { locale, signal }),
    [locale],
  );
  const { state, reload, replace } = useResource(load);

  const [form, setForm] = useState<PerformanceForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [fieldIssues, setFieldIssues] = useState<Readonly<Record<string, string>>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  const heading = (
    <SettingsHeading
      title={t('performance.settings_title')}
      description={t('performance.settings_description')}
    />
  );
  if (state.status === 'loading') {
    return (
      <>
        {heading}
        <LoadingState t={t} rows={8} />
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

  const config = state.value;
  const values = form ?? formFromConfig(config);
  const update = (next: PerformanceForm): void => {
    setForm(next);
    setSaved(null);
  };
  const issueFor = (field: string): string | undefined => {
    const key = fieldIssues[field];
    return key === undefined ? undefined : t(key);
  };

  const main = weightSum(COMPONENTS.map((component) => values.weights[component]));
  const task = weightSum([values.completion_weight, values.on_time_weight]);
  const blocked = !main.isWhole || !task.isWhole;

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (blocked) {
      setSubmitError(t('performance.sum_blocked'));
      return;
    }
    setSaving(true);
    setSaved(null);
    setSubmitError(null);
    setFieldIssues({});
    fetchOne<PerformanceConfig>('/performance-config', {
      locale,
      method: 'PATCH',
      body: bodyFromForm(values),
    })
      .then((next) => {
        replace(next);
        setForm(formFromConfig(next));
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
      {/* DOCUMENT 04 B25 and DOCUMENT 14 edge case: historical reports keep
          the weights stored in their snapshot. */}
      <Alert tone="warning" title={t('settings.historical_warning_title')}>
        {t('performance.historical_warning')}
      </Alert>

      <form className="settings-form" onSubmit={submit} noValidate>
        {submitError === null ? null : (
          <div className="settings-form__summary">
            <Alert tone="danger" title={t('validation.generic_title')}>
              {submitError}
            </Alert>
          </div>
        )}

        <Card title={t('performance.weights_title')}>
          <p className="tasks-muted">{t('performance.weights_help')}</p>
          <div className="settings-form">
            {COMPONENTS.map((component) => (
              <WeightField
                key={component}
                t={t}
                label={t(`performance.component.${component}`)}
                value={values.weights[component]}
                error={issueFor(`weights.${component}`)}
                onChange={(value) => {
                  update({
                    ...values,
                    weights: { ...values.weights, [component]: value } as Record<Component, string>,
                  });
                }}
              />
            ))}
            <SumLine t={t} sum={main.sum} whole={main.isWhole} issue={issueFor('weights')} />
          </div>
        </Card>

        <Card title={t('performance.attendance_title')}>
          <p className="tasks-muted">{t('performance.attendance_help')}</p>
          <div className="settings-form">
            <Field
              label={t('performance.late_penalty')}
              helper={t('performance.penalty_helper')}
              {...optionalError(issueFor('attendance.late_penalty'))}
            >
              <Input
                inputMode="decimal"
                dir="ltr"
                value={values.late_penalty}
                onChange={(event) => {
                  update({ ...values, late_penalty: event.target.value });
                }}
              />
            </Field>
            <Field
              label={t('performance.absence_penalty')}
              helper={t('performance.penalty_helper')}
              {...optionalError(issueFor('attendance.absence_penalty'))}
            >
              <Input
                inputMode="decimal"
                dir="ltr"
                value={values.absence_penalty}
                onChange={(event) => {
                  update({ ...values, absence_penalty: event.target.value });
                }}
              />
            </Field>
          </div>
        </Card>

        <Card title={t('performance.task_title')}>
          <p className="tasks-muted">{t('performance.task_help')}</p>
          <div className="settings-form">
            <WeightField
              t={t}
              label={t('performance.completion_weight')}
              value={values.completion_weight}
              error={issueFor('task.completion_weight')}
              onChange={(value) => {
                update({ ...values, completion_weight: value });
              }}
            />
            <WeightField
              t={t}
              label={t('performance.on_time_weight')}
              value={values.on_time_weight}
              error={issueFor('task.on_time_weight')}
              onChange={(value) => {
                update({ ...values, on_time_weight: value });
              }}
            />
            <SumLine t={t} sum={task.sum} whole={task.isWhole} issue={issueFor('task')} />
          </div>
        </Card>

        <p className="tasks-muted">
          {config.updated_by === null
            ? t('performance.default_note')
            : t('performance.updated_by', { name: config.updated_by.name })}
        </p>

        <div className="settings-form__actions">
          <Button type="submit" loading={saving} disabled={blocked}>
            {saving ? t('state.saving') : t('action.save')}
          </Button>
        </div>
      </form>
    </>
  );
}

function WeightField({
  t,
  label,
  value,
  error,
  onChange,
}: {
  readonly t: Translator;
  readonly label: string;
  readonly value: string;
  readonly error: string | undefined;
  readonly onChange: (value: string) => void;
}): React.JSX.Element {
  return (
    <Field label={label} required helper={t('performance.weight_helper')} {...optionalError(error)}>
      {/* Not `type="number"`: Arabic-Indic digits must survive typing. */}
      <Input
        inputMode="decimal"
        dir="ltr"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </Field>
  );
}

/** "Sum: 0.9000 — must be exactly 1" — DOCUMENT 14: the save is blocked with the sum shown. */
function SumLine({
  t,
  sum,
  whole,
  issue,
}: {
  readonly t: Translator;
  readonly sum: string | null;
  readonly whole: boolean;
  readonly issue: string | undefined;
}): React.JSX.Element {
  return (
    <p className={whole ? 'tasks-muted' : 'field__error'} role={whole ? undefined : 'alert'}>
      {t('performance.sum_label')}: <Ltr>{sum ?? '—'}</Ltr>
      {whole ? ` — ${t('performance.sum_ok')}` : ` — ${issue ?? t('validation.must_sum_to_one')}`}
    </p>
  );
}

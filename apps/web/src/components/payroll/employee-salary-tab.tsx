'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import type { Locale, Translator } from '@ufuq/i18n';

import { ApiError, fetchMany, fetchOne, issueKeys } from '../../lib/api-client';
import {
  EMPTY_SALARY_FORM,
  monthLabel,
  newIdempotencyKey,
  payrollPath,
  salaryBody,
  validateSalaryForm,
} from '../../lib/payroll';
import type { EmployeeSalary, PayrollLine, SalaryForm } from '../../lib/payroll';
import { Alert, Button, Card, DataTable, EmptyState, Field, Input, Modal } from '../design-system';
import {
  Cell,
  describeError,
  ErrorState,
  LoadingState,
  optionalError,
  SuccessNotice,
} from '../settings/screen-states';
import { useResource } from '../settings/use-resource';
import { Amount } from './payroll-shared';

/**
 * The employee profile's Salary tab — DOCUMENT 04 B4 "Salary": the current
 * salary, the salary history and the payslip history.
 *
 * Rendered only for `employee.view_salary` (the profile hides the tab, and
 * the API refuses it): an ADMIN in V1, never a MANAGER (OD-07 A). Setting a
 * salary needs `employee.set_salary`, and always appends a row — the history
 * is shown exactly as stored, amounts never edited.
 */
export function EmployeeSalaryTab({
  locale,
  t,
  employeeId,
  canSet,
  canViewPayroll,
  currency,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly employeeId: string;
  readonly canSet: boolean;
  readonly canViewPayroll: boolean;
  readonly currency: string;
}): React.JSX.Element {
  const load = useCallback(
    async (signal: AbortSignal) => {
      const [salary, payslips] = await Promise.all([
        fetchOne<EmployeeSalary>(`/employees/${employeeId}/salary`, { locale, signal }),
        canViewPayroll
          ? fetchMany<PayrollLine>('/payroll/lines', {
              locale,
              signal,
              query: { employee_id: employeeId, per_page: '100' },
            }).then((page) => page.items)
          : Promise.resolve([] as PayrollLine[]),
      ]);
      return { salary, payslips };
    },
    [locale, employeeId, canViewPayroll],
  );
  const resource = useResource(load);
  const [setting, setSetting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  if (resource.state.status === 'loading') return <LoadingState t={t} rows={5} />;
  if (resource.state.status === 'error') {
    return <ErrorState error={resource.state.error} t={t} onRetry={resource.reload} />;
  }
  const { salary, payslips } = resource.state.value;
  const historyHeaders = [
    t('salary.monthly_salary'),
    t('salary.effective_from'),
    t('salary.effective_to'),
    t('payroll.col_reason'),
    t('payroll.col_created_by'),
  ];
  const payslipHeaders = [t('payroll.col_period'), t('payroll.col_net'), t('payroll.adjusted_net')];

  return (
    <>
      <SuccessNotice message={notice} t={t} />
      <Card
        title={t('salary.current_salary')}
        action={
          canSet ? (
            <Button
              size="sm"
              onClick={() => {
                setSetting(true);
              }}
            >
              {salary.current === null && salary.history.length === 0
                ? t('salary.set')
                : t('salary.change')}
            </Button>
          ) : null
        }
      >
        {salary.current === null ? (
          <p className="tasks-muted">{t('salary.none_current')}</p>
        ) : (
          <p className="payroll-figure__value">
            <Amount
              value={salary.current.monthly_salary}
              currency={salary.current.currency}
              locale={locale}
            />
          </p>
        )}
      </Card>
      <Card title={t('salary.history')} className="tasks-table">
        {salary.history.length === 0 ? (
          <EmptyState
            title={t('salary.history_none_title')}
            description={t('salary.history_none')}
            action={null}
          />
        ) : (
          <DataTable
            headers={historyHeaders}
            rows={salary.history.map((row) => [
              <Cell key="amount" label={historyHeaders[0] as string}>
                <Amount value={row.monthly_salary} currency={row.currency} locale={locale} />
              </Cell>,
              <Cell key="from" label={historyHeaders[1] as string}>
                <span dir="ltr">{row.effective_from}</span>
              </Cell>,
              <Cell key="to" label={historyHeaders[2] as string}>
                <span dir="ltr">{row.effective_to ?? t('salary.open_ended')}</span>
              </Cell>,
              <Cell key="note" label={historyHeaders[3] as string}>
                <span dir="auto">{row.note ?? '—'}</span>
              </Cell>,
              <Cell key="by" label={historyHeaders[4] as string}>
                <span dir="ltr">{row.created_by.email}</span>
              </Cell>,
            ])}
          />
        )}
      </Card>
      {canViewPayroll ? (
        <Card title={t('salary.payslips')} className="tasks-table">
          {payslips.length === 0 ? (
            <p className="tasks-muted">{t('salary.history_empty')}</p>
          ) : (
            <DataTable
              headers={payslipHeaders}
              rows={payslips.map((line) => [
                <Cell key="period" label={payslipHeaders[0] as string}>
                  <Link href={payrollPath(locale, line.period_id, employeeId)}>
                    {monthLabel(line.period_year, line.period_month, locale)}
                  </Link>
                </Cell>,
                <Cell key="net" label={payslipHeaders[1] as string}>
                  <Amount value={line.net_salary} currency={currency} locale={locale} />
                </Cell>,
                <Cell key="adjusted" label={payslipHeaders[2] as string}>
                  <Amount value={line.adjusted_net} currency={currency} locale={locale} />
                </Cell>,
              ])}
            />
          )}
        </Card>
      ) : null}
      {setting ? (
        <SetSalaryDialog
          locale={locale}
          t={t}
          employeeId={employeeId}
          onClose={() => {
            setSetting(false);
          }}
          onSaved={(next) => {
            setSetting(false);
            setNotice(t('salary.saved'));
            resource.replace({ salary: next, payslips });
          }}
        />
      ) : null}
    </>
  );
}

function SetSalaryDialog({
  locale,
  t,
  employeeId,
  onClose,
  onSaved,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly employeeId: string;
  readonly onClose: () => void;
  readonly onSaved: (next: EmployeeSalary) => void;
}): React.JSX.Element {
  const [form, setForm] = useState<SalaryForm>(EMPTY_SALARY_FORM);
  const [issues, setIssues] = useState<Readonly<Record<string, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [key] = useState(newIdempotencyKey);

  const save = (): void => {
    const found = validateSalaryForm(form);
    setIssues(found);
    if (Object.keys(found).length > 0) return;
    setSaving(true);
    setError(null);
    fetchOne<EmployeeSalary>(`/employees/${employeeId}/salary`, {
      locale,
      method: 'POST',
      body: salaryBody(form),
      headers: { 'Idempotency-Key': key },
    })
      .then(onSaved)
      .catch((failure: unknown) => {
        if (failure instanceof ApiError && Object.keys(failure.fields).length > 0) {
          const keys = issueKeys(failure);
          // Salary-specific wording for the date issues the API shares with leave.
          setIssues({
            ...keys,
            ...(failure.fields.effective_from?.[0] === 'before_joining'
              ? { effective_from: 'salary.issue_before_joining' }
              : {}),
            ...(failure.fields.effective_from?.[0] === 'after_termination'
              ? { effective_from: 'salary.issue_after_termination' }
              : {}),
          });
          setError(t('validation.generic'));
          return;
        }
        setError(describeError(failure, t));
      })
      .finally(() => {
        setSaving(false);
      });
  };
  const issue = (field: string): string | undefined =>
    issues[field] === undefined ? undefined : t(issues[field]);

  return (
    <Modal
      open
      title={t('salary.change_title')}
      closeLabel={t('action.close')}
      onClose={onClose}
      footer={
        <>
          <Button loading={saving} onClick={save}>
            {t('action.save')}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t('action.cancel')}
          </Button>
        </>
      }
    >
      <div className="tasks-form__grid">
        {error === null ? null : (
          <Alert tone="danger" title={t('validation.generic_title')}>
            {error}
          </Alert>
        )}
        <Alert tone="info" title={t('salary.history_rule_title')}>
          {t('salary.history_rule')}
        </Alert>
        <Field
          label={t('salary.monthly_salary')}
          required
          {...optionalError(issue('monthly_salary'))}
        >
          <Input
            dir="ltr"
            inputMode="decimal"
            value={form.monthly_salary}
            onChange={(event) => {
              setForm({ ...form, monthly_salary: event.target.value });
            }}
          />
        </Field>
        <Field
          label={t('salary.effective_from')}
          required
          {...optionalError(issue('effective_from'))}
        >
          <Input
            type="date"
            dir="ltr"
            value={form.effective_from}
            onChange={(event) => {
              setForm({ ...form, effective_from: event.target.value });
            }}
          />
        </Field>
        <Field label={t('salary.note')}>
          <Input
            dir="auto"
            value={form.note}
            maxLength={1000}
            onChange={(event) => {
              setForm({ ...form, note: event.target.value });
            }}
          />
        </Field>
      </div>
    </Modal>
  );
}

'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';

import { ApiError, fetchMany, fetchOne } from '../../lib/api-client';
import {
  issueLabelKey,
  listedIssues,
  monthLabel,
  newIdempotencyKey,
  payrollPath,
} from '../../lib/payroll';
import type { PayrollPeriod, PayrollPeriodDetail, Preflight } from '../../lib/payroll';
import { todayIn } from '../../lib/tasks';
import {
  Alert,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Modal,
  Select,
  Toggle,
} from '../design-system';
import { loadSession } from '../employees/use-session';
import { Cell, describeError, ErrorState, LoadingState } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';
import { Amount, PeriodStatusBadge } from './payroll-shared';

/**
 * `/admin/payroll` — DOCUMENT 04 "Payroll": the periods with their state,
 * employee count, gross, deductions, bonuses and net; and "إنشاء كشف
 * الرواتب" (DOCUMENT 05 FLOW 14).
 *
 * Generation is checked before it is attempted: the pre-flight lists every
 * employee who blocks it (missing salary, schedule, or a net that would go
 * negative) with a link to fix them, and every warning (pending or missing
 * attendance) the Admin must acknowledge to proceed. The server runs the same
 * checks again in the generating transaction; this screen only says early
 * what it will say.
 */
export function PayrollPeriods({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const load = useCallback(
    async (signal: AbortSignal) => {
      const [session, periods] = await Promise.all([
        loadSession(locale, signal),
        fetchMany<PayrollPeriod>('/payroll/periods', {
          locale,
          signal,
          query: { per_page: '100' },
        }),
      ]);
      return { session, periods: periods.items };
    },
    [locale],
  );
  const resource = useResource(load);
  const [generating, setGenerating] = useState(false);

  if (resource.state.status === 'loading') return <LoadingState t={t} rows={6} />;
  if (resource.state.status === 'error') {
    return <ErrorState error={resource.state.error} t={t} onRetry={resource.reload} />;
  }
  const { session, periods } = resource.state.value;
  const canGenerate = session.permissions.has('payroll.generate');
  const headers = [
    t('payroll.col_period'),
    t('payroll.col_status'),
    t('payroll.col_employees'),
    t('payroll.col_gross'),
    t('payroll.col_deductions'),
    t('payroll.col_bonuses'),
    t('payroll.col_net'),
  ];

  return (
    <>
      {canGenerate ? (
        <div className="tasks-toolbar">
          <Button
            onClick={() => {
              setGenerating(true);
            }}
          >
            {t('payroll.generate')}
          </Button>
        </div>
      ) : null}
      {periods.length === 0 ? (
        <EmptyState
          title={t('payroll.empty_title')}
          description={t('payroll.empty')}
          action={null}
        />
      ) : (
        <Card className="tasks-table">
          <DataTable
            headers={headers}
            rows={periods.map((period) => [
              <Cell key="period" label={headers[0] as string}>
                <Link href={payrollPath(locale, period.id)}>
                  {monthLabel(period.year, period.month, locale)}
                </Link>
              </Cell>,
              <Cell key="status" label={headers[1] as string}>
                <PeriodStatusBadge status={period.status} t={t} />
              </Cell>,
              <Cell key="count" label={headers[2] as string}>
                <span dir="ltr">{period.employee_count}</span>
              </Cell>,
              <Cell key="gross" label={headers[3] as string}>
                <Amount value={period.total_gross} currency={session.currency} locale={locale} />
              </Cell>,
              <Cell key="deductions" label={headers[4] as string}>
                <Amount
                  value={period.total_deductions}
                  currency={session.currency}
                  locale={locale}
                />
              </Cell>,
              <Cell key="bonuses" label={headers[5] as string}>
                <Amount value={period.total_bonuses} currency={session.currency} locale={locale} />
              </Cell>,
              <Cell key="net" label={headers[6] as string}>
                <Amount value={period.total_net} currency={session.currency} locale={locale} />
              </Cell>,
            ])}
          />
        </Card>
      )}
      {generating ? (
        <GenerateDialog
          locale={locale}
          t={t}
          timeZone={session.timeZone}
          onClose={() => {
            setGenerating(false);
          }}
        />
      ) : null}
    </>
  );
}

function previousMonth(today: string): { year: number; month: number } {
  const [y, m] = today.split('-').map((part) => Number.parseInt(part, 10)) as [number, number];
  return m === 1 ? { year: y - 1, month: 12 } : { year: y, month: m - 1 };
}

function GenerateDialog({
  locale,
  t,
  timeZone,
  onClose,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly timeZone: string;
  readonly onClose: () => void;
}): React.JSX.Element {
  const router = useRouter();
  const initial = previousMonth(todayIn(timeZone));
  const [year, setYear] = useState(initial.year);
  const [month, setMonth] = useState(initial.month);
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [proceed, setProceed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key] = useState(newIdempotencyKey);
  const years = [initial.year - 1, initial.year, initial.year + 1];

  const check = (): void => {
    setBusy(true);
    setError(null);
    setProceed(false);
    fetchOne<Preflight>('/payroll/periods/preflight', {
      locale,
      query: { year: String(year), month: String(month) },
    })
      .then(setPreflight)
      .catch((failure: unknown) => {
        setError(describeError(failure, t));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const generate = (): void => {
    setBusy(true);
    setError(null);
    fetchOne<PayrollPeriodDetail>('/payroll/periods', {
      locale,
      method: 'POST',
      body: { year, month, ...(proceed ? { proceed_with_warnings: true } : {}) },
      headers: { 'Idempotency-Key': key },
    })
      .then((period) => {
        router.push(payrollPath(locale, period.id));
      })
      .catch((failure: unknown) => {
        if (failure instanceof ApiError && failure.code === 'PAYROLL_PERIOD_EXISTS') {
          setError(t('error.payroll_period_exists'));
        } else if (failure instanceof ApiError && Object.keys(failure.fields).length > 0) {
          setError(
            `${describeError(failure, t)} ${listedIssues(failure)
              .map((item) => t(issueLabelKey(item.issue), { detail: item.detail ?? '' }))
              .join(' · ')}`,
          );
        } else {
          setError(describeError(failure, t));
        }
        setBusy(false);
      });
  };

  const blocked =
    preflight !== null &&
    (!preflight.policy_configured ||
      !preflight.month_ended ||
      preflight.existing_period !== null ||
      preflight.blocking.length > 0);
  const needsAcknowledgement = preflight !== null && preflight.warnings.length > 0;

  return (
    <Modal
      open
      title={t('payroll.generate_title')}
      closeLabel={t('action.close')}
      onClose={onClose}
      footer={
        <>
          {preflight === null ? (
            <Button loading={busy} onClick={check}>
              {t('payroll.check')}
            </Button>
          ) : (
            <Button
              loading={busy}
              disabled={blocked || (needsAcknowledgement && !proceed)}
              onClick={generate}
            >
              {t('payroll.generate')}
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            {t('action.cancel')}
          </Button>
        </>
      }
    >
      <div className="tasks-form__grid">
        {error === null ? null : (
          <Alert tone="danger" title={t('requests.action_failed')}>
            {error}
          </Alert>
        )}
        <Field label={t('payroll.month')} required>
          <Select
            value={String(month)}
            onChange={(event) => {
              setMonth(Number.parseInt(event.target.value, 10));
              setPreflight(null);
            }}
          >
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
              <option key={m} value={m}>
                {monthLabel(year, m, locale)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('payroll.year')} required>
          <Select
            value={String(year)}
            onChange={(event) => {
              setYear(Number.parseInt(event.target.value, 10));
              setPreflight(null);
            }}
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </Select>
        </Field>
        {preflight === null ? null : (
          <PreflightReport locale={locale} t={t} preflight={preflight} />
        )}
        {needsAcknowledgement && !blocked ? (
          <Toggle
            label={t('payroll.proceed_with_warnings')}
            checked={proceed}
            onChange={(event) => {
              setProceed(event.target.checked);
            }}
          />
        ) : null}
      </div>
    </Modal>
  );
}

function PreflightReport({
  locale,
  t,
  preflight,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly preflight: Preflight;
}): React.JSX.Element {
  if (!preflight.policy_configured) {
    return (
      <Alert tone="danger" title={t('payroll.blocked_title')}>
        {t('error.salary_policy_not_configured')}{' '}
        <Link href={`/${locale}/admin/settings/salary-policy`}>{t('settings.salary_policy')}</Link>
      </Alert>
    );
  }
  if (!preflight.month_ended) {
    return (
      <Alert tone="danger" title={t('payroll.blocked_title')}>
        {t('error.payroll_period_not_ended')}
      </Alert>
    );
  }
  if (preflight.existing_period !== null) {
    return (
      <Alert tone="info" title={t('payroll.exists_title')}>
        {t('payroll.exists')}{' '}
        <Link href={payrollPath(locale, preflight.existing_period.id)}>
          {t('payroll.open_period')}
        </Link>
      </Alert>
    );
  }
  return (
    <>
      <p className="tasks-muted">
        {t('payroll.preflight_count', { count: String(preflight.employee_count) })}
      </p>
      {preflight.blocking.length > 0 ? (
        <Alert tone="danger" title={t('payroll.blocked_title')}>
          <ul>
            {preflight.blocking.map((item) => (
              <li key={`${item.employee.id}-${item.issue}`}>
                <Link href={`/${locale}/admin/employees/${item.employee.id}/salary`}>
                  <span dir="auto">{item.employee.name}</span> (
                  <span dir="ltr">{item.employee.code}</span>)
                </Link>
                {' — '}
                {t(issueLabelKey(item.issue), { detail: item.detail ?? '' })}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}
      {preflight.warnings.length > 0 ? (
        <Alert tone="warning" title={t('payroll.warnings_title')}>
          <ul>
            {preflight.warnings.map((item) => (
              <li key={item.employee.id}>
                <span dir="auto">{item.employee.name}</span>
                {' — '}
                {[
                  ...item.pending_days.map((d) => t('payroll.issue.pending', { detail: d })),
                  ...item.missing_days.map((d) => t('payroll.issue.missing', { detail: d })),
                  ...(item.zero_attendance ? [t('payroll.review.zero_attendance')] : []),
                  ...(item.unpriced_overtime_minutes > 0
                    ? [t('payroll.review.unpriced_overtime')]
                    : []),
                ].join(' · ')}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}
      {preflight.blocking.length === 0 && preflight.warnings.length === 0 ? (
        <Alert tone="success" title={t('payroll.ready_title')}>
          {t('payroll.ready')}
        </Alert>
      ) : null}
    </>
  );
}

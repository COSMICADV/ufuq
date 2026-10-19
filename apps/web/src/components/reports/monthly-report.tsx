'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';

import { ApiError, fetchOne } from '../../lib/api-client';
import { monthLabel } from '../../lib/payroll';
import {
  addMonths,
  isClosedMonth,
  isWithheld,
  monthlyActionPath,
  monthlyReportPath,
  weightPercent,
} from '../../lib/reports';
import type { MonthlyReport } from '../../lib/reports';
import { Alert, Badge, Button, Card, EmptyState, Modal } from '../design-system';
import { loadSession } from '../employees/use-session';
import type { SessionView } from '../employees/use-session';
import { ErrorState, LoadingState } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';
import { Amount } from '../warehouse/warehouse-shared';

import { formatInstant } from './report-shared';

type Loaded =
  | { readonly kind: 'report'; readonly report: MonthlyReport }
  | { readonly kind: 'missing' }
  | { readonly kind: 'not_closed' };

function companyMonth(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(new Date())
    .slice(0, 10);
}

/**
 * One employee's monthly report — DOCUMENT 04 C13 (and the Monthly Reports
 * tab of B4), DOCUMENT 18 "Employee reports", FLOW 19.
 *
 * Shows the saved snapshot exactly as generated: when, which version, whether
 * it was provisional, and — if the attendance, tasks, goals, payroll or
 * performance settings have changed since — a warning, never a silent
 * rewrite. Regenerating is explicit and confirmed, and offered only to those
 * the API allows (never an employee for themselves). Mobile first: the
 * sections stack, every figure wraps.
 */
export function MonthlyReportView({
  locale,
  employeeId,
  month,
  monthHref,
  onChange,
}: {
  readonly locale: Locale;
  readonly employeeId: string;
  readonly month: string;
  readonly monthHref: (month: string) => string;
  /** Called after a generation or regeneration, so a surrounding list can refresh. */
  readonly onChange?: () => void;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const load = useCallback(
    async (
      signal: AbortSignal,
    ): Promise<{ session: SessionView; loaded: Loaded; today: string }> => {
      const session = await loadSession(locale, signal);
      const today = companyMonth(session.timeZone);
      if (!isClosedMonth(month, today)) {
        return { session, today, loaded: { kind: 'not_closed' } };
      }
      try {
        const report = await fetchOne<MonthlyReport>(monthlyReportPath(employeeId, month), {
          locale,
          signal,
        });
        return { session, today, loaded: { kind: 'report', report } };
      } catch (error) {
        if (error instanceof ApiError && error.code === 'REPORT_NOT_GENERATED') {
          return { session, today, loaded: { kind: 'missing' } };
        }
        throw error;
      }
    },
    [locale, employeeId, month],
  );
  const resource = useResource(load);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const run = async (action: 'generate' | 'regenerate'): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      const report = await fetchOne<MonthlyReport>(monthlyActionPath(employeeId, month, action), {
        locale,
        method: 'POST',
      });
      if (resource.state.status === 'ready') {
        resource.replace({ ...resource.state.value, loaded: { kind: 'report', report } });
      }
      onChange?.();
    } catch (error) {
      setActionError(
        error instanceof ApiError && error.status === 429
          ? t('reports.state.rate_limited')
          : t('state.error_detail'),
      );
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  const [year, monthNumber] = [Number(month.slice(0, 4)), Number(month.slice(5, 7))];
  const heading = monthLabel(year, monthNumber, locale);
  const nav = (today: string | null) => (
    <nav className="monthly-nav report-no-print" aria-label={t('reports.monthly.month_select')}>
      <Link href={monthHref(addMonths(month, -1))}>{t('reports.monthly.previous')}</Link>
      <strong>{heading}</strong>
      {today !== null && isClosedMonth(addMonths(month, 1), today) ? (
        <Link href={monthHref(addMonths(month, 1))}>{t('reports.monthly.next')}</Link>
      ) : (
        <span aria-hidden="true" />
      )}
    </nav>
  );

  if (resource.state.status === 'loading') {
    return (
      <>
        {nav(null)}
        <LoadingState t={t} rows={6} />
      </>
    );
  }
  if (resource.state.status === 'error') {
    return (
      <>
        {nav(null)}
        {resource.state.error.status === 403 || resource.state.error.status === 404 ? (
          // Outside the caller's scope, or not in their company: nothing to retry.
          <Alert tone="danger" title={t('state.action_blocked')}>
            {t('error.forbidden')}
          </Alert>
        ) : (
          <ErrorState error={resource.state.error} t={t} onRetry={resource.reload} />
        )}
      </>
    );
  }
  const { session, loaded, today } = resource.state.value;
  if (loaded.kind === 'not_closed') {
    return (
      <>
        {nav(today)}
        <EmptyState
          title={heading}
          description={t('reports.monthly.not_closed_body')}
          action={null}
        />
      </>
    );
  }
  if (loaded.kind === 'missing') {
    return (
      <>
        {nav(today)}
        {actionError === null ? null : (
          <Alert tone="danger" title={t('state.error')}>
            {actionError}
          </Alert>
        )}
        <EmptyState
          title={t('reports.monthly.not_generated_title')}
          description={t('reports.monthly.not_generated_body')}
          action={
            <Button loading={busy} onClick={() => void run('generate')}>
              {t('reports.monthly.generate')}
            </Button>
          }
        />
      </>
    );
  }
  const report = loaded.report;
  return (
    <div className="monthly-report">
      {nav(today)}
      <header className="monthly-report__header">
        <div>
          <h2>
            {t('reports.monthly.title')} · {heading}
          </h2>
          <p className="tasks-muted">
            <span dir="auto">{report.employee.name}</span> ·{' '}
            <span dir="ltr">{report.employee.code}</span>
          </p>
          <p className="tasks-muted">
            {t('reports.monthly.generated_at', {
              date: formatInstant(report.generated_at, locale, session.timeZone),
            })}
            {' · '}
            {t('reports.monthly.revision', { revision: String(report.revision) })}
          </p>
        </div>
        <div className="report-actions report-no-print">
          {report.is_provisional ? (
            <Badge tone="warning">{t('reports.provisional_badge')}</Badge>
          ) : null}
          <Button
            variant="ghost"
            onClick={() => {
              window.print();
            }}
          >
            {t('reports.action.print')}
          </Button>
          {report.can_regenerate ? (
            <Button
              variant="secondary"
              loading={busy}
              onClick={() => {
                setConfirming(true);
              }}
            >
              {t('reports.monthly.regenerate')}
            </Button>
          ) : null}
        </div>
      </header>

      {report.is_provisional ? (
        <Alert tone="warning" title={t('reports.monthly.provisional_title')}>
          {t('reports.monthly.provisional_body')}
        </Alert>
      ) : null}
      {report.underlying_data_changed ? (
        <Alert tone="warning" title={t('reports.monthly.changed_title')}>
          {t('reports.monthly.changed_body')}
        </Alert>
      ) : null}
      {actionError === null ? null : (
        <Alert tone="danger" title={t('state.error')}>
          {actionError}
        </Alert>
      )}

      <div className="monthly-report__sections">
        <Section title={t('reports.monthly.section.attendance')}>
          <Figures
            t={t}
            items={[
              ['working_days', report.attendance.working_days],
              ['present', report.attendance.present],
              ['wfh', report.attendance.wfh],
              ['late', report.attendance.late],
              ['absent', report.attendance.absent],
              ['leave', report.attendance.leave],
            ]}
          />
        </Section>
        <Section title={t('reports.monthly.section.tasks')}>
          <Figures
            t={t}
            items={[
              ['assigned', report.tasks.assigned],
              ['completed', report.tasks.completed],
              ['in_progress', report.tasks.in_progress],
              ['overdue', report.tasks.overdue],
            ]}
          />
        </Section>
        <Section title={t('reports.monthly.section.goals')}>
          {report.goals.goals.length === 0 ? (
            <p className="tasks-muted">{t('reports.monthly.goals_empty')}</p>
          ) : (
            <ul className="monthly-goals">
              {report.goals.goals.map((goal) => (
                <li key={goal.id}>
                  <span dir="auto">{goal.title}</span>
                  <strong dir="ltr">{`${goal.progress_percent}%`}</strong>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title={t('reports.monthly.section.salary')}>
          <SalaryView report={report} t={t} locale={locale} currency={session.currency} />
        </Section>
        <Section title={t('reports.monthly.section.performance')}>
          <dl className="monthly-figures">
            <Figure
              label={t('reports.column.attendance_score')}
              value={score(report.performance.components.attendance.score, t)}
            />
            <Figure
              label={t('reports.column.task_score')}
              value={score(report.performance.components.task.score, t)}
            />
            <Figure
              label={t('reports.column.goal_score')}
              value={score(report.performance.components.goal.score, t)}
            />
            <Figure
              label={t('reports.column.overall')}
              value={score(report.overall_score, t)}
              strong
            />
          </dl>
          {report.performance.components.attendance.no_data_reason === null ? null : (
            <p className="tasks-muted">
              {t(
                `reports.monthly.no_data_reason.${report.performance.components.attendance.no_data_reason}`,
              )}
            </p>
          )}
          <p className="tasks-muted">
            {t('reports.monthly.weights', {
              attendance: weightPercent(report.performance.config.weights.attendance),
              task: weightPercent(report.performance.config.weights.task),
              goal: weightPercent(report.performance.config.weights.goal),
            })}
          </p>
        </Section>
      </div>

      <Modal
        open={confirming}
        title={t('reports.monthly.regenerate_confirm_title')}
        closeLabel={t('action.cancel')}
        onClose={() => {
          setConfirming(false);
        }}
        footer={
          <div className="settings-form__actions">
            <Button loading={busy} onClick={() => void run('regenerate')}>
              {t('reports.monthly.regenerate')}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setConfirming(false);
              }}
            >
              {t('action.cancel')}
            </Button>
          </div>
        }
      >
        <p>{t('reports.monthly.regenerate_confirm_body', { month: heading })}</p>
      </Modal>
    </div>
  );
}

function score(value: string | null, t: Translator): string {
  return value === null ? t('reports.value.no_data') : `${value}%`;
}

function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Card title={title} className="monthly-section">
      {children}
    </Card>
  );
}

function Figure({
  label,
  value,
  strong,
}: {
  readonly label: string;
  readonly value: React.ReactNode;
  readonly strong?: boolean;
}): React.JSX.Element {
  return (
    <div className={strong === true ? 'is-total' : ''}>
      <dt>{label}</dt>
      <dd dir="ltr">{value}</dd>
    </div>
  );
}

function Figures({
  t,
  items,
}: {
  readonly t: Translator;
  readonly items: readonly (readonly [string, number])[];
}): React.JSX.Element {
  return (
    <dl className="monthly-figures">
      {items.map(([key, value]) => (
        <Figure key={key} label={t(`reports.column.${key}`)} value={String(value)} />
      ))}
    </dl>
  );
}

function SalaryView({
  report,
  t,
  locale,
  currency,
}: {
  readonly report: MonthlyReport;
  readonly t: Translator;
  readonly locale: Locale;
  readonly currency: string;
}): React.JSX.Element {
  const salary = report.salary;
  if (isWithheld(salary)) {
    return (
      <p className="tasks-muted">
        {salary.withheld === 'no_permission'
          ? t('reports.monthly.salary_withheld_permission')
          : t('reports.monthly.salary_withheld_not_final')}
      </p>
    );
  }
  if (salary.source === 'none') {
    return <p className="tasks-muted">{t('reports.monthly.salary_none')}</p>;
  }
  const amount = (value: string | null) =>
    value === null ? (
      t('reports.value.none')
    ) : (
      <Amount value={value} currency={currency} locale={locale} />
    );
  return (
    <>
      {salary.is_provisional ? (
        <Badge tone="warning">{t('reports.provisional_badge')}</Badge>
      ) : null}
      <dl className="monthly-figures">
        <Figure label={t('reports.column.gross')} value={amount(salary.base)} />
        <Figure label={t('reports.column.deductions')} value={amount(salary.deductions)} />
        <Figure label={t('reports.column.bonuses')} value={amount(salary.bonuses)} />
        <Figure label={t('reports.column.net')} value={amount(salary.net)} />
        {salary.adjustments_total !== null && salary.adjustments_total !== '0.00' ? (
          <>
            <Figure
              label={t('reports.column.adjustments_total')}
              value={amount(salary.adjustments_total)}
            />
            <Figure
              label={t('reports.column.adjusted_net')}
              value={amount(salary.adjusted_net)}
              strong
            />
          </>
        ) : null}
      </dl>
    </>
  );
}

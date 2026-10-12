'use client';

import { useCallback, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';

import { ApiError, fetchMany, fetchOne, issueKeys } from '../../lib/api-client';
import {
  asDeduction,
  attemptedNet,
  EMPTY_ENTRY_FORM,
  entryBody,
  monthLabel,
  newIdempotencyKey,
  validateAdjustmentForm,
  validateEntryForm,
} from '../../lib/payroll';
import type {
  EntryForm,
  PayrollEntry,
  PayrollLine,
  PayrollPeriodDetail,
  Payslip,
} from '../../lib/payroll';
import { Alert, Button, Card, DataTable, EmptyState, Field, Input, Modal } from '../design-system';
import { loadSession } from '../employees/use-session';
import {
  Cell,
  describeError,
  ErrorState,
  LoadingState,
  optionalError,
  SuccessNotice,
} from '../settings/screen-states';
import { useResource } from '../settings/use-resource';
import { Amount, Figure, PeriodStatusBadge } from './payroll-shared';

/**
 * A payslip — DOCUMENT 04 "Payslip breakdown": base, working days, present,
 * WFH, absent, paid and unpaid leave, late minutes, the attendance
 * adjustment, deductions, bonuses, net, and the adjustment history.
 *
 * The same view serves the ADMIN (`/admin/payroll/:periodId/:employeeId`),
 * who may add deductions and bonuses while the period is editable and
 * adjustments once it is finalized, and the employee (`/app/salary/:periodId`),
 * who only reads their own finalized payslip. A finalized payslip is
 * read-only except for adjustments, which never change it (DOCUMENT 15 rule 2).
 */
export function PayslipView({
  locale,
  t,
  payslip,
  currency,
  onChanged,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly payslip: Payslip;
  readonly currency: string;
  readonly onChanged?: (next: Payslip, notice: string) => void;
}): React.JSX.Element {
  const b = payslip.breakdown;
  const [dialog, setDialog] = useState<'deduction' | 'bonus' | 'adjustment' | null>(null);
  const money = (value: string): React.JSX.Element => (
    <Amount value={value} currency={currency} locale={locale} />
  );

  return (
    <>
      <Card
        title={`${payslip.employee.name} · ${monthLabel(payslip.period.year, payslip.period.month, locale)}`}
        action={<PeriodStatusBadge status={payslip.period.status} t={t} />}
      >
        <div className="payroll-figures">
          <Figure label={t('payroll.col_base')}>{money(payslip.base_salary)}</Figure>
          <Figure label={t('payroll.daily_wage')}>{money(payslip.daily_wage)}</Figure>
          <Figure label={t('payroll.working_days')}>
            <span dir="ltr">{payslip.working_days}</span>
          </Figure>
          <Figure label={t('payroll.present_days')}>
            <span dir="ltr">{payslip.present_days}</span>
          </Figure>
          <Figure label={t('payroll.wfh_days')}>
            <span dir="ltr">{payslip.wfh_days}</span>
          </Figure>
          <Figure label={t('payroll.absent_days')}>
            <span dir="ltr">{payslip.absent_days}</span>
          </Figure>
          <Figure label={t('payroll.paid_leave_days')}>
            <span dir="ltr">{payslip.paid_leave_days}</span>
          </Figure>
          <Figure label={t('payroll.unpaid_leave_days')}>
            <span dir="ltr">{payslip.unpaid_leave_days}</span>
          </Figure>
          <Figure label={t('payroll.late_minutes')}>
            <span dir="ltr">{payslip.late_minutes_total}</span>
          </Figure>
        </div>
      </Card>

      <Card title={t('payroll.breakdown')}>
        <dl className="payroll-breakdown">
          {b.segments.length > 1
            ? b.segments.map((segment) => (
                <div key={segment.from}>
                  <dt>
                    {t('payroll.segment', { from: segment.from, to: segment.to })}{' '}
                    <span className="tasks-muted">
                      {money(segment.monthly_salary)} ·{' '}
                      <span dir="ltr">{segment.working_days}</span> {t('payroll.days')}
                    </span>
                  </dt>
                  <dd>{money(segment.base)}</dd>
                </div>
              ))
            : null}
          <div>
            <dt>{t('payroll.col_base')}</dt>
            <dd>{money(payslip.base_salary)}</dd>
          </div>
          <div>
            <dt>{t('payroll.absence')}</dt>
            <dd>{money(asDeduction(b.absence))}</dd>
          </div>
          <div>
            <dt>{t('payroll.unpaid_leave')}</dt>
            <dd>{money(asDeduction(b.unpaid_leave))}</dd>
          </div>
          <div>
            <dt>{t('payroll.lateness')}</dt>
            <dd>{money(asDeduction(b.lateness))}</dd>
          </div>
          <div>
            <dt>{t('payroll.overtime')}</dt>
            <dd>{money(b.overtime)}</dd>
          </div>
          <div>
            <dt>{t('payroll.col_attendance_adjustment')}</dt>
            <dd>{money(payslip.attendance_adjustment)}</dd>
          </div>
          <div>
            <dt>{t('payroll.col_deductions')}</dt>
            <dd>{money(payslip.total_deductions)}</dd>
          </div>
          <div>
            <dt>{t('payroll.col_bonuses')}</dt>
            <dd>{money(payslip.total_bonuses)}</dd>
          </div>
          <div className="payroll-breakdown__total">
            <dt>{t('payroll.col_net')}</dt>
            <dd>{money(payslip.net_salary)}</dd>
          </div>
          {payslip.adjustments.length > 0 ? (
            <div className="payroll-breakdown__total">
              <dt>{t('payroll.adjusted_net')}</dt>
              <dd>{money(payslip.adjusted_net)}</dd>
            </div>
          ) : null}
        </dl>
        {payslip.review_reasons.length > 0 ? (
          <Alert tone="warning" title={t('payroll.needs_review_title')}>
            {payslip.review_reasons.map((reason) => t(`payroll.review.${reason}`)).join(' · ')}
            {b.pending_days.length > 0 ? ` — ${b.pending_days.join(', ')}` : ''}
            {b.missing_days.length > 0 ? ` — ${b.missing_days.join(', ')}` : ''}
          </Alert>
        ) : null}
        {payslip.is_locked ? <p className="tasks-muted">{t('payroll.locked_note')}</p> : null}
      </Card>

      <EntryList
        title={t('payroll.deductions')}
        entries={payslip.deductions}
        locale={locale}
        t={t}
        currency={currency}
        action={
          payslip.can_add_entries && onChanged !== undefined ? (
            <Button
              size="sm"
              onClick={() => {
                setDialog('deduction');
              }}
            >
              {t('payroll.add_deduction')}
            </Button>
          ) : null
        }
      />
      <EntryList
        title={t('payroll.bonuses')}
        entries={payslip.bonuses}
        locale={locale}
        t={t}
        currency={currency}
        action={
          payslip.can_add_entries && onChanged !== undefined ? (
            <Button
              size="sm"
              onClick={() => {
                setDialog('bonus');
              }}
            >
              {t('payroll.add_bonus')}
            </Button>
          ) : null
        }
      />
      {payslip.is_locked ? (
        <EntryList
          title={t('payroll.adjustments')}
          entries={payslip.adjustments}
          locale={locale}
          t={t}
          currency={currency}
          action={
            payslip.can_adjust && onChanged !== undefined ? (
              <Button
                size="sm"
                onClick={() => {
                  setDialog('adjustment');
                }}
              >
                {t('payroll.add_adjustment')}
              </Button>
            ) : null
          }
        />
      ) : null}

      {dialog === null || onChanged === undefined ? null : (
        <EntryDialog
          locale={locale}
          t={t}
          kind={dialog}
          lineId={payslip.id}
          onClose={() => {
            setDialog(null);
          }}
          onSaved={(next) => {
            setDialog(null);
            onChanged(next, t(`payroll.done.${dialog}`));
          }}
        />
      )}
    </>
  );
}

function EntryList({
  title,
  entries,
  locale,
  t,
  currency,
  action,
}: {
  readonly title: string;
  readonly entries: readonly PayrollEntry[];
  readonly locale: Locale;
  readonly t: Translator;
  readonly currency: string;
  readonly action: React.ReactNode;
}): React.JSX.Element {
  const headers = [t('payroll.col_amount'), t('payroll.col_reason'), t('payroll.col_created_by')];
  return (
    <Card title={title} action={action} className="tasks-table">
      {entries.length === 0 ? (
        <p className="tasks-muted">{t('payroll.none_yet')}</p>
      ) : (
        <DataTable
          headers={headers}
          rows={entries.map((entry) => [
            <Cell key="amount" label={headers[0] as string}>
              <Amount value={entry.amount} currency={currency} locale={locale} />
            </Cell>,
            <Cell key="reason" label={headers[1] as string}>
              <span dir="auto">{entry.reason}</span>
              {entry.type !== undefined && entry.type !== 'other' ? (
                <span className="tasks-muted"> · {entry.type}</span>
              ) : null}
            </Cell>,
            <Cell key="by" label={headers[2] as string}>
              <span dir="ltr">{entry.created_by.email}</span>
            </Cell>,
          ])}
        />
      )}
    </Card>
  );
}

function EntryDialog({
  locale,
  t,
  kind,
  lineId,
  onClose,
  onSaved,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly kind: 'deduction' | 'bonus' | 'adjustment';
  readonly lineId: string;
  readonly onClose: () => void;
  readonly onSaved: (next: Payslip) => void;
}): React.JSX.Element {
  const [form, setForm] = useState<EntryForm>(EMPTY_ENTRY_FORM);
  const [issues, setIssues] = useState<Readonly<Record<string, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // One key per open dialog: a double click or a retry replays, never duplicates.
  const [key] = useState(newIdempotencyKey);
  const path = kind === 'deduction' ? 'deductions' : kind === 'bonus' ? 'bonuses' : 'adjustments';

  const save = (): void => {
    const found = kind === 'adjustment' ? validateAdjustmentForm(form) : validateEntryForm(form);
    setIssues(found);
    if (Object.keys(found).length > 0) return;
    setSaving(true);
    setError(null);
    const body = entryBody(form);
    if (kind === 'adjustment') delete body.type;
    fetchOne<Payslip>(`/payroll/lines/${lineId}/${path}`, {
      locale,
      method: 'POST',
      body,
      headers: { 'Idempotency-Key': key },
    })
      .then(onSaved)
      .catch((failure: unknown) => {
        if (failure instanceof ApiError && failure.code === 'PAYROLL_NEGATIVE_NET') {
          setError(t('payroll.negative_net', { net: attemptedNet(failure) ?? '' }));
        } else if (failure instanceof ApiError && Object.keys(failure.fields).length > 0) {
          setIssues(issueKeys(failure));
          setError(t('validation.generic'));
        } else {
          setError(describeError(failure, t));
        }
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
      title={t(`payroll.add_${kind}`)}
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
          <Alert tone="danger" title={t('requests.action_failed')}>
            {error}
          </Alert>
        )}
        {kind === 'adjustment' ? (
          <Alert tone="info" title={t('payroll.adjustment_note_title')}>
            {t('payroll.adjustment_note')}
          </Alert>
        ) : null}
        <Field
          label={t('payroll.col_amount')}
          {...(kind === 'adjustment' ? { helper: t('payroll.signed_amount_helper') } : {})}
          required
          {...optionalError(issue('amount'))}
        >
          <Input
            dir="ltr"
            inputMode="decimal"
            value={form.amount}
            onChange={(event) => {
              setForm({ ...form, amount: event.target.value });
            }}
          />
        </Field>
        <Field label={t('payroll.col_reason')} required {...optionalError(issue('reason'))}>
          <Input
            dir="auto"
            value={form.reason}
            maxLength={1000}
            onChange={(event) => {
              setForm({ ...form, reason: event.target.value });
            }}
          />
        </Field>
        {kind === 'adjustment' ? null : (
          <Field label={t('payroll.entry_type')} {...optionalError(issue('type'))}>
            <Input
              dir="auto"
              value={form.type}
              maxLength={50}
              onChange={(event) => {
                setForm({ ...form, type: event.target.value });
              }}
            />
          </Field>
        )}
      </div>
    </Modal>
  );
}

/** `/admin/payroll/:periodId/:employeeId`. */
export function AdminPayslip({
  locale,
  periodId,
  employeeId,
}: {
  readonly locale: Locale;
  readonly periodId: string;
  readonly employeeId: string;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const load = useCallback(
    async (signal: AbortSignal) => {
      const [session, period] = await Promise.all([
        loadSession(locale, signal),
        fetchOne<PayrollPeriodDetail>(`/payroll/periods/${periodId}`, { locale, signal }),
      ]);
      const line = period.lines.find((candidate) => candidate.employee.id === employeeId);
      const payslip =
        line === undefined
          ? null
          : await fetchOne<Payslip>(`/payroll/lines/${line.id}`, { locale, signal });
      return { session, payslip };
    },
    [locale, periodId, employeeId],
  );
  const resource = useResource(load);
  const [notice, setNotice] = useState<string | null>(null);

  if (resource.state.status === 'loading') return <LoadingState t={t} rows={10} />;
  if (resource.state.status === 'error') {
    return <ErrorState error={resource.state.error} t={t} onRetry={resource.reload} />;
  }
  const { session, payslip } = resource.state.value;
  if (payslip === null) {
    return (
      <EmptyState
        title={t('payroll.no_line_title')}
        description={t('payroll.no_line')}
        action={null}
      />
    );
  }
  return (
    <>
      <SuccessNotice message={notice} t={t} />
      <PayslipView
        locale={locale}
        t={t}
        payslip={payslip}
        currency={session.currency}
        onChanged={(next, message) => {
          resource.replace({ session, payslip: next });
          setNotice(message);
        }}
      />
    </>
  );
}

/** `/app/salary/:periodId` — the employee's own finalized payslip, or a 404-style empty state. */
export function MyPayslip({
  locale,
  periodId,
}: {
  readonly locale: Locale;
  readonly periodId: string;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const load = useCallback(
    async (signal: AbortSignal) => {
      const [session, history] = await Promise.all([
        loadSession(locale, signal),
        fetchMany<PayrollLine>('/payroll/me/history', {
          locale,
          signal,
          query: { per_page: '100' },
        }),
      ]);
      const line = history.items.find((candidate) => candidate.period_id === periodId);
      const payslip =
        line === undefined
          ? null
          : await fetchOne<Payslip>(`/payroll/lines/${line.id}`, { locale, signal });
      return { session, payslip };
    },
    [locale, periodId],
  );
  const resource = useResource(load);
  if (resource.state.status === 'loading') return <LoadingState t={t} rows={10} />;
  if (resource.state.status === 'error') {
    return <ErrorState error={resource.state.error} t={t} onRetry={resource.reload} />;
  }
  const { session, payslip } = resource.state.value;
  if (payslip === null) {
    return (
      <EmptyState
        title={t('salary.no_payslip_title')}
        description={t('salary.no_payslip')}
        action={null}
      />
    );
  }
  return <PayslipView locale={locale} t={t} payslip={payslip} currency={session.currency} />;
}

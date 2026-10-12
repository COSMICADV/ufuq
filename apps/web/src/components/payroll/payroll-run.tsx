'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';

import { ApiError, fetchOne } from '../../lib/api-client';
import {
  confirmationMatches,
  finalizationOffered,
  monthLabel,
  payrollPath,
} from '../../lib/payroll';
import type { PayrollPeriodDetail } from '../../lib/payroll';
import { Alert, Badge, Button, Card, DataTable, Field, Input, Modal } from '../design-system';
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
import { Amount, Figure, PeriodStatusBadge, useIsDesktop } from './payroll-shared';

type Action =
  | 'recalculate'
  | 'submit-review'
  | 'approve'
  | 'return-to-draft'
  | 'return-to-review'
  | 'mark-paid';

/**
 * `/admin/payroll/:periodId` — DOCUMENT 04 "Payroll run": the summary
 * (employees, gross, attendance adjustment, deductions, bonuses, net, state)
 * and the lines (employee, base, attendance adjustment, deductions, bonuses,
 * net, status), with the actions the state allows — read from the period's
 * own `abilities`, which the server computes from the same table it
 * enforces.
 *
 * **Finalization** (DOCUMENT 15 rule 11, "Mobile behaviour"): an irreversible
 * action, so it states that it is irreversible, requires the period typed
 * exactly, and is not offered at all below desktop width. On a phone the
 * screen says where to finalize instead.
 */
export function PayrollRun({
  locale,
  periodId,
}: {
  readonly locale: Locale;
  readonly periodId: string;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const load = useCallback(
    async (signal: AbortSignal) => {
      const [session, period] = await Promise.all([
        loadSession(locale, signal),
        fetchOne<PayrollPeriodDetail>(`/payroll/periods/${periodId}`, { locale, signal }),
      ]);
      return { session, period };
    },
    [locale, periodId],
  );
  const resource = useResource(load);
  const desktop = useIsDesktop();
  const [busy, setBusy] = useState<Action | 'finalize' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [finalizing, setFinalizing] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [proceed, setProceed] = useState(false);

  if (resource.state.status === 'loading') return <LoadingState t={t} rows={8} />;
  if (resource.state.status === 'error') {
    return <ErrorState error={resource.state.error} t={t} onRetry={resource.reload} />;
  }
  const { session, period } = resource.state.value;
  const a = period.abilities;
  const currency = session.currency;

  const run = (action: Action): void => {
    setBusy(action);
    setError(null);
    fetchOne<PayrollPeriodDetail>(`/payroll/periods/${periodId}/${action}`, {
      locale,
      method: 'POST',
      body: action === 'recalculate' && proceed ? { proceed_with_warnings: true } : {},
    })
      .then((next) => {
        resource.replace({ session, period: next });
        setNotice(t(`payroll.done.${action}`));
        setProceed(false);
      })
      .catch((failure: unknown) => {
        if (failure instanceof ApiError && failure.code === 'PAYROLL_ATTENDANCE_INCOMPLETE') {
          setError(
            `${t('error.payroll_attendance_incomplete')} ${t('payroll.recalculate_proceed_hint')}`,
          );
          setProceed(true);
          return;
        }
        setError(describeError(failure, t));
      })
      .finally(() => {
        setBusy(null);
      });
  };

  const finalize = (): void => {
    if (!confirmationMatches(confirm, period.label)) return;
    setBusy('finalize');
    setError(null);
    fetchOne<PayrollPeriodDetail>(`/payroll/periods/${periodId}/finalize`, {
      locale,
      method: 'POST',
      body: { confirm: confirm.trim() },
    })
      .then((next) => {
        resource.replace({ session, period: next });
        setFinalizing(false);
        setConfirm('');
        setNotice(t('payroll.done.finalize'));
      })
      .catch((failure: unknown) => {
        setError(describeError(failure, t));
      })
      .finally(() => {
        setBusy(null);
      });
  };

  const headers = [
    t('payroll.col_employee'),
    t('payroll.col_base'),
    t('payroll.col_attendance_adjustment'),
    t('payroll.col_deductions'),
    t('payroll.col_bonuses'),
    t('payroll.col_net'),
    t('payroll.col_status'),
  ];

  return (
    <>
      <SuccessNotice message={notice} t={t} />
      {error === null ? null : (
        <Alert tone="danger" title={t('requests.action_failed')}>
          {error}
        </Alert>
      )}
      <Card
        title={monthLabel(period.year, period.month, locale)}
        action={<PeriodStatusBadge status={period.status} t={t} />}
      >
        <div className="payroll-figures">
          <Figure label={t('payroll.col_employees')}>
            <span dir="ltr">{period.employee_count}</span>
          </Figure>
          <Figure label={t('payroll.col_gross')}>
            <Amount value={period.total_gross} currency={currency} locale={locale} />
          </Figure>
          <Figure label={t('payroll.col_attendance_adjustment')}>
            <Amount
              value={period.total_attendance_adjustment}
              currency={currency}
              locale={locale}
            />
          </Figure>
          <Figure label={t('payroll.col_deductions')}>
            <Amount value={period.total_deductions} currency={currency} locale={locale} />
          </Figure>
          <Figure label={t('payroll.col_bonuses')}>
            <Amount value={period.total_bonuses} currency={currency} locale={locale} />
          </Figure>
          <Figure label={t('payroll.col_net')}>
            <Amount value={period.total_net} currency={currency} locale={locale} />
          </Figure>
        </div>
        {period.is_locked ? <p className="tasks-muted">{t('payroll.locked_note')}</p> : null}
        <div className="tasks-toolbar">
          {a.can_recalculate ? (
            <Button
              variant="secondary"
              loading={busy === 'recalculate'}
              onClick={() => {
                run('recalculate');
              }}
            >
              {proceed ? t('payroll.recalculate_anyway') : t('payroll.recalculate')}
            </Button>
          ) : null}
          {a.can_submit_review ? (
            <Button
              loading={busy === 'submit-review'}
              onClick={() => {
                run('submit-review');
              }}
            >
              {t('payroll.submit_review')}
            </Button>
          ) : null}
          {a.can_return_to_draft ? (
            <Button
              variant="secondary"
              loading={busy === 'return-to-draft'}
              onClick={() => {
                run('return-to-draft');
              }}
            >
              {t('payroll.return_to_draft')}
            </Button>
          ) : null}
          {a.can_approve ? (
            <Button
              loading={busy === 'approve'}
              onClick={() => {
                run('approve');
              }}
            >
              {t('payroll.approve')}
            </Button>
          ) : null}
          {a.can_return_to_review ? (
            <Button
              variant="secondary"
              loading={busy === 'return-to-review'}
              onClick={() => {
                run('return-to-review');
              }}
            >
              {t('payroll.return_to_review')}
            </Button>
          ) : null}
          {finalizationOffered(a, desktop) ? (
            <Button
              variant="destructive"
              onClick={() => {
                setFinalizing(true);
                setConfirm('');
              }}
            >
              {t('payroll.finalize')}
            </Button>
          ) : null}
          {a.can_mark_paid ? (
            <Button
              loading={busy === 'mark-paid'}
              onClick={() => {
                run('mark-paid');
              }}
            >
              {t('payroll.mark_paid')}
            </Button>
          ) : null}
        </div>
        {a.can_finalize && desktop === false ? (
          <Alert tone="info" title={t('payroll.finalize_desktop_title')}>
            {t('payroll.finalize_desktop')}
          </Alert>
        ) : null}
      </Card>

      <Card className="tasks-table payroll-lines">
        <DataTable
          headers={headers}
          rows={period.lines.map((line) => [
            <Cell key="employee" label={headers[0] as string}>
              <Link href={payrollPath(locale, period.id, line.employee.id)}>
                <span dir="auto">{line.employee.name}</span>
              </Link>{' '}
              <span className="tasks-muted" dir="ltr">
                {line.employee.code}
              </span>
            </Cell>,
            <Cell key="base" label={headers[1] as string}>
              <Amount value={line.base_salary} currency={currency} locale={locale} />
            </Cell>,
            <Cell key="adjustment" label={headers[2] as string}>
              <Amount value={line.attendance_adjustment} currency={currency} locale={locale} />
            </Cell>,
            <Cell key="deductions" label={headers[3] as string}>
              <Amount value={line.total_deductions} currency={currency} locale={locale} />
            </Cell>,
            <Cell key="bonuses" label={headers[4] as string}>
              <Amount value={line.total_bonuses} currency={currency} locale={locale} />
            </Cell>,
            <Cell key="net" label={headers[5] as string}>
              <Amount value={line.net_salary} currency={currency} locale={locale} />
              {line.adjustments_total !== '0.00' ? (
                <>
                  {' → '}
                  <Amount value={line.adjusted_net} currency={currency} locale={locale} />
                </>
              ) : null}
            </Cell>,
            <Cell key="status" label={headers[6] as string}>
              <LineStatus t={t} line={line} />
            </Cell>,
          ])}
        />
      </Card>

      <Modal
        open={finalizing && finalizationOffered(a, desktop)}
        title={t('payroll.finalize_title', { period: period.label })}
        closeLabel={t('action.close')}
        onClose={() => {
          setFinalizing(false);
        }}
        footer={
          <>
            <Button
              variant="destructive"
              loading={busy === 'finalize'}
              disabled={!confirmationMatches(confirm, period.label)}
              onClick={finalize}
            >
              {t('payroll.finalize_confirm')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setFinalizing(false);
              }}
            >
              {t('action.cancel')}
            </Button>
          </>
        }
      >
        <div className="tasks-form__grid">
          <Alert tone="danger" title={t('payroll.finalize_irreversible_title')}>
            {t('payroll.finalize_irreversible')}
          </Alert>
          <Field
            label={t('payroll.finalize_type', { period: period.label })}
            required
            {...optionalError(
              confirm !== '' && !confirmationMatches(confirm, period.label)
                ? t('payroll.finalize_mismatch')
                : undefined,
            )}
          >
            <Input
              dir="ltr"
              autoComplete="off"
              placeholder={period.label}
              value={confirm}
              onChange={(event) => {
                setConfirm(event.target.value);
              }}
            />
          </Field>
        </div>
      </Modal>
    </>
  );
}

function LineStatus({
  t,
  line,
}: {
  readonly t: Translator;
  readonly line: PayrollPeriodDetail['lines'][number];
}): React.JSX.Element {
  if (line.is_locked) return <Badge tone="success">{t('payroll.line_locked')}</Badge>;
  if (line.status === 'needs_review') {
    return (
      <Badge tone="warning">
        {line.review_reasons.map((reason) => t(`payroll.review.${reason}`)).join(' · ')}
      </Badge>
    );
  }
  return <Badge tone="info">{t('payroll.line_calculated')}</Badge>;
}

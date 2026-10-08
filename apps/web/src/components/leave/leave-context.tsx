'use client';

import { useState } from 'react';
import type { Locale, Translator } from '@ufuq/i18n';

import { fetchOne } from '../../lib/api-client';
import { downloadUrl } from '../../lib/attachments';
import { formatDays, isNegative, typeName } from '../../lib/leave';
import type { LeaveRequest } from '../../lib/leave';
import { formatDate, Detail } from '../attendance/attendance-shared';
import { Alert, Button, Card, DataTable, Field, Modal, Textarea } from '../design-system';
import { Cell, describeError, Ltr, optionalError } from '../settings/screen-states';

/**
 * A leave request inside the unified request detail — DOCUMENT 04 B13
 * ("employee context: leave balance for leave requests"), C10.
 *
 * Type, dates, the server-counted days (split by year when the leave crosses
 * one), the reason, the attachment (through the authorization-checked
 * download), and the balance of that type for the years it touches. Decisions
 * are the request's own approve / reject (delegated to leave by the API).
 *
 * Two leave-only things an ADMIN sees:
 *
 *   - **A holiday declared inside approved leave** (DOCUMENT 16): the days are
 *     listed and nothing is recalculated; the balance is corrected explicitly
 *     with a reason (Settings → the employee's balance adjustment).
 *   - **Cancelling approved leave** (DOCUMENT 16 rule 15): with a reason; the
 *     used days return to the balance and the leave's attendance days are
 *     reversed.
 */
export function LeaveContext({
  leave,
  locale,
  t,
  timeZone,
  onCancelled,
}: {
  readonly leave: LeaveRequest;
  readonly locale: Locale;
  readonly t: Translator;
  readonly timeZone: string;
  readonly onCancelled: () => void;
}): React.JSX.Element {
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const years = Object.entries(leave.year_allocation);

  const cancel = (): void => {
    if (reason.trim() === '') {
      setMissing(true);
      return;
    }
    setBusy(true);
    setFailure(null);
    fetchOne<LeaveRequest>(`/leave-requests/${leave.id}/cancel`, {
      locale,
      method: 'POST',
      body: { reason: reason.trim() },
    })
      .then(() => {
        setCancelling(false);
        onCancelled();
      })
      .catch((error: unknown) => {
        setFailure(describeError(error, t));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const headers = [
    t('leave.col_year'),
    t('leave.col_total'),
    t('leave.col_used'),
    t('leave.col_pending'),
    t('leave.col_remaining'),
  ];

  return (
    <Card title={t('leave.context_title')} className="requests-decision">
      <dl className="attendance-details">
        <Detail label={t('leave.field_type')}>{typeName(leave.leave_type, locale)}</Detail>
        <Detail label={t('leave.dates')}>
          <Ltr>{`${formatDate(leave.start_date, locale, timeZone)} – ${formatDate(leave.end_date, locale, timeZone)}`}</Ltr>
        </Detail>
        <Detail label={t('leave.days')}>
          <span dir="ltr">{formatDays(leave.days_count)}</span>
          {years.length > 1 ? (
            <span className="tasks-muted">
              {' '}
              (
              {years
                .map(([year, days]) => t('leave.year_part', { year, days: formatDays(days) }))
                .join(' · ')}
              )
            </span>
          ) : null}
        </Detail>
        <Detail label={t('leave.reason')}>
          <span dir="auto" className="requests-detail__description">
            {leave.reason}
          </span>
        </Detail>
        {leave.attachment === null ? null : (
          <Detail label={t('leave.attachment')}>
            <a href={downloadUrl(leave.attachment.id)} dir="auto">
              {leave.attachment.original_name}
            </a>
          </Detail>
        )}
        {leave.leave_type.is_paid ? null : (
          <Detail label={t('leave.paid')}>{t('leave.unpaid')}</Detail>
        )}
      </dl>

      {leave.holidays_inside.length === 0 ? null : (
        <Alert tone="warning" title={t('leave.holiday_inside_title')}>
          {t('leave.holiday_inside_note', {
            dates: leave.holidays_inside
              .map((date) => formatDate(date, locale, timeZone))
              .join('، '),
          })}
        </Alert>
      )}

      {leave.balances.length === 0 ? null : (
        <DataTable
          headers={headers}
          rows={leave.balances.map((balance) => [
            <Cell key="year" label={headers[0] as string}>
              <span dir="ltr">{balance.year}</span>
            </Cell>,
            <Cell key="total" label={headers[1] as string}>
              <span dir="ltr">{formatDays(balance.total_days)}</span>
            </Cell>,
            <Cell key="used" label={headers[2] as string}>
              <span dir="ltr">{formatDays(balance.used_days)}</span>
            </Cell>,
            <Cell key="pending" label={headers[3] as string}>
              <span dir="ltr">{formatDays(balance.pending_days)}</span>
            </Cell>,
            <Cell key="remaining" label={headers[4] as string}>
              <strong
                dir="ltr"
                className={
                  isNegative(balance.remaining_days) ? 'leave-balances__negative' : undefined
                }
              >
                {formatDays(balance.remaining_days)}
              </strong>
            </Cell>,
          ])}
        />
      )}

      {leave.abilities.can_cancel_approved ? (
        <div className="tasks-form__actions">
          <Button
            variant="destructive-ghost"
            onClick={() => {
              setCancelling(true);
              setReason('');
              setMissing(false);
              setFailure(null);
            }}
          >
            {t('leave.cancel_approved')}
          </Button>
        </div>
      ) : null}

      <Modal
        open={cancelling}
        title={t('leave.cancel_approved_title')}
        closeLabel={t('action.close')}
        onClose={() => {
          setCancelling(false);
        }}
        footer={
          <>
            <Button variant="destructive" loading={busy} onClick={cancel}>
              {t('leave.cancel_approved')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setCancelling(false);
              }}
            >
              {t('action.cancel')}
            </Button>
          </>
        }
      >
        <div className="tasks-form__grid">
          {failure === null ? null : (
            <Alert tone="danger" title={t('requests.action_failed')}>
              {failure}
            </Alert>
          )}
          <p>{t('leave.cancel_approved_body')}</p>
          <Field
            label={t('leave.cancel_reason')}
            required
            {...optionalError(missing ? t('requests.reason_required') : undefined)}
          >
            <Textarea
              value={reason}
              rows={3}
              maxLength={1000}
              onChange={(event) => {
                setReason(event.target.value);
                if (missing) setMissing(false);
              }}
            />
          </Field>
        </div>
      </Modal>
    </Card>
  );
}

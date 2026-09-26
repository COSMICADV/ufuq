'use client';

import { useCallback, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { fetchMany, fetchOne } from '../../lib/api-client';
import { CORRECTION_STATUS_VALUES } from '../../lib/attendance';
import type { CorrectionRequest } from '../../lib/attendance';
import { Alert, Button, Card, EmptyState, Field, Input, Modal, Select } from '../design-system';
import {
  describeError,
  ErrorState,
  LoadingState,
  optionalError,
  SuccessNotice,
} from '../settings/screen-states';
import { useResource } from '../settings/use-resource';

import {
  Detail,
  Duration,
  employeeName,
  formatDate,
  formatTime,
  ModeChip,
  StatusChip,
} from './attendance-shared';
import { loadSession } from '../employees/use-session';

/**
 * `/{locale}/admin/attendance/corrections` — DOCUMENT 04 B7.
 *
 * The list, and a detail that shows **current recorded values against the
 * requested ones side by side** — which is the whole point of the screen: a
 * reviewer who cannot see what would change cannot make a decision.
 *
 * Rejection takes a mandatory reason (DOCUMENT 12 validation). The dialog will
 * not submit without one, and the API refuses it again.
 *
 * "Request more info" (DOCUMENT 04 B7) is **not** built: DOCUMENT 08 §4.5
 * defines approve, reject and cancel only, and there is no state for it in
 * `correction_status` (DOCUMENT 06 §3.11). Recorded in docs/PHASE-6-STATUS.md.
 */

export function CorrectionsList({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const [status, setStatus] = useState('pending');
  const [version, setVersion] = useState(0);
  const [open, setOpen] = useState<CorrectionRequest | null>(null);
  const [rejecting, setRejecting] = useState<CorrectionRequest | null>(null);
  const [note, setNote] = useState('');
  const [noteIssue, setNoteIssue] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(
    async (signal: AbortSignal) => {
      const session = await loadSession(locale, signal);
      const query = status === '' ? '' : `status=${status}&`;
      const items = await fetchMany<CorrectionRequest>(
        `/attendance-corrections?${query}per_page=50`,
        { locale, signal },
      );
      void version;
      return { session, items: items.items };
    },
    [locale, status, version],
  );

  const resource = useResource(load);

  const decide = (request: CorrectionRequest, action: 'approve' | 'reject'): void => {
    if (action === 'reject' && note.trim() === '') {
      setNoteIssue(t('validation.required'));
      return;
    }
    setBusy(true);
    setActionError(null);
    fetchOne<CorrectionRequest>(`/attendance-corrections/${request.id}/${action}`, {
      locale,
      method: 'POST',
      body:
        action === 'reject'
          ? { review_note: note.trim() }
          : note.trim() === ''
            ? {}
            : { review_note: note.trim() },
    })
      .then(() => {
        setNotice(
          action === 'approve' ? t('attendance.approved_notice') : t('attendance.rejected_notice'),
        );
        setOpen(null);
        setRejecting(null);
        setNote('');
        setNoteIssue(undefined);
        setVersion((v) => v + 1);
      })
      .catch((error: unknown) => {
        setActionError(describeError(error, t));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const zone = resource.state.status === 'ready' ? resource.state.value.session.timeZone : 'UTC';

  return (
    <Card className="attendance-corrections">
      {notice === null ? null : <SuccessNotice message={notice} t={t} />}
      {actionError === null ? null : (
        <Alert tone="danger" title={t('state.action_blocked')}>
          {actionError}
        </Alert>
      )}

      <div className="attendance-board__filters">
        <label>
          <span>{t('attendance.status.present')}</span>
          <Select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
            }}
          >
            <option value="">{t('attendance.all_statuses')}</option>
            {CORRECTION_STATUS_VALUES.map((value) => (
              <option key={value} value={value}>
                {t(`attendance.correction_status.${value}`)}
              </option>
            ))}
          </Select>
        </label>
      </div>

      {resource.state.status === 'loading' ? <LoadingState t={t} rows={6} /> : null}
      {resource.state.status === 'error' ? (
        <ErrorState error={resource.state.error} t={t} onRetry={resource.reload} />
      ) : null}

      {resource.state.status === 'ready' ? (
        resource.state.value.items.length === 0 ? (
          <EmptyState
            title={t('attendance.correction_empty_title')}
            description={t('attendance.correction_empty_description')}
            action={null}
          />
        ) : (
          <div className="table-scroll attendance-table">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('attendance.requested_by')}</th>
                  <th scope="col">{t('attendance.date')}</th>
                  <th scope="col">{t('attendance.correction_reason')}</th>
                  <th scope="col">{t('attendance.status.present')}</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {resource.state.value.items.map((request) => (
                  <tr key={request.id}>
                    <td data-label={t('attendance.requested_by')}>
                      {employeeName(request.employee)}
                    </td>
                    <td data-label={t('attendance.date')}>
                      {formatDate(request.date, locale, zone)}
                    </td>
                    <td data-label={t('attendance.correction_reason')}>{request.reason}</td>
                    <td data-label={t('attendance.status.present')}>
                      <span className={`attendance-chip attendance-chip--${request.status}`}>
                        {t(`attendance.correction_status.${request.status}`)}
                      </span>
                    </td>
                    <td>
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setOpen(request);
                        }}
                      >
                        {t('attendance.open_record')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}

      {open === null ? null : (
        <Modal
          open
          title={t('attendance.corrections_title')}
          closeLabel={t('action.close')}
          onClose={() => {
            setOpen(null);
          }}
          footer={
            open.status !== 'pending' ? null : (
              <>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setRejecting(open);
                  }}
                >
                  {t('attendance.reject')}
                </Button>
                <Button
                  loading={busy}
                  onClick={() => {
                    decide(open, 'approve');
                  }}
                >
                  {t('attendance.approve')}
                </Button>
              </>
            )
          }
        >
          <div className="attendance-compare">
            <section>
              <h3>{t('attendance.correction_current')}</h3>
              {open.current === null ? (
                <p>{t('attendance.correction_nothing_recorded')}</p>
              ) : (
                <dl className="attendance-details">
                  <Detail label={t('attendance.status.present')}>
                    <StatusChip status={open.current.status} t={t} />
                  </Detail>
                  <Detail label={t('attendance.work_mode')}>
                    <ModeChip mode={open.current.work_mode} t={t} />
                  </Detail>
                  <Detail label={t('attendance.check_in_time')}>
                    <span dir="ltr">
                      {formatTime(open.current.check_in_at, locale, zone) ?? '—'}
                    </span>
                  </Detail>
                  <Detail label={t('attendance.check_out_time')}>
                    <span dir="ltr">
                      {formatTime(open.current.check_out_at, locale, zone) ?? '—'}
                    </span>
                  </Detail>
                  <Detail label={t('attendance.working_hours')}>
                    <Duration minutes={open.current.working_minutes} />
                  </Detail>
                </dl>
              )}
            </section>
            <section>
              <h3>{t('attendance.correction_requested')}</h3>
              <dl className="attendance-details">
                <Detail label={t('attendance.check_in_time')}>
                  <span dir="ltr">{formatTime(open.requested_check_in, locale, zone) ?? '—'}</span>
                </Detail>
                <Detail label={t('attendance.check_out_time')}>
                  <span dir="ltr">{formatTime(open.requested_check_out, locale, zone) ?? '—'}</span>
                </Detail>
                <Detail label={t('attendance.work_mode')}>
                  <ModeChip mode={open.requested_work_mode} t={t} />
                </Detail>
                <Detail label={t('attendance.correction_reason')}>{open.reason}</Detail>
                {open.review_note === null ? null : (
                  <Detail label={t('attendance.review_note')}>{open.review_note}</Detail>
                )}
              </dl>
            </section>
          </div>
        </Modal>
      )}

      {rejecting === null ? null : (
        <Modal
          open
          title={t('attendance.reject')}
          closeLabel={t('action.close')}
          onClose={() => {
            setRejecting(null);
            setNoteIssue(undefined);
          }}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setRejecting(null);
                  setNoteIssue(undefined);
                }}
              >
                {t('action.cancel')}
              </Button>
              <Button
                loading={busy}
                onClick={() => {
                  decide(rejecting, 'reject');
                }}
              >
                {t('attendance.reject')}
              </Button>
            </>
          }
        >
          <Field
            label={t('attendance.reject_note')}
            required
            helper={t('attendance.reject_note_helper')}
            {...optionalError(noteIssue)}
          >
            <Input
              value={note}
              maxLength={1000}
              required
              onChange={(event) => {
                setNote(event.target.value);
                setNoteIssue(undefined);
              }}
            />
          </Field>
        </Modal>
      )}
    </Card>
  );
}

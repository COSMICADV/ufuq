'use client';

import { useCallback, useEffect, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { ApiError, fetchOne } from '../../lib/api-client';
import { formatDuration } from '../../lib/attendance';
import type { AttendanceRecord, TodayState, WorkMode } from '../../lib/attendance';
import { Alert, Button, Card, Modal } from '../design-system';
import { describeError, LoadingState, SuccessNotice } from '../settings/screen-states';

import { formatTime, ModeChip, StatusChip } from './attendance-shared';

/**
 * The attendance card — DOCUMENT 04 C1 component 2 and C2, DOCUMENT 12
 * "MOBILE BEHAVIOUR".
 *
 * The most-used screen in the product, so the rules it follows are strict:
 *
 *   - **Never render an action whose result is unknown** (DOCUMENT 04 C1,
 *     DOCUMENT 12 "load failure"). The buttons come from the server's
 *     `can_check_in` / `can_check_out`, and while the state is loading or has
 *     failed there are no buttons at all — not disabled-looking ones that
 *     might still be clicked.
 *   - **Two large buttons before check-in** (`OFFICE` / `WFH`), because
 *     DOCUMENT 12 rule 2 gives work mode no default. There is no third button
 *     that checks in without choosing.
 *   - **A rest day asks before recording** (DOCUMENT 12 "ERROR STATES"). The
 *     first attempt returns `NON_WORKING_DAY`; the dialog is that refusal
 *     made visible, and confirming retries with the flag.
 *   - **A live duration after check-in**, updated on a one-minute timer so a
 *     card left open does not freeze at the minute it was opened.
 */

export function AttendanceCard({
  locale,
  timeZone,
  onChange,
}: {
  readonly locale: Locale;
  readonly timeZone: string;
  /** Lets the surrounding screen refresh its list when the day changes. */
  readonly onChange?: () => void;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'error'; error: unknown }
    | { status: 'ready'; today: TodayState }
  >({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<WorkMode | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback((): void => {
    setState({ status: 'loading' });
    fetchOne<TodayState>('/attendance/today', { locale })
      .then((today) => {
        setState({ status: 'ready', today });
      })
      .catch((error: unknown) => {
        setState({ status: 'error', error });
      });
  }, [locale]);

  useEffect(() => {
    load();
  }, [load]);

  // The running duration DOCUMENT 04 C1 asks for. One minute is the smallest
  // interval the card actually shows, so a shorter tick would be wasted work.
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 60_000);
    return () => {
      clearInterval(timer);
    };
  }, []);

  const finish = (record: AttendanceRecord, message: string): void => {
    setNotice(message);
    setActionError(null);
    setConfirming(null);
    onChange?.();
    // Re-read rather than patching the card from the write's response: the
    // server decides what is possible next, and this keeps one answer to that.
    load();
    void record;
  };

  const checkIn = (mode: WorkMode, confirmed: boolean): void => {
    setBusy(true);
    setActionError(null);
    fetchOne<AttendanceRecord>('/attendance/check-in', {
      locale,
      method: 'POST',
      body: confirmed ? { work_mode: mode, confirm_non_working_day: true } : { work_mode: mode },
    })
      .then((record) => {
        finish(
          record,
          t('attendance.checked_in_at', {
            time: formatTime(record.check_in_at, locale, timeZone) ?? '',
          }),
        );
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.code === 'NON_WORKING_DAY') {
          setConfirming(mode);
          return;
        }
        // An already-checked-in refusal is answered by reloading: the card
        // then shows the real record and its time, which is what DOCUMENT 12's
        // message quotes.
        if (error instanceof ApiError && error.code === 'ALREADY_CHECKED_IN') {
          setActionError(describeError(error, t));
          load();
          return;
        }
        setActionError(describeError(error, t));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const checkOut = (): void => {
    setBusy(true);
    setActionError(null);
    fetchOne<AttendanceRecord>('/attendance/check-out', { locale, method: 'POST' })
      .then((record) => {
        finish(
          record,
          t('attendance.checked_out_at', {
            time: formatTime(record.check_out_at, locale, timeZone) ?? '',
          }),
        );
      })
      .catch((error: unknown) => {
        setActionError(describeError(error, t));
        if (error instanceof ApiError && error.code !== 'NOT_CHECKED_IN') {
          load();
        }
      })
      .finally(() => {
        setBusy(false);
      });
  };

  if (state.status === 'loading') {
    return (
      <Card className="attendance-card">
        <LoadingState t={t} rows={3} />
      </Card>
    );
  }

  if (state.status === 'error') {
    // DOCUMENT 04 C1 / DOCUMENT 12: an explicit error and *no* action buttons.
    return (
      <Card className="attendance-card">
        <Alert tone="danger" title={t('attendance.card_error_title')}>
          {t('attendance.card_error_body')}
        </Alert>
        <Button variant="secondary" onClick={load}>
          {t('action.retry')}
        </Button>
      </Card>
    );
  }

  const today = state.today;
  const record = today.record;
  const elapsed =
    record !== null && record.check_in_at !== null && record.check_out_at === null
      ? formatDuration(Math.max(0, Math.floor((now - Date.parse(record.check_in_at)) / 60_000)))
      : null;

  return (
    <Card className="attendance-card">
      <header className="attendance-card__header">
        <div>
          <h2>{t('attendance.my_title')}</h2>
          {today.scheduled_start_at === null || today.scheduled_end_at === null ? (
            <p>
              {today.is_holiday ? t('attendance.today_holiday') : t('attendance.today_rest_day')}
            </p>
          ) : (
            <p>
              {t('attendance.scheduled', {
                start: formatTime(today.scheduled_start_at, locale, timeZone) ?? '',
                end: formatTime(today.scheduled_end_at, locale, timeZone) ?? '',
              })}
            </p>
          )}
        </div>
        {record === null ? null : <StatusChip status={record.status} t={t} />}
      </header>

      {notice === null ? null : <SuccessNotice message={notice} t={t} />}
      {actionError === null ? null : (
        <Alert tone="danger" title={t('state.action_blocked')}>
          {actionError}
        </Alert>
      )}

      {record === null || record.check_in_at === null ? null : (
        <dl className="attendance-card__times">
          <div>
            <dt>{t('attendance.check_in_time')}</dt>
            <dd>
              <span dir="ltr">{formatTime(record.check_in_at, locale, timeZone)}</span>{' '}
              <ModeChip mode={record.work_mode} t={t} />
            </dd>
          </div>
          {record.check_out_at === null ? null : (
            <div>
              <dt>{t('attendance.check_out_time')}</dt>
              <dd dir="ltr">{formatTime(record.check_out_at, locale, timeZone)}</dd>
            </div>
          )}
          {elapsed === null ? null : (
            <div>
              <dt>{t('attendance.elapsed', { duration: '' }).trim()}</dt>
              <dd dir="ltr">{elapsed}</dd>
            </div>
          )}
        </dl>
      )}

      {today.can_check_in ? (
        <div className="attendance-card__modes">
          <Button
            size="lg"
            loading={busy}
            onClick={() => {
              checkIn('office', false);
            }}
          >
            {t('attendance.check_in_office')}
          </Button>
          <Button
            size="lg"
            variant="secondary"
            loading={busy}
            onClick={() => {
              checkIn('wfh', false);
            }}
          >
            {t('attendance.check_in_wfh')}
          </Button>
        </div>
      ) : null}

      {today.can_check_out ? (
        <Button size="lg" loading={busy} onClick={checkOut} className="attendance-card__out">
          {t('attendance.check_out')}
        </Button>
      ) : null}

      {confirming === null ? null : (
        <Modal
          open
          title={t('attendance.confirm_non_working_title')}
          onClose={() => {
            setConfirming(null);
          }}
          closeLabel={t('action.close')}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setConfirming(null);
                }}
              >
                {t('action.cancel')}
              </Button>
              <Button
                loading={busy}
                onClick={() => {
                  checkIn(confirming, true);
                }}
              >
                {t('attendance.confirm_non_working_action')}
              </Button>
            </>
          }
        >
          {t('attendance.confirm_non_working_body')}
        </Modal>
      )}
    </Card>
  );
}

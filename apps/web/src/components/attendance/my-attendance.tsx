'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { fetchMany, fetchOne } from '../../lib/api-client';
import {
  ATTENDANCE_STATUSES,
  monthOf,
  shiftMonth,
  summarise,
  withinCorrectionWindow,
} from '../../lib/attendance';
import type { AttendanceRecord } from '../../lib/attendance';
import { Button, Card, EmptyState } from '../design-system';
import { ErrorState, LoadingState } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';

import { AttendanceCard } from './attendance-card';
import { Duration, formatDate, formatTime, ModeChip, StatusChip } from './attendance-shared';
import { loadSession } from '../employees/use-session';
import type { SessionView } from '../employees/use-session';

/**
 * `/{locale}/app/attendance` — DOCUMENT 04 C2.
 *
 * Today's panel (the same card as the dashboard, not a second copy of it —
 * DOCUMENT 27 RULE 20), this month's summary chips, and the record list.
 *
 * The month's records are read through `GET /attendance`, which the employee's
 * `self` scope already narrows to their own days (DOCUMENT 09 §4): the screen
 * sends no employee id and could not widen the result if it did.
 */

interface MonthView {
  readonly session: SessionView;
  readonly records: readonly AttendanceRecord[];
  readonly today: string;
}

function monthBounds(month: string): { from: string; to: string } {
  const [year, index] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(year, index, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

export function MyAttendance({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const [month, setMonth] = useState<string>(() => monthOf(new Date().toISOString().slice(0, 10)));
  const [version, setVersion] = useState(0);

  const load = useCallback(
    async (signal: AbortSignal): Promise<MonthView> => {
      const session = await loadSession(locale, signal);
      const bounds = monthBounds(month);
      const records = await fetchMany<AttendanceRecord>(
        `/attendance?from=${bounds.from}&to=${bounds.to}&per_page=100`,
        { locale, signal },
      );
      // "Today" is the company's today, read from the same endpoint the card
      // uses, so the two never disagree about which day it is.
      const today = await fetchOne<{ date: string }>('/attendance/today', { locale, signal });
      void version;
      return { session, records: records.items, today: today.date };
    },
    [locale, month, version],
  );

  const resource = useResource(load);

  return (
    <>
      <AttendanceCard
        locale={locale}
        timeZone={resource.state.status === 'ready' ? resource.state.value.session.timeZone : 'UTC'}
        onChange={() => {
          setVersion((v) => v + 1);
        }}
      />

      <Card className="attendance-month">
        <header className="attendance-month__header">
          <h2>{t('attendance.history_title')}</h2>
          <div className="attendance-month__stepper">
            <Button
              variant="secondary"
              onClick={() => {
                setMonth((m) => shiftMonth(m, -1));
              }}
            >
              {t('attendance.previous_month')}
            </Button>
            <strong dir="ltr">{month}</strong>
            <Button
              variant="secondary"
              onClick={() => {
                setMonth((m) => shiftMonth(m, 1));
              }}
            >
              {t('attendance.next_month')}
            </Button>
          </div>
        </header>

        {resource.state.status === 'loading' ? <LoadingState t={t} rows={6} /> : null}
        {resource.state.status === 'error' ? (
          <ErrorState error={resource.state.error} t={t} onRetry={resource.reload} />
        ) : null}
        {resource.state.status === 'ready' ? (
          <MonthBody view={resource.state.value} locale={locale} t={t} />
        ) : null}
      </Card>
    </>
  );
}

function MonthBody({
  view,
  locale,
  t,
}: {
  readonly view: MonthView;
  readonly locale: Locale;
  readonly t: ReturnType<typeof createTranslator>;
}): React.JSX.Element {
  if (view.records.length === 0) {
    return (
      <EmptyState
        title={t('attendance.matrix_empty_title')}
        description={t('attendance.matrix_empty_description')}
        action={null}
      />
    );
  }

  const counts = summarise(view.records);
  const zone = view.session.timeZone;

  return (
    <>
      <ul className="attendance-chips">
        {ATTENDANCE_STATUSES.filter((status) => counts[status] > 0).map((status) => (
          <li key={status}>
            <StatusChip status={status} t={t} />
            <span dir="ltr">{counts[status]}</span>
          </li>
        ))}
      </ul>

      <div className="table-scroll attendance-table">
        <table>
          <thead>
            <tr>
              <th scope="col">{t('attendance.date')}</th>
              <th scope="col">{t('attendance.status.present')}</th>
              <th scope="col">{t('attendance.work_mode')}</th>
              <th scope="col">{t('attendance.check_in_time')}</th>
              <th scope="col">{t('attendance.check_out_time')}</th>
              <th scope="col">{t('attendance.working_hours')}</th>
              <th scope="col">{t('attendance.late_label')}</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {view.records.map((record) => (
              <tr key={record.id}>
                <td data-label={t('attendance.date')}>{formatDate(record.date, locale, zone)}</td>
                <td data-label={t('attendance.status.present')}>
                  <StatusChip status={record.status} t={t} />
                </td>
                <td data-label={t('attendance.work_mode')}>
                  <ModeChip mode={record.work_mode} t={t} />
                </td>
                <td data-label={t('attendance.check_in_time')} dir="ltr">
                  {formatTime(record.check_in_at, locale, zone) ?? '—'}
                </td>
                <td data-label={t('attendance.check_out_time')} dir="ltr">
                  {formatTime(record.check_out_at, locale, zone) ?? '—'}
                </td>
                <td data-label={t('attendance.working_hours')}>
                  <Duration minutes={record.working_minutes} />
                </td>
                <td data-label={t('attendance.late_label')}>
                  <Duration minutes={record.late_minutes} />
                </td>
                <td>
                  {/* Offered only for a day the server would still accept a
                      correction for (DOCUMENT 12 rule 13) — an action certain
                      to be refused is worse than no action. */}
                  {withinCorrectionWindow(
                    record.date,
                    view.today,
                    view.session.correctionWindowDays,
                  ) ? (
                    <Link
                      className="link-button"
                      href={`/${locale}/app/attendance/correction/new?date=${record.date}`}
                    >
                      {t('attendance.request_correction')}
                    </Link>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

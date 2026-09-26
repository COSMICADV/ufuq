'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { fetchOne } from '../../lib/api-client';
import {
  calendarGrid,
  monthOf,
  shiftMonth,
  STATUS_TONE,
  statusKey,
  summarise,
  withinCorrectionWindow,
  ATTENDANCE_STATUSES,
} from '../../lib/attendance';
import type { MonthlyCell, MonthlyMatrix } from '../../lib/attendance';
import { Button, Card, EmptyState } from '../design-system';
import { ErrorState, LoadingState } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';

import { StatusChip, StatusLegend } from './attendance-shared';
import { loadSession } from '../employees/use-session';

/**
 * `/{locale}/app/attendance/history` — DOCUMENT 04 C3.
 *
 * Month selector, a calendar coloured by state, a day's detail when one is
 * chosen, and a request-correction action per day.
 *
 * The calendar reads `GET /attendance/monthly`, whose `self` scope returns the
 * caller's own row and nothing else. Weekday columns start on Sunday so they
 * line up with `work_schedule_days.day_of_week` — the calendar and the
 * schedule mean the same thing by "day 0".
 */

/**
 * The Phase 4 schedule screen already names the weekdays (`settings.day_0` …
 * `day_6`, Sunday first). Reused rather than restated, so the calendar's
 * columns and the schedule's rows cannot drift apart (DOCUMENT 27 RULE 20).
 */
const WEEKDAY_KEYS = Array.from({ length: 7 }, (_, day) => `settings.day_${String(day)}`);

export function AttendanceHistory({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const [month, setMonth] = useState<string>(() => monthOf(new Date().toISOString().slice(0, 10)));
  const [selected, setSelected] = useState<MonthlyCell | null>(null);

  const load = useCallback(
    async (signal: AbortSignal) => {
      const session = await loadSession(locale, signal);
      const matrix = await fetchOne<MonthlyMatrix>(`/attendance/monthly?month=${month}`, {
        locale,
        signal,
      });
      const today = await fetchOne<{ date: string }>('/attendance/today', { locale, signal });
      return { session, matrix, today: today.date };
    },
    [locale, month],
  );

  const resource = useResource(load);

  return (
    <Card className="attendance-history">
      <header className="attendance-month__header">
        <h2>{t('attendance.history_title')}</h2>
        <div className="attendance-month__stepper">
          <Button
            variant="secondary"
            onClick={() => {
              setSelected(null);
              setMonth((m) => shiftMonth(m, -1));
            }}
          >
            {t('attendance.previous_month')}
          </Button>
          <strong dir="ltr">{month}</strong>
          <Button
            variant="secondary"
            onClick={() => {
              setSelected(null);
              setMonth((m) => shiftMonth(m, 1));
            }}
          >
            {t('attendance.next_month')}
          </Button>
        </div>
      </header>

      {resource.state.status === 'loading' ? <LoadingState t={t} rows={8} /> : null}
      {resource.state.status === 'error' ? (
        <ErrorState error={resource.state.error} t={t} onRetry={resource.reload} />
      ) : null}

      {resource.state.status === 'ready'
        ? (() => {
            const row = resource.state.value.matrix.rows[0];
            if (row === undefined) {
              return (
                <EmptyState
                  title={t('attendance.matrix_empty_title')}
                  description={t('attendance.matrix_empty_description')}
                  action={null}
                />
              );
            }
            const counts = summarise(row.days);
            const grid = calendarGrid(month, row.days);
            const today = resource.state.value.today;
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

                <div
                  className="attendance-calendar"
                  role="grid"
                  aria-label={t('attendance.history_title')}
                >
                  {WEEKDAY_KEYS.map((key) => (
                    <div key={key} className="attendance-calendar__head" role="columnheader">
                      {t(key)}
                    </div>
                  ))}
                  {grid.map((cell, index) =>
                    cell === null ? (
                      <div key={`pad-${String(index)}`} className="attendance-calendar__pad" />
                    ) : (
                      <button
                        key={cell.date}
                        type="button"
                        role="gridcell"
                        className={`attendance-calendar__day attendance-calendar__day--${
                          cell.status === null ? 'none' : STATUS_TONE[cell.status]
                        }${selected?.date === cell.date ? ' is-selected' : ''}`}
                        aria-label={`${cell.date} ${
                          cell.status === null
                            ? t('attendance.no_record')
                            : t(statusKey(cell.status))
                        }`}
                        onClick={() => {
                          setSelected(cell);
                        }}
                      >
                        <span dir="ltr">{Number(cell.date.slice(8))}</span>
                      </button>
                    ),
                  )}
                </div>

                <StatusLegend t={t} />

                {selected === null ? null : (
                  <div className="attendance-calendar__detail" role="status" aria-live="polite">
                    <strong dir="ltr">{selected.date}</strong>
                    {selected.status === null ? (
                      <span>{t('attendance.no_record')}</span>
                    ) : (
                      <StatusChip status={selected.status} t={t} />
                    )}
                    {withinCorrectionWindow(
                      selected.date,
                      today,
                      resource.state.value.session.correctionWindowDays,
                    ) ? (
                      <Link
                        className="link-button"
                        href={`/${locale}/app/attendance/correction/new?date=${selected.date}`}
                      >
                        {t('attendance.request_correction')}
                      </Link>
                    ) : null}
                  </div>
                )}
              </>
            );
          })()
        : null}
    </Card>
  );
}

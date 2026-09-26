'use client';

import { useCallback, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { fetchOne } from '../../lib/api-client';
import { monthOf, shiftMonth, STATUS_TONE, statusKey } from '../../lib/attendance';
import type { MonthlyMatrix, MonthlyRow } from '../../lib/attendance';
import { Button, Card, EmptyState, Select } from '../design-system';
import { ErrorState, LoadingState } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';

import { employeeName, StatusChip, StatusLegend } from './attendance-shared';

/**
 * `/{locale}/admin/attendance/monthly` — DOCUMENT 04 B6.
 *
 * Employees on rows, days on columns, one coloured cell per day per state,
 * a required legend, horizontal scroll with a frozen employee column.
 *
 * Below 1024px the matrix is **not shrunk** — DOCUMENT 04 B6 says so
 * explicitly, and a 31-column grid at phone width is unreadable however it is
 * scaled. It becomes one employee at a time, chosen from a select, which is
 * the same data at a size that can be read.
 */

export function AttendanceMonthly({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const [month, setMonth] = useState<string>(() => monthOf(new Date().toISOString().slice(0, 10)));
  const [focused, setFocused] = useState<string>('');

  const load = useCallback(
    (signal: AbortSignal) =>
      fetchOne<MonthlyMatrix>(`/attendance/monthly?month=${month}`, { locale, signal }),
    [locale, month],
  );

  const resource = useResource(load);

  return (
    <Card className="attendance-matrix">
      <header className="attendance-month__header">
        <h2>{t('attendance.monthly_title')}</h2>
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

      {resource.state.status === 'loading' ? <LoadingState t={t} rows={10} /> : null}
      {resource.state.status === 'error' ? (
        <ErrorState error={resource.state.error} t={t} onRetry={resource.reload} />
      ) : null}

      {resource.state.status === 'ready' ? (
        resource.state.value.rows.length === 0 ? (
          <EmptyState
            title={t('attendance.matrix_empty_title')}
            description={t('attendance.matrix_empty_description')}
            action={null}
          />
        ) : (
          <>
            <StatusLegend t={t} />

            {/* Desktop and tablet: the matrix itself. */}
            <div className="table-scroll attendance-matrix__scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col" className="attendance-matrix__name">
                      {t('attendance.matrix_employee')}
                    </th>
                    {resource.state.value.days.map((day) => (
                      <th key={day} scope="col" dir="ltr">
                        {Number(day.slice(8))}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {resource.state.value.rows.map((row) => (
                    <tr key={row.employee.id}>
                      <th scope="row" className="attendance-matrix__name">
                        {employeeName(row.employee)}
                      </th>
                      {row.days.map((cell) => (
                        <td
                          key={cell.date}
                          className={`attendance-matrix__cell attendance-matrix__cell--${
                            cell.status === null ? 'none' : STATUS_TONE[cell.status]
                          }`}
                          title={
                            cell.status === null
                              ? `${cell.date} — ${t('attendance.no_record')}`
                              : `${cell.date} — ${t(statusKey(cell.status))}`
                          }
                        >
                          <span className="visually-hidden">
                            {cell.status === null
                              ? t('attendance.no_record')
                              : t(statusKey(cell.status))}
                          </span>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile: one employee at a time, not a squeezed matrix. */}
            <div className="attendance-matrix__single">
              <label>
                <span>{t('attendance.matrix_employee')}</span>
                <Select
                  value={
                    focused === '' ? (resource.state.value.rows[0]?.employee.id ?? '') : focused
                  }
                  onChange={(event) => {
                    setFocused(event.target.value);
                  }}
                >
                  {resource.state.value.rows.map((row) => (
                    <option key={row.employee.id} value={row.employee.id}>
                      {employeeName(row.employee)}
                    </option>
                  ))}
                </Select>
              </label>
              <SingleEmployeeMonth
                row={
                  resource.state.value.rows.find((row) => row.employee.id === focused) ??
                  (resource.state.value.rows[0] as MonthlyRow)
                }
                t={t}
              />
            </div>
          </>
        )
      ) : null}
    </Card>
  );
}

function SingleEmployeeMonth({
  row,
  t,
}: {
  readonly row: MonthlyRow;
  readonly t: ReturnType<typeof createTranslator>;
}): React.JSX.Element {
  return (
    <ul className="attendance-matrix__days">
      {row.days.map((cell) => (
        <li key={cell.date}>
          <span dir="ltr">{cell.date}</span>
          {cell.status === null ? (
            <span className="attendance-muted">{t('attendance.no_record')}</span>
          ) : (
            <StatusChip status={cell.status} t={t} />
          )}
        </li>
      ))}
    </ul>
  );
}

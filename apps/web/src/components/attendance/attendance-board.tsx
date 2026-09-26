'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { fetchMany, fetchOne } from '../../lib/api-client';
import {
  activeFilterCount,
  ATTENDANCE_STATUSES,
  boardFiltersFromParams,
  boardQuery,
  boardUrlQuery,
  summarise,
  WORK_MODES,
} from '../../lib/attendance';
import type { AttendanceRecord, BoardFilters } from '../../lib/attendance';
import { DEFAULT_PER_PAGE, pageFromParams } from '../../lib/paging';
import { Button, Card, EmptyState, Input, Select } from '../design-system';
import { ErrorState, LoadingState, Pagination } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';

import {
  departmentName,
  Duration,
  employeeName,
  formatTime,
  ModeChip,
  StatusChip,
} from './attendance-shared';
import { loadSession } from '../employees/use-session';

/**
 * `/{locale}/admin/attendance` — DOCUMENT 04 B5, the daily board.
 *
 * Date picker defaulting to today, state summary chips, department and
 * work-mode filters, and the employee table. Filters live in the URL, so a
 * board is a link somebody can send.
 *
 * Two empty states, because they mean different things (DOCUMENT 11 §2):
 * nothing recorded on a day anybody could have worked, and nothing matching
 * the filters the admin set.
 */

interface Department {
  readonly id: string;
  readonly name_ar: string;
  readonly name_en: string;
}

export function AttendanceBoard({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const router = useRouter();
  const params = useSearchParams();
  const page = pageFromParams(params, 'page');
  const [today, setToday] = useState<string>(() => new Date().toISOString().slice(0, 10));

  const filters = useMemo(
    () => boardFiltersFromParams(new URLSearchParams(params.toString()), today),
    [params, today],
  );

  const load = useCallback(
    async (signal: AbortSignal) => {
      const session = await loadSession(locale, signal);
      const state = await fetchOne<{ date: string }>('/attendance/today', { locale, signal });
      setToday(state.date);
      const [records, departments] = await Promise.all([
        fetchMany<AttendanceRecord>(`/attendance?${boardQuery(filters, page, DEFAULT_PER_PAGE)}`, {
          locale,
          signal,
        }),
        fetchMany<Department>('/departments?per_page=100', { locale, signal }),
      ]);
      return { session, records, departments: departments.items };
    },
    [locale, filters, page],
  );

  const resource = useResource(load);

  const apply = (next: Partial<BoardFilters>): void => {
    const merged = { ...filters, ...next };
    router.push(`/${locale}/admin/attendance${boardUrlQuery(merged, today)}`);
  };

  return (
    <Card className="attendance-board">
      <div className="attendance-board__filters">
        <label>
          <span>{t('attendance.date')}</span>
          <Input
            type="date"
            dir="ltr"
            value={filters.date}
            onChange={(event) => {
              apply({ date: event.target.value });
            }}
          />
        </label>

        <label>
          <span>{t('attendance.department')}</span>
          <Select
            value={filters.departmentId}
            onChange={(event) => {
              apply({ departmentId: event.target.value });
            }}
          >
            <option value="">{t('attendance.all_departments')}</option>
            {resource.state.status === 'ready'
              ? resource.state.value.departments.map((department) => (
                  <option key={department.id} value={department.id}>
                    {locale === 'ar' ? department.name_ar : department.name_en}
                  </option>
                ))
              : null}
          </Select>
        </label>

        <label>
          <span>{t('attendance.status.present')}</span>
          <Select
            value={filters.status}
            onChange={(event) => {
              apply({ status: event.target.value });
            }}
          >
            <option value="">{t('attendance.all_statuses')}</option>
            {ATTENDANCE_STATUSES.map((status) => (
              <option key={status} value={status}>
                {t(`attendance.status.${status}`)}
              </option>
            ))}
          </Select>
        </label>

        <label>
          <span>{t('attendance.work_mode')}</span>
          <Select
            value={filters.workMode}
            onChange={(event) => {
              apply({ workMode: event.target.value });
            }}
          >
            <option value="">{t('attendance.all_modes')}</option>
            {WORK_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {t(`attendance.mode.${mode}`)}
              </option>
            ))}
          </Select>
        </label>

        {activeFilterCount(filters) === 0 ? null : (
          <Button
            variant="secondary"
            onClick={() => {
              apply({ departmentId: '', status: '', workMode: '' });
            }}
          >
            {t('attendance.clear_filters')}
          </Button>
        )}
      </div>

      {resource.state.status === 'loading' ? <LoadingState t={t} rows={8} /> : null}
      {resource.state.status === 'error' ? (
        <ErrorState error={resource.state.error} t={t} onRetry={resource.reload} />
      ) : null}

      {resource.state.status === 'ready' ? (
        resource.state.value.records.items.length === 0 ? (
          activeFilterCount(filters) > 0 ? (
            <EmptyState
              title={t('attendance.filtered_empty_title')}
              description={t('attendance.filtered_empty_description')}
              action={
                <Button
                  variant="secondary"
                  onClick={() => {
                    apply({ departmentId: '', status: '', workMode: '' });
                  }}
                >
                  {t('attendance.clear_filters')}
                </Button>
              }
            />
          ) : (
            <EmptyState
              title={t('attendance.empty_title')}
              description={t('attendance.empty_description')}
              action={null}
            />
          )
        ) : (
          <>
            <ul className="attendance-chips">
              {(() => {
                const counts = summarise(resource.state.value.records.items);
                return ATTENDANCE_STATUSES.filter((status) => counts[status] > 0).map((status) => (
                  <li key={status}>
                    <StatusChip status={status} t={t} />
                    <span dir="ltr">{counts[status]}</span>
                  </li>
                ));
              })()}
            </ul>

            <div className="table-scroll attendance-table">
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t('attendance.employee')}</th>
                    <th scope="col">{t('attendance.department')}</th>
                    <th scope="col">{t('attendance.work_mode')}</th>
                    <th scope="col">{t('attendance.check_in_time')}</th>
                    <th scope="col">{t('attendance.check_out_time')}</th>
                    <th scope="col">{t('attendance.working_hours')}</th>
                    <th scope="col">{t('attendance.late_label')}</th>
                    <th scope="col">{t('attendance.status.present')}</th>
                  </tr>
                </thead>
                <tbody>
                  {resource.state.value.records.items.map((record) => {
                    const zone =
                      resource.state.status === 'ready'
                        ? resource.state.value.session.timeZone
                        : 'UTC';
                    return (
                      <tr key={record.id}>
                        <td data-label={t('attendance.employee')}>
                          {employeeName(record.employee)}
                          <small dir="ltr">{record.employee.employee_code}</small>
                        </td>
                        <td data-label={t('attendance.department')}>
                          {departmentName(record.employee.department, locale) ?? '—'}
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
                        <td data-label={t('attendance.status.present')}>
                          <StatusChip status={record.status} t={t} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <Pagination
              t={t}
              page={page}
              totalPages={resource.state.value.records.meta.total_pages}
              hrefForPage={(next) => {
                const query = new URLSearchParams(boardUrlQuery(filters, today).slice(1));
                query.set('page', String(next));
                return `/${locale}/admin/attendance?${query.toString()}`;
              }}
            />
          </>
        )
      ) : null}
    </Card>
  );
}

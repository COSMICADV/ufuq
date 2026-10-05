'use client';

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { Locale, Translator } from '@ufuq/i18n';

import { fetchMany } from '../../lib/api-client';
import {
  EMPTY_EMPLOYEE_TASK_FILTERS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  apiQueryForEmployeeTasks,
  employeeTaskFiltersFromParams,
  priorityKey,
  searchForEmployeeTaskFilters,
  statusKey,
} from '../../lib/tasks';
import type { EmployeeTaskFilters, Task } from '../../lib/tasks';
import { Button, EmptyState, Field, Select, Toggle } from '../design-system';
import { ErrorState, LoadingState, Pagination } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';

import { TaskTable } from './tasks-admin';

/**
 * The employee profile's Tasks tab — DOCUMENT 04 B4: "filterable task list
 * scoped to this employee".
 *
 * It is `GET /tasks?assignee_employee_id=…` and nothing else: the same API,
 * the same row component (`TaskTable`) and the same server-side scope as the
 * task list. A manager viewing someone outside their team would get an empty
 * list from the API — the profile itself already refuses that case.
 *
 * Filters (status, priority, overdue) and the page live in the URL under
 * `task_*` keys, so they survive a refresh without touching the profile's
 * own parameters.
 */

const PER_PAGE = 20;

export function EmployeeTasks({
  locale,
  t,
  employeeId,
  timeZone,
  assignAction,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly employeeId: string;
  readonly timeZone: string;
  /** The "Assign task" link, when the caller may create one for this employee. */
  readonly assignAction: React.ReactNode;
}): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname() ?? '';
  const searchParams = useSearchParams();
  const params = new URLSearchParams(searchParams?.toString() ?? '');
  const filters = employeeTaskFiltersFromParams(params);
  const search = searchForEmployeeTaskFilters(params, filters);
  const filtered = filters.status !== '' || filters.priority !== '' || filters.overdue;

  const navigate = (next: EmployeeTaskFilters): void => {
    router.replace(`${pathname}${searchForEmployeeTaskFilters(params, next)}`, {
      scroll: false,
    });
  };
  const change = (patch: Partial<EmployeeTaskFilters>): void => {
    navigate({ ...filters, ...patch, page: 1 });
  };

  const load = useCallback(
    (signal: AbortSignal) =>
      fetchMany<Task>('/tasks', {
        locale,
        signal,
        query: apiQueryForEmployeeTasks(
          employeeId,
          employeeTaskFiltersFromParams(new URLSearchParams(search.slice(1))),
          PER_PAGE,
        ),
      }),
    [locale, employeeId, search],
  );
  const { state, reload } = useResource(load);

  return (
    <div className="tasks-detail">
      <section className="filter-bar" aria-label={t('tasks.filters')}>
        <div className="tasks-filters is-open">
          <Field label={t('tasks.field_status')}>
            <Select
              value={filters.status}
              onChange={(event) => {
                change({ status: event.target.value });
              }}
            >
              <option value="">{t('tasks.all_statuses')}</option>
              {TASK_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {t(statusKey(status))}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('tasks.field_priority')}>
            <Select
              value={filters.priority}
              onChange={(event) => {
                change({ priority: event.target.value });
              }}
            >
              <option value="">{t('tasks.all_priorities')}</option>
              {TASK_PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {t(priorityKey(priority))}
                </option>
              ))}
            </Select>
          </Field>
          <Toggle
            label={t('tasks.overdue_only')}
            checked={filters.overdue}
            onChange={(event) => {
              change({ overdue: event.target.checked });
            }}
          />
        </div>
        {filtered ? (
          <Button
            variant="ghost"
            onClick={() => {
              navigate(EMPTY_EMPLOYEE_TASK_FILTERS);
            }}
          >
            {t('tasks.clear_filters')}
          </Button>
        ) : null}
        {assignAction}
      </section>

      {state.status === 'loading' ? <LoadingState t={t} rows={5} /> : null}
      {state.status === 'error' ? <ErrorState error={state.error} t={t} onRetry={reload} /> : null}
      {state.status === 'ready' ? (
        state.value.items.length === 0 ? (
          filtered ? (
            <EmptyState
              title={t('tasks.filtered_empty_title')}
              description={t('tasks.filtered_empty_description')}
              action={
                <Button
                  variant="secondary"
                  onClick={() => {
                    navigate(EMPTY_EMPLOYEE_TASK_FILTERS);
                  }}
                >
                  {t('tasks.clear_filters')}
                </Button>
              }
            />
          ) : (
            <EmptyState
              title={t('employees.tasks_empty_title')}
              description={t('employees.tasks_empty')}
              action={assignAction}
            />
          )
        ) : (
          <>
            <TaskTable
              tasks={state.value.items}
              locale={locale}
              t={t}
              timeZone={timeZone}
              showAssignee={false}
            />
            <Pagination
              page={state.value.meta.page}
              totalPages={state.value.meta.total_pages}
              hrefForPage={(page) =>
                `${pathname}${searchForEmployeeTaskFilters(params, { ...filters, page })}`
              }
              t={t}
            />
          </>
        )
      ) : null}
    </div>
  );
}

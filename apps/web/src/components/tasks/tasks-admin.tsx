'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { createTranslator } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';

import { fetchMany } from '../../lib/api-client';
import type { CollectionResult } from '../../lib/api-client';
import {
  EMPTY_TASK_FILTERS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  activeTaskFilterCount,
  apiQueryForTaskFilters,
  assigneeName,
  hasActiveTaskFilters,
  priorityKey,
  searchForTaskFilters,
  statusKey,
  taskFiltersFromParams,
  taskPath,
} from '../../lib/tasks';
import type { Task, TaskFilters, TaskStatus } from '../../lib/tasks';
import {
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Input,
  Select,
  Toggle,
} from '../design-system';
import { loadSession } from '../employees/use-session';
import type { SessionView } from '../employees/use-session';
import {
  Cell,
  ErrorState,
  LoadingState,
  Pagination,
  SuccessNotice,
} from '../settings/screen-states';
import { useResource } from '../settings/use-resource';

import { Deadline, PriorityChip, ProgressBar, ProgressRing, TaskStatusChip } from './tasks-shared';

/**
 * `/{locale}/admin/tasks` — DOCUMENT 04 B8, DOCUMENT 13 "Screens".
 *
 * Two views, toggled and held in the URL: **Table** and **Board** (columns =
 * statuses). Filters: status, priority, assignee, department, date range and
 * overdue-only — every one held in the URL (DOCUMENT 11 §6). Goal arrives with
 * goals in Phase 8; bulk status change is V2 (DOCUMENT 04 B8), and board
 * drag-and-drop is a "should have" (DOCUMENT 24) — status moves happen on the
 * task, where the transition rules and their reasons are shown.
 *
 * The list is whatever the API returns for the caller's scope: an ADMIN sees
 * the company, a MANAGER their team. Nothing is filtered here.
 *
 * Mobile: the table becomes cards (DOCUMENT 22) and the board is one
 * swipeable column at a time — never shrunk to fit (DOCUMENT 13).
 */

const TABLE_PER_PAGE = 20;
/** DOCUMENT 08 §1's maximum — a board column shows at most one page. */
const BOARD_PER_PAGE = 100;
const OPTIONS_PAGE_SIZE = '100';

interface Option {
  readonly id: string;
  readonly label: string;
}

interface FilterOptions {
  readonly assignees: readonly Option[];
  readonly departments: readonly Option[];
  readonly goals: readonly Option[];
}

type Listing =
  | { readonly view: 'table'; readonly result: CollectionResult<Task> }
  | {
      readonly view: 'board';
      readonly columns: readonly {
        readonly status: TaskStatus;
        readonly result: CollectionResult<Task>;
      }[];
    };

export function TasksAdmin({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const router = useRouter();
  const pathname = usePathname() ?? `/${locale}/admin/tasks`;
  const searchParams = useSearchParams();
  const params = new URLSearchParams(searchParams?.toString() ?? '');
  const filters = taskFiltersFromParams(params);
  const search = searchForTaskFilters(filters);
  const notice = params.get('notice') === 'deleted' ? t('tasks.deleted') : null;

  const navigate = useCallback(
    (next: TaskFilters) => {
      router.replace(`${pathname}${searchForTaskFilters(next)}`, { scroll: false });
    },
    [pathname, router],
  );
  const change = (patch: Partial<TaskFilters>): void => {
    navigate({ ...filters, ...patch, page: 1 });
  };

  const loadListing = useCallback(
    async (signal: AbortSignal): Promise<Listing> => {
      const current = taskFiltersFromParams(new URLSearchParams(search.slice(1)));
      if (current.view === 'table') {
        const result = await fetchMany<Task>('/tasks', {
          locale,
          signal,
          query: apiQueryForTaskFilters(current, TABLE_PER_PAGE),
        });
        return { view: 'table', result };
      }
      // One request per column, so each column's count is the true total for
      // that status and never a slice of somebody else's page.
      const statuses = current.status === '' ? TASK_STATUSES : [current.status as TaskStatus];
      const columns = await Promise.all(
        statuses.map(async (status) => ({
          status,
          result: await fetchMany<Task>('/tasks', {
            locale,
            signal,
            query: apiQueryForTaskFilters(current, BOARD_PER_PAGE, status),
          }),
        })),
      );
      return { view: 'board', columns };
    },
    [locale, search],
  );
  const listing = useResource(loadListing);

  const loadSessionView = useCallback(
    (signal: AbortSignal) => loadSession(locale, signal),
    [locale],
  );
  const session = useResource<SessionView>(loadSessionView);

  const loadOptions = useCallback(
    async (signal: AbortSignal): Promise<FilterOptions> => {
      const query = { per_page: OPTIONS_PAGE_SIZE };
      // A filter is a convenience: if an option list fails, the screen still
      // works with that filter's "all" choice rather than failing outright.
      const [employees, departments, goals] = await Promise.all([
        fetchMany<{ id: string; first_name: string; last_name: string }>('/employees', {
          locale,
          signal,
          query: { ...query, sort: 'name' },
        }).catch(() => null),
        fetchMany<{ id: string; name_ar: string; name_en: string }>('/departments', {
          locale,
          signal,
          query,
        }).catch(() => null),
        fetchMany<{ id: string; title: string }>('/goals', { locale, signal, query }).catch(
          () => null,
        ),
      ]);
      return {
        goals: (goals?.items ?? []).map((g) => ({ id: g.id, label: g.title })),
        assignees: (employees?.items ?? []).map((e) => ({
          id: e.id,
          label: `${e.first_name} ${e.last_name}`.trim(),
        })),
        departments: (departments?.items ?? []).map((d) => ({
          id: d.id,
          label: locale === 'en' ? d.name_en : d.name_ar,
        })),
      };
    },
    [locale],
  );
  const options = useResource(loadOptions);
  const optionValues: FilterOptions =
    options.state.status === 'ready'
      ? options.state.value
      : { assignees: [], departments: [], goals: [] };

  const zone = session.state.status === 'ready' ? session.state.value.timeZone : 'UTC';
  const canCreate =
    session.state.status === 'ready' && session.state.value.permissions.has('task.create');
  const filtered = hasActiveTaskFilters(filters);
  const activeCount = activeTaskFilterCount(filters);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const createAction = canCreate ? (
    <Link className="button button--primary button--md" href={`/${locale}/admin/tasks/new`}>
      {t('tasks.new_task')}
    </Link>
  ) : null;

  return (
    <>
      <SuccessNotice message={notice} t={t} />

      <div className="tasks-toolbar">
        <div className="tasks-view-toggle" role="group" aria-label={t('tasks.view_label')}>
          {(['table', 'board'] as const).map((view) => (
            <Button
              key={view}
              variant={filters.view === view ? 'primary' : 'secondary'}
              aria-pressed={filters.view === view}
              onClick={() => {
                change({ view });
              }}
            >
              {view === 'table' ? t('tasks.view_table') : t('tasks.view_board')}
            </Button>
          ))}
        </div>
        {createAction}
      </div>

      <section className="filter-bar" aria-label={t('tasks.filters')}>
        {/* DOCUMENT 22 "Filters": inline on desktop; on a phone, behind a
            button that shows the active count. */}
        <Button
          variant="secondary"
          className="tasks-filters__toggle"
          aria-expanded={filtersOpen}
          aria-controls="task-filters"
          onClick={() => {
            setFiltersOpen((open) => !open);
          }}
        >
          {activeCount > 0
            ? t('tasks.active_filters', { count: String(activeCount) })
            : t('tasks.filters')}
        </Button>
        <div id="task-filters" className={`tasks-filters${filtersOpen ? ' is-open' : ''}`}>
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
          <Field label={t('tasks.field_assignee')}>
            <Select
              value={filters.assignee}
              onChange={(event) => {
                change({ assignee: event.target.value });
              }}
            >
              <option value="">{t('tasks.all_assignees')}</option>
              {optionValues.assignees.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('tasks.field_department')}>
            <Select
              value={filters.department}
              onChange={(event) => {
                change({ department: event.target.value });
              }}
            >
              <option value="">{t('tasks.all_departments')}</option>
              {optionValues.departments.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('tasks.field_goal')}>
            <Select
              value={filters.goal}
              onChange={(event) => {
                change({ goal: event.target.value });
              }}
            >
              <option value="">{t('tasks.all_goals')}</option>
              {optionValues.goals.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('tasks.from')}>
            <Input
              type="date"
              value={filters.from}
              onChange={(event) => {
                change({ from: event.target.value });
              }}
            />
          </Field>
          <Field label={t('tasks.to')}>
            <Input
              type="date"
              value={filters.to}
              onChange={(event) => {
                change({ to: event.target.value });
              }}
            />
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
              navigate({ ...EMPTY_TASK_FILTERS, view: filters.view });
            }}
          >
            {t('tasks.clear_filters')}
          </Button>
        ) : null}
      </section>

      {listing.state.status === 'loading' ? <LoadingState t={t} rows={8} /> : null}
      {listing.state.status === 'error' ? (
        <ErrorState error={listing.state.error} t={t} onRetry={listing.reload} />
      ) : null}
      {listing.state.status === 'ready' ? (
        isEmpty(listing.state.value) ? (
          filtered ? (
            <EmptyState
              title={t('tasks.filtered_empty_title')}
              description={t('tasks.filtered_empty_description')}
              action={
                <Button
                  variant="secondary"
                  onClick={() => {
                    navigate({ ...EMPTY_TASK_FILTERS, view: filters.view });
                  }}
                >
                  {t('tasks.clear_filters')}
                </Button>
              }
            />
          ) : (
            <EmptyState
              title={t('tasks.empty_title')}
              description={t('tasks.empty_description')}
              action={createAction}
            />
          )
        ) : listing.state.value.view === 'table' ? (
          <>
            <TaskTable
              tasks={listing.state.value.result.items}
              locale={locale}
              t={t}
              timeZone={zone}
            />
            <Pagination
              page={listing.state.value.result.meta.page}
              totalPages={listing.state.value.result.meta.total_pages}
              hrefForPage={(page) => `${pathname}${searchForTaskFilters({ ...filters, page })}`}
              t={t}
            />
          </>
        ) : (
          <TaskBoard columns={listing.state.value.columns} locale={locale} t={t} timeZone={zone} />
        )
      ) : null}
    </>
  );
}

function isEmpty(listing: Listing): boolean {
  return listing.view === 'table'
    ? listing.result.items.length === 0
    : listing.columns.every((column) => column.result.items.length === 0);
}

/**
 * The board — DOCUMENT 04 B8, "columns = statuses". Each column is a list
 * with its own heading and count, so a screen reader hears "In progress, 4"
 * rather than an unlabelled grid.
 */
function TaskBoard({
  columns,
  locale,
  t,
  timeZone,
}: {
  readonly columns: readonly {
    readonly status: TaskStatus;
    readonly result: CollectionResult<Task>;
  }[];
  readonly locale: Locale;
  readonly t: Translator;
  readonly timeZone: string;
}): React.JSX.Element {
  return (
    <div className="tasks-board">
      {columns.map(({ status, result }) => (
        <section key={status} className="tasks-board__column" aria-labelledby={`column-${status}`}>
          <header className="tasks-board__header">
            <h2 id={`column-${status}`}>{t(statusKey(status))}</h2>
            <span className="tasks-count">{result.meta.total}</span>
          </header>
          {result.items.length === 0 ? (
            <p className="tasks-muted">{t('tasks.column_empty')}</p>
          ) : (
            <ul className="tasks-cards">
              {result.items.map((task) => (
                <li key={task.id}>
                  <TaskCard
                    task={task}
                    href={taskPath(locale, task.id)}
                    locale={locale}
                    t={t}
                    timeZone={timeZone}
                  />
                </li>
              ))}
            </ul>
          )}
          {result.meta.total > result.items.length ? (
            <p className="tasks-muted">
              {t('tasks.board_more', {
                shown: String(result.items.length),
                total: String(result.meta.total),
              })}
            </p>
          ) : null}
        </section>
      ))}
    </div>
  );
}

/**
 * A task card — DOCUMENT 13 "Mobile behaviour": full width, with priority
 * chip, deadline and progress ring. Shared by the board and the employee's
 * list.
 */
export function TaskCard({
  task,
  href,
  locale,
  t,
  timeZone,
  showAssignee = true,
}: {
  readonly task: Task;
  readonly href: string;
  readonly locale: Locale;
  readonly t: Translator;
  readonly timeZone: string;
  readonly showAssignee?: boolean;
}): React.JSX.Element {
  return (
    <Link className="tasks-card" href={href}>
      <span className="tasks-card__main">
        <strong className="tasks-card__title">{task.title}</strong>
        {showAssignee ? <span className="tasks-muted">{assigneeName(task)}</span> : null}
        <span className="tasks-card__chips">
          <PriorityChip priority={task.priority} t={t} />
          <Deadline
            deadline={task.deadline}
            overdue={task.is_overdue}
            locale={locale}
            timeZone={timeZone}
            t={t}
          />
        </span>
      </span>
      <ProgressRing percent={task.progress_percent} t={t} />
    </Link>
  );
}

/**
 * The task table — DOCUMENT 04 B8. Shared by the task list, the employee
 * profile's Tasks tab and the dashboard's reassignment list, so a task row
 * reads the same everywhere (DOCUMENT 27 RULE 20). Below 1024px it becomes
 * stacked cards (DOCUMENT 22).
 */
export function TaskTable({
  tasks,
  locale,
  t,
  timeZone,
  showAssignee = true,
}: {
  readonly tasks: readonly Task[];
  readonly locale: Locale;
  readonly t: Translator;
  readonly timeZone: string;
  readonly showAssignee?: boolean;
}): React.JSX.Element {
  const headers = [
    t('tasks.col_task'),
    ...(showAssignee ? [t('tasks.col_assignee')] : []),
    t('tasks.col_department'),
    t('tasks.col_priority'),
    t('tasks.col_status'),
    t('tasks.col_deadline'),
    t('tasks.col_progress'),
  ];
  return (
    <Card className="tasks-table">
      <DataTable
        headers={headers}
        rows={tasks.map((task) => [
          <Cell key="title" label={t('tasks.col_task')}>
            <Link className="tasks-title-link" href={taskPath(locale, task.id)}>
              {task.title}
            </Link>
          </Cell>,
          ...(showAssignee
            ? [
                <Cell key="assignee" label={t('tasks.col_assignee')}>
                  {assigneeName(task)}
                </Cell>,
              ]
            : []),
          <Cell key="department" label={t('tasks.col_department')}>
            {task.department === null
              ? t('tasks.no_department')
              : locale === 'en'
                ? task.department.name_en
                : task.department.name_ar}
          </Cell>,
          <Cell key="priority" label={t('tasks.col_priority')}>
            <PriorityChip priority={task.priority} t={t} />
          </Cell>,
          <Cell key="status" label={t('tasks.col_status')}>
            <TaskStatusChip status={task.status} t={t} />
          </Cell>,
          <Cell key="deadline" label={t('tasks.col_deadline')}>
            <Deadline
              deadline={task.deadline}
              overdue={task.is_overdue}
              locale={locale}
              timeZone={timeZone}
              t={t}
            />
          </Cell>,
          <Cell key="progress" label={t('tasks.col_progress')}>
            <ProgressBar percent={task.progress_percent} t={t} />
          </Cell>,
        ])}
      />
    </Card>
  );
}

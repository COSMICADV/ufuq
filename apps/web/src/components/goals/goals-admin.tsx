'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';

import { fetchMany } from '../../lib/api-client';
import {
  EMPTY_GOAL_FILTERS,
  GOAL_STATUSES,
  GOAL_TYPES,
  apiQueryForGoalFilters,
  goalFiltersFromParams,
  goalPath,
  goalStatusKey,
  goalTypeKey,
  newGoalPath,
  ownerName,
  searchForGoalFilters,
} from '../../lib/goals';
import type { Goal, GoalFilters } from '../../lib/goals';
import { Button, Card, DataTable, EmptyState, Field, Select } from '../design-system';
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

import { GoalPeriod, GoalProgress, GoalStatusChip, GoalTypeChip, GoalValue } from './goals-shared';

/**
 * `/{locale}/admin/goals` — DOCUMENT 04 B11.
 *
 * Columns: goal name, type chip, owner, target, current, progress bar,
 * period, status. Filters (type, status) and the page live in the URL. The
 * list is `GET /goals` under the caller's own `goal.view` scope — a manager
 * sees their team's goals. Below 1024px the table becomes stacked cards
 * (DOCUMENT 22).
 */

const PER_PAGE = 20;

export function GoalsAdmin({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const router = useRouter();
  const pathname = usePathname() ?? `/${locale}/admin/goals`;
  const searchParams = useSearchParams();
  const params = new URLSearchParams(searchParams?.toString() ?? '');
  const filters = goalFiltersFromParams(params);
  const search = searchForGoalFilters(filters);
  const notice = params.get('notice') === 'cancelled' ? t('goals.cancelled_notice') : null;
  const filtered = filters.type !== '' || filters.status !== '';

  const navigate = (next: GoalFilters): void => {
    router.replace(`${pathname}${searchForGoalFilters(next)}`, { scroll: false });
  };
  const change = (patch: Partial<GoalFilters>): void => {
    navigate({ ...filters, ...patch, page: 1 });
  };

  const load = useCallback(
    (signal: AbortSignal) =>
      fetchMany<Goal>('/goals', {
        locale,
        signal,
        query: apiQueryForGoalFilters(
          goalFiltersFromParams(new URLSearchParams(search.slice(1))),
          PER_PAGE,
        ),
      }),
    [locale, search],
  );
  const listing = useResource(load);
  const loadSessionView = useCallback(
    (signal: AbortSignal) => loadSession(locale, signal),
    [locale],
  );
  const session = useResource<SessionView>(loadSessionView);

  const zone = session.state.status === 'ready' ? session.state.value.timeZone : 'UTC';
  const createAction =
    session.state.status === 'ready' && session.state.value.permissions.has('goal.create') ? (
      <Link className="button button--primary button--md" href={newGoalPath(locale)}>
        {t('goals.new_goal')}
      </Link>
    ) : null;

  return (
    <>
      <SuccessNotice message={notice} t={t} />
      <div className="tasks-toolbar">
        <section className="tasks-filters is-open" aria-label={t('goals.filters')}>
          <Field label={t('goals.field_type')}>
            <Select
              value={filters.type}
              onChange={(event) => {
                change({ type: event.target.value });
              }}
            >
              <option value="">{t('goals.all_types')}</option>
              {GOAL_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(goalTypeKey(type))}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('goals.field_status')}>
            <Select
              value={filters.status}
              onChange={(event) => {
                change({ status: event.target.value });
              }}
            >
              <option value="">{t('goals.all_statuses')}</option>
              {GOAL_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {t(goalStatusKey(status))}
                </option>
              ))}
            </Select>
          </Field>
          {filtered ? (
            <Button
              variant="ghost"
              onClick={() => {
                navigate(EMPTY_GOAL_FILTERS);
              }}
            >
              {t('goals.clear_filters')}
            </Button>
          ) : null}
        </section>
        {createAction}
      </div>

      {listing.state.status === 'loading' ? <LoadingState t={t} rows={8} /> : null}
      {listing.state.status === 'error' ? (
        <ErrorState error={listing.state.error} t={t} onRetry={listing.reload} />
      ) : null}
      {listing.state.status === 'ready' ? (
        listing.state.value.items.length === 0 ? (
          filtered ? (
            <EmptyState
              title={t('goals.filtered_empty_title')}
              description={t('goals.filtered_empty_description')}
              action={
                <Button
                  variant="secondary"
                  onClick={() => {
                    navigate(EMPTY_GOAL_FILTERS);
                  }}
                >
                  {t('goals.clear_filters')}
                </Button>
              }
            />
          ) : (
            <EmptyState
              title={t('goals.empty_title')}
              description={t('goals.empty_description')}
              action={createAction}
            />
          )
        ) : (
          <>
            <GoalTable goals={listing.state.value.items} locale={locale} t={t} timeZone={zone} />
            <Pagination
              page={listing.state.value.meta.page}
              totalPages={listing.state.value.meta.total_pages}
              hrefForPage={(page) => `${pathname}${searchForGoalFilters({ ...filters, page })}`}
              t={t}
            />
          </>
        )
      ) : null}
    </>
  );
}

/** DOCUMENT 04 B11's columns, in its order. */
export function GoalTable({
  goals,
  locale,
  t,
  timeZone,
}: {
  readonly goals: readonly Goal[];
  readonly locale: Locale;
  readonly t: Translator;
  readonly timeZone: string;
}): React.JSX.Element {
  const headers = [
    t('goals.col_goal'),
    t('goals.col_type'),
    t('goals.col_owner'),
    t('goals.col_target'),
    t('goals.col_current'),
    t('goals.col_progress'),
    t('goals.col_period'),
    t('goals.col_status'),
  ];
  return (
    <Card className="tasks-table">
      <DataTable
        headers={headers}
        rows={goals.map((goal) => [
          <Cell key="title" label={headers[0] as string}>
            <Link className="tasks-title-link" href={goalPath(locale, goal.id)}>
              {goal.title}
            </Link>
          </Cell>,
          <Cell key="type" label={headers[1] as string}>
            <GoalTypeChip type={goal.type} t={t} />
          </Cell>,
          <Cell key="owner" label={headers[2] as string}>
            {ownerName(goal)}
          </Cell>,
          <Cell key="target" label={headers[3] as string}>
            <GoalValue value={goal.target_value} unit={goal.unit} t={t} />
          </Cell>,
          <Cell key="current" label={headers[4] as string}>
            <GoalValue value={goal.current_value} unit={goal.unit} t={t} />
          </Cell>,
          <Cell key="progress" label={headers[5] as string}>
            <GoalProgress goal={goal} t={t} />
          </Cell>,
          <Cell key="period" label={headers[6] as string}>
            <GoalPeriod goal={goal} locale={locale} timeZone={timeZone} />
          </Cell>,
          <Cell key="status" label={headers[7] as string}>
            <GoalStatusChip status={goal.status} t={t} />
          </Cell>,
        ])}
      />
    </Card>
  );
}

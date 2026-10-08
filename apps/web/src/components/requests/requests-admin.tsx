'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';

import { fetchMany } from '../../lib/api-client';
import {
  ALL_STATUSES,
  apiQueryForInboxFilters,
  categoryKey,
  DEFAULT_INBOX_FILTERS,
  inboxFiltersFromParams,
  isNarrowed,
  REQUEST_CATEGORIES,
  REQUEST_STATUSES,
  requestPath,
  requesterName,
  searchForInboxFilters,
  statusKey,
} from '../../lib/requests';
import type { InboxFilters, RequestItem, RequestStatus } from '../../lib/requests';
import { Button, Card, DataTable, EmptyState, Field, Input, Select } from '../design-system';
import { loadSession } from '../employees/use-session';
import type { SessionView } from '../employees/use-session';
import { Cell, ErrorState, LoadingState, Pagination } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';

import {
  RequestAge,
  RequestCategoryChip,
  RequestStatusChip,
  RequestSummary,
  SubmittedOn,
} from './requests-shared';

/**
 * `/{locale}/admin/requests` — DOCUMENT 04 B13, the unified inbox.
 *
 * Category tabs (All / Attendance / Leave / Salary / Task / General) and a
 * status filter that defaults to Pending; employee and submission-date
 * filters; the page. All of it lives in the URL. Row: employee, category chip,
 * summary, submitted date, age indicator, status. The list is `GET /requests`
 * under the caller's own scope — a manager sees their team (and their own,
 * which they cannot decide). Below 1024px the table becomes stacked cards
 * (DOCUMENT 22).
 */

const PER_PAGE = 20;
/** DOCUMENT 08 §1's maximum page — the employee filter's options. */
const OPTIONS_PAGE_SIZE = '100';

export function RequestsAdmin({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const router = useRouter();
  const pathname = usePathname() ?? `/${locale}/admin/requests`;
  const searchParams = useSearchParams();
  const filters = inboxFiltersFromParams(new URLSearchParams(searchParams?.toString() ?? ''));
  const search = searchForInboxFilters(filters);

  const navigate = (next: InboxFilters): void => {
    router.replace(`${pathname}${searchForInboxFilters(next)}`, { scroll: false });
  };
  const change = (patch: Partial<InboxFilters>): void => {
    navigate({ ...filters, ...patch, page: 1 });
  };
  const reset = (): void => {
    navigate({ ...DEFAULT_INBOX_FILTERS, category: filters.category });
  };

  const load = useCallback(
    (signal: AbortSignal) =>
      fetchMany<RequestItem>('/requests', {
        locale,
        signal,
        query: apiQueryForInboxFilters(
          inboxFiltersFromParams(new URLSearchParams(search.slice(1))),
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
  // A filter is a convenience: if its options fail to load, the screen still
  // works with "all employees" rather than failing outright.
  const loadEmployees = useCallback(
    (signal: AbortSignal) =>
      fetchMany<{ id: string; first_name: string; last_name: string }>('/employees', {
        locale,
        signal,
        query: { per_page: OPTIONS_PAGE_SIZE, sort: 'name' },
      }).catch(() => null),
    [locale],
  );
  const employees = useResource(loadEmployees);
  const employeeOptions =
    employees.state.status === 'ready' ? (employees.state.value?.items ?? []) : [];
  const zone = session.state.status === 'ready' ? session.state.value.timeZone : 'UTC';

  return (
    <>
      <nav className="tabs" aria-label={t('requests.tabs_label')}>
        {(['', ...REQUEST_CATEGORIES] as const).map((category) => (
          <Link
            key={category === '' ? 'all' : category}
            href={`${pathname}${searchForInboxFilters({ ...filters, category, page: 1 })}`}
            className={filters.category === category ? 'is-active' : undefined}
            {...(filters.category === category ? { 'aria-current': 'page' as const } : {})}
            scroll={false}
          >
            {category === '' ? t('requests.tab_all') : t(categoryKey(category))}
          </Link>
        ))}
      </nav>

      <div className="tasks-toolbar">
        <section className="tasks-filters is-open" aria-label={t('requests.filters')}>
          <Field label={t('requests.field_status')}>
            <Select
              value={filters.status === '' ? ALL_STATUSES : filters.status}
              onChange={(event) => {
                const value = event.target.value;
                change({ status: value === ALL_STATUSES ? '' : (value as RequestStatus) });
              }}
            >
              {REQUEST_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {t(statusKey(status))}
                </option>
              ))}
              <option value={ALL_STATUSES}>{t('requests.all_statuses')}</option>
            </Select>
          </Field>
          <Field label={t('requests.field_employee')}>
            <Select
              value={filters.employee}
              onChange={(event) => {
                change({ employee: event.target.value });
              }}
            >
              <option value="">{t('requests.all_employees')}</option>
              {employeeOptions.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {`${employee.first_name} ${employee.last_name}`.trim()}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('requests.field_from')}>
            <Input
              type="date"
              value={filters.from}
              onChange={(event) => {
                change({ from: event.target.value });
              }}
            />
          </Field>
          <Field label={t('requests.field_to')}>
            <Input
              type="date"
              value={filters.to}
              min={filters.from === '' ? undefined : filters.from}
              onChange={(event) => {
                change({ to: event.target.value });
              }}
            />
          </Field>
          {isNarrowed(filters) ? (
            <Button variant="ghost" onClick={reset}>
              {t('requests.clear_filters')}
            </Button>
          ) : null}
        </section>
      </div>

      {listing.state.status === 'loading' ? <LoadingState t={t} rows={8} /> : null}
      {listing.state.status === 'error' ? (
        <ErrorState error={listing.state.error} t={t} onRetry={listing.reload} />
      ) : null}
      {listing.state.status === 'ready' ? (
        listing.state.value.items.length === 0 ? (
          isNarrowed(filters) ? (
            <EmptyState
              title={t('requests.filtered_empty_title')}
              description={t('requests.filtered_empty_description')}
              action={
                <Button variant="secondary" onClick={reset}>
                  {t('requests.clear_filters')}
                </Button>
              }
            />
          ) : (
            <EmptyState
              title={t('requests.inbox_empty_title')}
              description={t('requests.inbox_empty_description')}
              action={null}
            />
          )
        ) : (
          <>
            <RequestTable
              items={listing.state.value.items}
              locale={locale}
              t={t}
              timeZone={zone}
              surface="admin"
            />
            <Pagination
              page={listing.state.value.meta.page}
              totalPages={listing.state.value.meta.total_pages}
              hrefForPage={(page) => `${pathname}${searchForInboxFilters({ ...filters, page })}`}
              t={t}
            />
          </>
        )
      ) : null}
    </>
  );
}

/** DOCUMENT 04 B13's row, in its order. Shared by the inbox and "My requests". */
export function RequestTable({
  items,
  locale,
  t,
  timeZone,
  surface,
}: {
  readonly items: readonly RequestItem[];
  readonly locale: Locale;
  readonly t: Translator;
  readonly timeZone: string;
  readonly surface: 'admin' | 'app';
}): React.JSX.Element {
  const showEmployee = surface === 'admin';
  const headers = [
    ...(showEmployee ? [t('requests.col_employee')] : []),
    t('requests.col_category'),
    t('requests.col_summary'),
    t('requests.col_submitted'),
    t('requests.col_status'),
  ];
  const label = (index: number): string => headers[showEmployee ? index : index - 1] as string;
  return (
    <Card className="tasks-table">
      <DataTable
        headers={headers}
        rows={items.map((item) => [
          ...(showEmployee
            ? [
                <Cell key="employee" label={label(0)}>
                  {requesterName(item)}
                </Cell>,
              ]
            : []),
          <Cell key="category" label={label(1)}>
            <RequestCategoryChip category={item.category} t={t} />
          </Cell>,
          <Cell key="summary" label={label(2)}>
            <Link className="tasks-title-link" href={requestPath(locale, item.id, surface)}>
              <RequestSummary item={item} locale={locale} t={t} timeZone={timeZone} />
            </Link>
          </Cell>,
          <Cell key="submitted" label={label(3)}>
            <span className="requests-submitted">
              <SubmittedOn item={item} locale={locale} timeZone={timeZone} />
              <RequestAge item={item} t={t} timeZone={timeZone} />
            </span>
          </Cell>,
          <Cell key="status" label={label(4)}>
            <RequestStatusChip status={item.status} t={t} />
          </Cell>,
        ])}
      />
    </Card>
  );
}

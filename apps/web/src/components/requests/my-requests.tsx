'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { fetchMany } from '../../lib/api-client';
import { newRequestPath } from '../../lib/requests';
import type { RequestItem } from '../../lib/requests';
import { EmptyState } from '../design-system';
import { loadSession } from '../employees/use-session';
import { ErrorState, LoadingState, Pagination, SuccessNotice } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';

import { RequestTable } from './requests-admin';

/**
 * `/{locale}/app/requests` — DOCUMENT 04 C8 "My requests": the caller's own
 * history with category, status and date, newest first.
 *
 * `GET /requests` narrowed to the caller's own employee record: an employee's
 * `self` scope is exactly that, and a manager's view would otherwise include
 * their team, which is the inbox's job, not this screen's.
 */

const PER_PAGE = 20;

export function MyRequests({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const pathname = usePathname() ?? `/${locale}/app/requests`;
  const params = new URLSearchParams(useSearchParams()?.toString() ?? '');
  const requested = Number(params.get('page'));
  const page = Number.isInteger(requested) && requested >= 1 ? requested : 1;
  const notice =
    params.get('notice') === 'cancelled'
      ? t('requests.cancelled_notice')
      : params.get('notice') === 'submitted'
        ? t('requests.submitted_notice')
        : null;

  const load = useCallback(
    async (signal: AbortSignal) => {
      const session = await loadSession(locale, signal);
      if (session.employeeId === null) {
        return { session, list: null };
      }
      const list = await fetchMany<RequestItem>('/requests', {
        locale,
        signal,
        query: {
          employee_id: session.employeeId,
          page: String(page),
          per_page: String(PER_PAGE),
        },
      });
      return { session, list };
    },
    [locale, page],
  );
  const resource = useResource(load);

  const submit = (
    <Link className="button button--primary button--md" href={newRequestPath(locale)}>
      {t('requests.new_request')}
    </Link>
  );

  if (resource.state.status === 'loading') {
    return <LoadingState t={t} rows={6} />;
  }
  if (resource.state.status === 'error') {
    return <ErrorState error={resource.state.error} t={t} onRetry={resource.reload} />;
  }
  const { session, list } = resource.state.value;
  if (list === null || list.items.length === 0) {
    return (
      <EmptyState
        title={t('requests.my_empty_title')}
        description={t('requests.my_empty_description')}
        action={list === null ? null : submit}
      />
    );
  }
  return (
    <>
      <SuccessNotice message={notice} t={t} />
      <div className="tasks-toolbar">{submit}</div>
      <RequestTable
        items={list.items}
        locale={locale}
        t={t}
        timeZone={session.timeZone}
        surface="app"
      />
      <Pagination
        page={list.meta.page}
        totalPages={list.meta.total_pages}
        hrefForPage={(next) => `${pathname}${next > 1 ? `?page=${String(next)}` : ''}`}
        t={t}
      />
    </>
  );
}

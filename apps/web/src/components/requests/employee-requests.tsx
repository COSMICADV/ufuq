'use client';

import { useCallback } from 'react';
import type { Locale, Translator } from '@ufuq/i18n';

import { fetchMany } from '../../lib/api-client';
import type { RequestItem } from '../../lib/requests';
import { EmptyState } from '../design-system';
import { ErrorState, LoadingState } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';

import { RequestTable } from './requests-admin';

/**
 * The employee profile's Requests tab — DOCUMENT 04 B4: "this employee's
 * requests with status".
 *
 * `GET /requests?employee_id=…`, AND-ed on the server with the caller's own
 * `request.view` scope. Every status is listed: decided requests are history.
 */

const PER_PAGE = '100';

export function EmployeeRequests({
  locale,
  t,
  employeeId,
  timeZone,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly employeeId: string;
  readonly timeZone: string;
}): React.JSX.Element {
  const load = useCallback(
    (signal: AbortSignal) =>
      fetchMany<RequestItem>('/requests', {
        locale,
        signal,
        query: { employee_id: employeeId, per_page: PER_PAGE },
      }),
    [locale, employeeId],
  );
  const resource = useResource(load);

  if (resource.state.status === 'loading') {
    return <LoadingState t={t} rows={4} />;
  }
  if (resource.state.status === 'error') {
    return <ErrorState error={resource.state.error} t={t} onRetry={resource.reload} />;
  }
  if (resource.state.value.items.length === 0) {
    return (
      <EmptyState
        title={t('employees.requests_empty_title')}
        description={t('employees.requests_empty')}
        action={null}
      />
    );
  }
  return (
    <RequestTable
      items={resource.state.value.items}
      locale={locale}
      t={t}
      timeZone={timeZone}
      surface="admin"
    />
  );
}

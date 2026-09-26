'use client';

import Link from 'next/link';
import { useCallback } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import type { Locale, Translator } from '@ufuq/i18n';

import { fetchMany } from '../../lib/api-client';
import type { CollectionResult } from '../../lib/api-client';
import { auditLogPath, entityHistoryPath } from '../../lib/audit';
import type { AuditEntry } from '../../lib/audit';
import { pageFromParams, withPage } from '../../lib/paging';
import { Alert, Card, EmptyState } from '../design-system';
import { AuditEntryItem } from '../settings/audit-entry';
import { ErrorState, LoadingState, Pagination } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';

/**
 * The employee history panel — DOCUMENT 21 "UI": "Entity history panels
 * appear on employee … detail screens, showing that record's audit trail
 * inline."
 *
 * Reads `GET /audit-logs/entity/employee/{id}` and nothing else — the
 * employee record's own trail. It is rendered only for a caller holding
 * `audit.view` (the profile decides), and the API refuses anyone else again.
 * Read-only: there is no control here that could change a record, because
 * there is no API that could.
 *
 * The page lives in the URL under its own key, so it cannot collide with
 * anything else on the profile and survives a refresh (DOCUMENT 11 §6).
 *
 * The task, payroll-line and product panels DOCUMENT 21 also describes
 * belong to the phases that build those screens.
 */

const PAGE_KEY = 'history_page';
const PER_PAGE = 10;

export function EmployeeHistory({
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
  const pathname = usePathname() ?? '';
  const searchParams = useSearchParams();
  const params = new URLSearchParams(searchParams?.toString() ?? '');
  const page = pageFromParams(params, PAGE_KEY);

  const load = useCallback(
    (signal: AbortSignal): Promise<CollectionResult<AuditEntry>> =>
      fetchMany<AuditEntry>(entityHistoryPath('employee', employeeId), {
        locale,
        signal,
        query: { page: String(page), per_page: String(PER_PAGE) },
      }),
    [locale, employeeId, page],
  );
  const { state, reload } = useResource(load);

  const fullLog = (
    <Link href={auditLogPath(locale, { entity_type: 'employee', entity_id: employeeId })}>
      {t('employees.history_full_log')}
    </Link>
  );

  return (
    <Card title={t('employees.history_title')} action={fullLog} className="employee-history">
      {state.status === 'loading' ? <LoadingState t={t} rows={4} /> : null}

      {state.status === 'error' ? (
        state.error.status === 403 ? (
          <Alert tone="warning" title={t('audit.forbidden_title')}>
            {t('audit.forbidden')}
          </Alert>
        ) : (
          <ErrorState error={state.error} t={t} onRetry={reload} />
        )
      ) : null}

      {state.status === 'ready' ? (
        state.value.items.length === 0 ? (
          <EmptyState
            title={t('employees.history_empty_title')}
            description={t('employees.history_empty')}
            action={null}
          />
        ) : (
          <>
            <ol className="audit-log">
              {state.value.items.map((entry) => (
                <AuditEntryItem
                  key={entry.id}
                  entry={entry}
                  locale={locale}
                  t={t}
                  timeZone={timeZone}
                  actorHref={auditLogPath(locale, { user_id: entry.actor.id })}
                />
              ))}
            </ol>
            <Pagination
              page={state.value.meta.page}
              totalPages={state.value.meta.total_pages}
              hrefForPage={(next) => `${pathname}${withPage(params, PAGE_KEY, next)}`}
              t={t}
            />
          </>
        )
      ) : null}
    </Card>
  );
}

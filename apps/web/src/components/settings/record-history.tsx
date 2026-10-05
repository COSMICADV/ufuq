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

import { AuditEntryItem } from './audit-entry';
import { ErrorState, LoadingState, Pagination } from './screen-states';
import { useResource } from './use-resource';

/**
 * A record's own history panel — DOCUMENT 21 "UI": "Entity history panels
 * appear on employee, task, payroll line, and product detail screens, showing
 * that record's audit trail inline."
 *
 * Reads `GET /audit-logs/entity/{type}/{id}` and nothing else. It is rendered
 * only for a caller holding `audit.view` (the screen decides), and the API
 * refuses anyone else again. Read-only: there is no control here that could
 * change a record, because there is no API that could.
 *
 * The page lives in the URL under its own key, so it cannot collide with
 * anything else on the screen and survives a refresh (DOCUMENT 11 §6).
 *
 * Written once for every record type (DOCUMENT 27 RULE 20): the employee
 * profile (Phase 5) and the task detail (Phase 7) each pass their own type
 * and wording.
 */

const PAGE_KEY = 'history_page';
const PER_PAGE = 10;

export function RecordHistory({
  locale,
  t,
  entityType,
  entityId,
  timeZone,
  title,
  fullLogLabel,
  emptyTitle,
  emptyDescription,
  className = '',
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly entityType: string;
  readonly entityId: string;
  readonly timeZone: string;
  readonly title: string;
  readonly fullLogLabel: string;
  readonly emptyTitle: string;
  readonly emptyDescription: string;
  readonly className?: string;
}): React.JSX.Element {
  const pathname = usePathname() ?? '';
  const searchParams = useSearchParams();
  const params = new URLSearchParams(searchParams?.toString() ?? '');
  const page = pageFromParams(params, PAGE_KEY);

  const load = useCallback(
    (signal: AbortSignal): Promise<CollectionResult<AuditEntry>> =>
      fetchMany<AuditEntry>(entityHistoryPath(entityType, entityId), {
        locale,
        signal,
        query: { page: String(page), per_page: String(PER_PAGE) },
      }),
    [locale, entityType, entityId, page],
  );
  const { state, reload } = useResource(load);

  const fullLog = (
    <Link href={auditLogPath(locale, { entity_type: entityType, entity_id: entityId })}>
      {fullLogLabel}
    </Link>
  );

  return (
    <Card title={title} action={fullLog} className={`record-history ${className}`}>
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
          <EmptyState title={emptyTitle} description={emptyDescription} action={null} />
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

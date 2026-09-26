'use client';

import Link from 'next/link';
import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { createTranslator } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';

import { fetchMany } from '../../lib/api-client';
import type { CollectionResult } from '../../lib/api-client';
import {
  actionKey,
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  auditQuery,
  EMPTY_FILTERS,
  entityTypeKey,
  filtersFromParams,
  hasFilters,
  shortId,
  withFilters,
} from '../../lib/audit';
import type { AuditEntry, AuditFilters } from '../../lib/audit';
import { DEFAULT_PER_PAGE, pageFromParams, withPage } from '../../lib/paging';
import { loadSession } from '../employees/use-session';
import { Alert, Button, Card, EmptyState, Field, Input, Select } from '../design-system';

import { AuditEntryItem } from './audit-entry';
import { ErrorState, LoadingState, Ltr, Pagination } from './screen-states';
import { SettingsHeading } from './settings-shell';
import { useResource } from './use-resource';

/**
 * `/{locale}/admin/settings/audit-log` — DOCUMENT 21 "UI", DOCUMENT 04 (settings,
 * "Audit log: filterable audit trail, read-only").
 *
 * **Read-only.** There is no control on this screen that writes anything,
 * because there is no API that could (DOCUMENT 21: "no API, no admin screen …
 * modifies an audit record").
 *
 * Each record is **a human-readable sentence** — "سجّل أحمد محمد الحضور" — with an
 * expandable technical view of the old and new values. The sentence templates
 * put `{actor}` wherever the language wants it, so Arabic reads verb-first
 * rather than as an English sentence with Arabic words in it.
 *
 * Every documented filter (user, record type, record id, action, date range —
 * DOCUMENT 21 "API requirements") lives in the URL (DOCUMENT 11 §6), so a
 * filtered view survives a refresh and can be linked to. User and record are
 * reached from an entry ("only this person's actions", "this record's
 * history") rather than from a picker: the log already names every actor and
 * record worth filtering by.
 *
 * Out of scope here, deliberately: DOCUMENT 21's **entity history panels** on
 * task, payroll-line and product screens — those screens belong to later
 * phases. `GET /audit-logs/entity/{type}/{id}` exists for them, and this screen
 * reaches the same history through its record filter.
 */

const PAGE_KEY = 'page';

interface ScreenData {
  readonly timeZone: string;
  readonly log: CollectionResult<AuditEntry>;
}

export function AuditLog({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const router = useRouter();
  const pathname = usePathname() ?? '';
  const searchParams = useSearchParams();
  const params = new URLSearchParams(searchParams?.toString() ?? '');
  const page = pageFromParams(params, PAGE_KEY);
  const filters = filtersFromParams(params);
  const query = JSON.stringify(auditQuery(filters, page, DEFAULT_PER_PAGE));

  const load = useCallback(
    async (signal: AbortSignal): Promise<ScreenData> => {
      const [session, log] = await Promise.all([
        loadSession(locale, signal),
        fetchMany<AuditEntry>('/audit-logs', {
          locale,
          signal,
          query: JSON.parse(query) as Record<string, string>,
        }),
      ]);
      return { timeZone: session.timeZone, log };
    },
    [locale, query],
  );
  const { state, reload } = useResource<ScreenData>(load);

  const hrefFor = (next: AuditFilters): string => `${pathname}${withFilters(params, next)}`;

  const heading = (
    <SettingsHeading title={t('settings.audit_log')} description={t('audit.read_only')} />
  );

  const filterForm = (
    <AuditFilterForm
      key={query}
      t={t}
      filters={filters}
      onApply={(next) => {
        router.push(hrefFor(next));
      }}
      clearHref={hrefFor(EMPTY_FILTERS)}
      removeUserHref={hrefFor({ ...filters, user_id: '' })}
    />
  );

  if (state.status === 'loading') {
    return (
      <>
        {heading}
        {filterForm}
        <LoadingState t={t} rows={6} />
      </>
    );
  }

  if (state.status === 'error') {
    const { error } = state;
    return (
      <>
        {heading}
        {error.status === 403 ? (
          <Alert tone="warning" title={t('audit.forbidden_title')}>
            {t('audit.forbidden')}
          </Alert>
        ) : error.status === 422 ? (
          <>
            {filterForm}
            <Alert tone="danger" title={t('audit.invalid_filters_title')}>
              {t('audit.invalid_filters')}
            </Alert>
          </>
        ) : (
          <>
            {filterForm}
            <ErrorState error={error} t={t} onRetry={reload} />
          </>
        )}
      </>
    );
  }

  const { log, timeZone } = state.value;
  const filtered = hasFilters(filters);

  return (
    <>
      {heading}
      {filterForm}

      {log.items.length === 0 ? (
        filtered ? (
          <EmptyState
            title={t('audit.no_match_title')}
            description={t('audit.no_match_description')}
            action={<Link href={hrefFor(EMPTY_FILTERS)}>{t('audit.clear')}</Link>}
          />
        ) : (
          <EmptyState
            title={t('audit.empty_title')}
            description={t('audit.empty_description')}
            action={null}
          />
        )
      ) : (
        <Card title={t('settings.audit_log')}>
          <ol className="audit-log">
            {log.items.map((entry) => (
              <AuditEntryItem
                key={entry.id}
                entry={entry}
                locale={locale}
                t={t}
                timeZone={timeZone}
                actorHref={hrefFor({ ...filters, user_id: entry.actor.id })}
                recordHref={hrefFor({
                  ...filters,
                  entity_type: entry.entity_type,
                  entity_id: entry.entity_id,
                })}
              />
            ))}
          </ol>
          <Pagination
            page={log.meta.page}
            totalPages={log.meta.total_pages}
            hrefForPage={(next) => `${pathname}${withPage(params, PAGE_KEY, next)}`}
            t={t}
          />
        </Card>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/**
 * Uncontrolled, and re-mounted (`key`) whenever the URL's filters change, so
 * the form always starts from what the URL says without mirroring it in state.
 */
function AuditFilterForm({
  t,
  filters,
  onApply,
  clearHref,
  removeUserHref,
}: {
  readonly t: Translator;
  readonly filters: AuditFilters;
  readonly onApply: (filters: AuditFilters) => void;
  readonly clearHref: string;
  readonly removeUserHref: string;
}): React.JSX.Element {
  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const read = (key: string): string => String(data.get(key) ?? '').trim();
    onApply({
      user_id: filters.user_id,
      entity_type: read('entity_type'),
      entity_id: read('entity_id'),
      action: read('action'),
      from: read('from'),
      to: read('to'),
    });
  };

  return (
    <Card title={t('audit.filters')}>
      <form className="audit-filters" onSubmit={submit} noValidate>
        <Field label={t('audit.action_label')}>
          <Select name="action" defaultValue={filters.action}>
            <option value="">{t('audit.all_actions')}</option>
            {AUDIT_ACTIONS.map((action) => (
              <option key={action} value={action}>
                {t(actionKey(action), { actor: t('audit.someone') })}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('audit.entity_type_label')}>
          <Select name="entity_type" defaultValue={filters.entity_type}>
            <option value="">{t('audit.all_entity_types')}</option>
            {AUDIT_ENTITY_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(entityTypeKey(type))}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('audit.entity_id_label')} helper={t('audit.entity_id_helper')}>
          <Input name="entity_id" dir="ltr" defaultValue={filters.entity_id} maxLength={36} />
        </Field>
        <Field label={t('audit.from')}>
          <Input name="from" type="date" dir="ltr" defaultValue={filters.from} />
        </Field>
        <Field label={t('audit.to')}>
          <Input name="to" type="date" dir="ltr" defaultValue={filters.to} />
        </Field>

        <div className="audit-filters__actions">
          <Button type="submit">{t('audit.apply')}</Button>
          <Link href={clearHref}>{t('audit.clear')}</Link>
        </div>

        {filters.user_id === '' ? null : (
          <p className="audit-filters__active">
            <span>{t('audit.user_filter')}</span> <Ltr>{shortId(filters.user_id)}</Ltr>{' '}
            <Link href={removeUserHref}>{t('audit.remove_filter')}</Link>
          </p>
        )}
      </form>
    </Card>
  );
}

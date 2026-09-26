'use client';

import Link from 'next/link';
import type { Locale, Translator } from '@ufuq/i18n';

import {
  actionKey,
  entityTypeKey,
  fieldChanges,
  isKnownAction,
  isKnownEntityType,
  shortId,
} from '../../lib/audit';
import type { AuditEntry } from '../../lib/audit';

import { Ltr } from './screen-states';

/**
 * One audit record, drawn one way wherever it appears — DOCUMENT 21 "UI": a
 * human-readable sentence, and an expandable technical view of the old and
 * new values. Shared by the audit log screen and the entity history panels
 * (DOCUMENT 27 RULE 20), so an entry cannot read differently in the two.
 */

function actorLabel(entry: AuditEntry, t: Translator): string {
  if (entry.actor.is_system) return t('audit.system_actor');
  return entry.actor.name ?? entry.actor.email;
}

function sentence(entry: AuditEntry, t: Translator): string {
  const actor = actorLabel(entry, t);
  return isKnownAction(entry.action)
    ? t(actionKey(entry.action), { actor })
    : t('audit.unknown_action', { actor, action: entry.action });
}

function formatInstant(instant: string, locale: Locale, timeZone: string): string {
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-GB', {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(instant));
}

/** The literal the API sends in place of a withheld salary value. */
const REDACTED = '[redacted]';

function ChangeValue({
  value,
  t,
}: {
  readonly value: string | null;
  readonly t: Translator;
}): React.JSX.Element {
  if (value === null) return <span className="audit-value--empty">{t('audit.empty_value')}</span>;
  if (value === REDACTED) return <em>{t('audit.redacted')}</em>;
  return <Ltr>{value}</Ltr>;
}

export function AuditEntryItem({
  entry,
  locale,
  t,
  timeZone,
  actorHref,
  recordHref,
}: {
  readonly entry: AuditEntry;
  readonly locale: Locale;
  readonly t: Translator;
  readonly timeZone: string;
  /** Where "only this person's actions" leads; omitted where it would add nothing. */
  readonly actorHref?: string;
  /** Where "this record's history" leads; omitted inside that record's own panel. */
  readonly recordHref?: string;
}): React.JSX.Element {
  const changes = fieldChanges(entry.old_values, entry.new_values);
  const recordType = isKnownEntityType(entry.entity_type)
    ? t(entityTypeKey(entry.entity_type))
    : entry.entity_type;

  return (
    <li className="audit-entry">
      <p className="audit-entry__sentence">{sentence(entry, t)}</p>
      <p className="audit-entry__meta">
        <time dateTime={entry.created_at}>
          <Ltr>{formatInstant(entry.created_at, locale, timeZone)}</Ltr>
        </time>
        <span>
          {t('audit.record')}: {recordType} <Ltr>{shortId(entry.entity_id)}</Ltr>
        </span>
        {recordHref === undefined ? null : (
          <Link href={recordHref}>{t('audit.record_history')}</Link>
        )}
        {actorHref === undefined ? null : (
          <Link href={actorHref}>{t('audit.filter_by_actor')}</Link>
        )}
      </p>

      <details className="audit-entry__details">
        <summary>{t('audit.details')}</summary>
        {changes.length === 0 ? (
          <p>{t('audit.no_values')}</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('audit.field')}</th>
                  <th scope="col">{t('audit.before')}</th>
                  <th scope="col">{t('audit.after')}</th>
                </tr>
              </thead>
              <tbody>
                {changes.map((change) => (
                  <tr key={change.field}>
                    <th scope="row">
                      <Ltr>{change.field}</Ltr>
                    </th>
                    <td>
                      <ChangeValue value={change.before} t={t} />
                    </td>
                    <td>
                      <ChangeValue value={change.after} t={t} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <dl className="audit-entry__technical">
          <dt>{t('audit.action_code')}</dt>
          <dd>
            <Ltr>{entry.action}</Ltr>
          </dd>
          <dt>{t('audit.record')}</dt>
          <dd>
            <Ltr>
              {entry.entity_type} {entry.entity_id}
            </Ltr>
          </dd>
          <dt>{t('audit.actor')}</dt>
          <dd>
            <Ltr>{entry.actor.email}</Ltr>
          </dd>
          <dt>{t('audit.ip_address')}</dt>
          <dd>
            {entry.ip_address === null ? t('audit.not_captured') : <Ltr>{entry.ip_address}</Ltr>}
          </dd>
          <dt>{t('audit.user_agent')}</dt>
          <dd>
            {entry.user_agent === null ? t('audit.not_captured') : <Ltr>{entry.user_agent}</Ltr>}
          </dd>
        </dl>
      </details>
    </li>
  );
}

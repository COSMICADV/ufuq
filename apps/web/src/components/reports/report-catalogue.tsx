'use client';

import Link from 'next/link';
import { useCallback } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { reportPath, visibleGroups } from '../../lib/reports';
import { Alert } from '../design-system';
import { loadSession } from '../employees/use-session';
import { ErrorState, LoadingState } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';

/**
 * `/admin/reports` — DOCUMENT 04 B17: report cards grouped Financial ·
 * Attendance · Tasks & Goals · Inventory, each with a title and a one-line
 * description, linking to the viewer. A card is shown only for a report the
 * caller may read (a manager sees the four people reports); the server
 * checks again on every request.
 */
export function ReportCatalogue({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const load = useCallback((signal: AbortSignal) => loadSession(locale, signal), [locale]);
  const session = useResource(load);

  if (session.state.status === 'loading') return <LoadingState t={t} rows={6} />;
  if (session.state.status === 'error') {
    return <ErrorState error={session.state.error} t={t} onRetry={session.reload} />;
  }
  const groups = visibleGroups(session.state.value.permissions);
  if (groups.length === 0) {
    return (
      <Alert tone="danger" title={t('state.action_blocked')}>
        {t('error.forbidden')}
      </Alert>
    );
  }
  return (
    <nav className="report-catalogue" aria-label={t('reports.catalogue_label')}>
      {groups.map((group) => (
        <section key={group.key} className="report-catalogue__group">
          <h2>{t(`reports.group.${group.key}`)}</h2>
          <ul>
            {group.reports.map((key) => (
              <li key={key}>
                <Link className="report-card" href={reportPath(locale, key)}>
                  <span className="report-card__icon" aria-hidden="true">
                    {ICONS[key]}
                  </span>
                  <span className="report-card__text">
                    <strong>{t(`reports.key.${key}.title`)}</strong>
                    <span>{t(`reports.key.${key}.description`)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </nav>
  );
}

/** A plain glyph per report; the visual redesign brings the real icon set. */
const ICONS: Readonly<Record<string, string>> = {
  attendance: '◷',
  performance: '◎',
  tasks: '☑',
  goals: '◆',
  payroll: '¤',
  inventory: '▦',
  warehouse: '⌂',
  'stock-movements': '⇄',
};

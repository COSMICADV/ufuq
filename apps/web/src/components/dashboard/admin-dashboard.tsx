'use client';

import { useCallback } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { Alert } from '../design-system';
import { loadSession } from '../employees/use-session';
import { ErrorState, LoadingState } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';
import { GoalProgressWidget } from '../goals/goal-progress-widget';
import { TasksNeedingReassignment } from '../tasks/tasks-needing-reassignment';

/**
 * `/{locale}/admin` — DOCUMENT 04 B1, the admin dashboard.
 *
 * Two widgets exist so far: DOCUMENT 13's "tasks needing reassignment" list
 * and, from Phase 8, B1 widget 6 "Goal progress". The other B1 widgets (KPI
 * rows, attendance and task overviews, requests, payroll, inventory, recent
 * activity, quick actions) are not
 * rendered as placeholders (DOCUMENT 27 RULE 26). They arrive with the
 * modules that own their data, mostly Phase 12.
 *
 * B1 gives the page to `report.company` (ADMIN) and `report.team` (MANAGER).
 * The widget's own data is `GET /tasks`, so the API applies the caller's
 * `task.view` scope again: a manager sees their team only.
 */
export function AdminDashboard({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const load = useCallback((signal: AbortSignal) => loadSession(locale, signal), [locale]);
  const session = useResource(load);

  if (session.state.status === 'loading') {
    return <LoadingState t={t} rows={6} />;
  }
  if (session.state.status === 'error') {
    return <ErrorState error={session.state.error} t={t} onRetry={session.reload} />;
  }
  const permissions = session.state.value.permissions;
  if (!permissions.has('report.company') && !permissions.has('report.team')) {
    return (
      <Alert tone="warning" title={t('state.action_blocked')}>
        {t('error.forbidden')}
      </Alert>
    );
  }

  return (
    <div className="dashboard-widgets">
      {permissions.has('task.view') ? (
        <TasksNeedingReassignment locale={locale} t={t} timeZone={session.state.value.timeZone} />
      ) : null}
      {permissions.has('goal.view') ? (
        <GoalProgressWidget locale={locale} t={t} timeZone={session.state.value.timeZone} />
      ) : null}
    </div>
  );
}

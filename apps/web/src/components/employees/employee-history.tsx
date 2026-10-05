'use client';

import type { Locale, Translator } from '@ufuq/i18n';

import { RecordHistory } from '../settings/record-history';

/**
 * The employee history panel — DOCUMENT 21 "UI", on the profile overview.
 *
 * Reads `GET /audit-logs/entity/employee/{id}`: the employee record's own
 * trail. User-account events such as logins have entity type `user` and are
 * not included. Rendered only for a caller holding `audit.view` (the profile
 * decides), and the API refuses anyone else again.
 *
 * The panel itself is `RecordHistory`, shared with the task detail screen.
 */
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
  return (
    <RecordHistory
      locale={locale}
      t={t}
      entityType="employee"
      entityId={employeeId}
      timeZone={timeZone}
      title={t('employees.history_title')}
      fullLogLabel={t('employees.history_full_log')}
      emptyTitle={t('employees.history_empty_title')}
      emptyDescription={t('employees.history_empty')}
      className="employee-history"
    />
  );
}

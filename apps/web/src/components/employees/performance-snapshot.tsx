'use client';

import { useCallback } from 'react';
import type { Locale, Translator } from '@ufuq/i18n';

import { fetchOne } from '../../lib/api-client';
import { COMPONENTS, scoreText } from '../../lib/performance';
import type { EmployeePerformance } from '../../lib/performance';
import { Card } from '../design-system';
import { ErrorState, LoadingState, Ltr } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';

/**
 * The employee profile's "performance snapshot" — DOCUMENT 04 B4 Overview,
 * DOCUMENT 14 "Performance".
 *
 * `GET /employees/{id}/performance` for the company's current month. Every
 * figure is the server's, computed from the company's configuration; a
 * component with no data reads "لا توجد بيانات" / "No data" — never 0%
 * (DOCUMENT 14 "Employees with no data"). The month is provisional until it
 * ends.
 */
export function PerformanceSnapshot({
  locale,
  t,
  employeeId,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly employeeId: string;
}): React.JSX.Element {
  const load = useCallback(
    (signal: AbortSignal) =>
      fetchOne<EmployeePerformance>(`/employees/${employeeId}/performance`, { locale, signal }),
    [locale, employeeId],
  );
  const resource = useResource(load);

  return (
    <Card title={t('performance.snapshot_title')}>
      {resource.state.status === 'loading' ? <LoadingState t={t} rows={3} /> : null}
      {resource.state.status === 'error' ? (
        <ErrorState error={resource.state.error} t={t} onRetry={resource.reload} />
      ) : null}
      {resource.state.status === 'ready' ? <Snapshot t={t} data={resource.state.value} /> : null}
    </Card>
  );
}

function Snapshot({
  t,
  data,
}: {
  readonly t: Translator;
  readonly data: EmployeePerformance;
}): React.JSX.Element {
  const score = (value: string | null): React.JSX.Element => {
    const text = scoreText(value);
    return text === null ? (
      <span className="tasks-muted">{t('performance.no_data')}</span>
    ) : (
      <Ltr>{text}</Ltr>
    );
  };
  return (
    <>
      <p className="tasks-muted">
        <Ltr>{data.month}</Ltr>
        {data.is_provisional ? ` — ${t('performance.provisional')}` : ''}
      </p>
      <dl className="tasks-facts">
        <div>
          <dt>{t('performance.overall')}</dt>
          <dd>{score(data.overall)}</dd>
        </div>
        {COMPONENTS.map((component) => (
          <div key={component}>
            <dt>{t(`performance.component.${component}`)}</dt>
            <dd>
              {score(data.components[component].score)}
              {data.components[component].effective_weight === null ? null : (
                <small className="tasks-muted">
                  {' '}
                  ({t('performance.weight_short')}{' '}
                  <Ltr>{data.components[component].effective_weight ?? ''}</Ltr>)
                </small>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </>
  );
}

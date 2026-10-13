'use client';

import Link from 'next/link';
import { useCallback } from 'react';
import type { Locale, Translator } from '@ufuq/i18n';

import { fetchOne } from '../../lib/api-client';
import { warehousePath } from '../../lib/warehouse';
import type { WarehouseDashboard } from '../../lib/warehouse';
import { Card } from '../design-system';
import { Figure } from '../payroll/payroll-shared';
import { ErrorState, LoadingState } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';
import { Amount, Quantity } from './warehouse-shared';

/**
 * The admin dashboard's way into the warehouse: locations, units and value in
 * stock, straight from `GET /warehouses/dashboard`. Loads, fails and retries
 * on its own. Rendered only for an ADMIN (warehouse and stock access).
 */
export function WarehouseSummaryWidget({
  locale,
  t,
  currency,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly currency: string;
}): React.JSX.Element {
  const load = useCallback(
    (signal: AbortSignal) =>
      fetchOne<WarehouseDashboard>('/warehouses/dashboard', { locale, signal }),
    [locale],
  );
  const resource = useResource(load);

  return (
    <Card
      title={t('warehouse.title')}
      className="tasks-reassignment"
      action={
        <Link className="tasks-back" href={warehousePath(locale)}>
          {t('warehouse.open_warehouse')}
        </Link>
      }
    >
      {resource.state.status === 'loading' ? <LoadingState t={t} rows={2} /> : null}
      {resource.state.status === 'error' ? (
        <ErrorState error={resource.state.error} t={t} onRetry={resource.reload} />
      ) : null}
      {resource.state.status === 'ready' ? (
        <div className="payroll-figures">
          <Figure label={t('warehouse.kpi_locations')}>
            <span dir="ltr">{resource.state.value.kpis.locations_active}</span>
          </Figure>
          <Figure label={t('warehouse.kpi_units')}>
            <Quantity value={resource.state.value.kpis.total_stock_units} />
          </Figure>
          <Figure label={t('warehouse.kpi_value')}>
            <Amount
              value={resource.state.value.kpis.total_inventory_value}
              currency={currency}
              locale={locale}
            />
          </Figure>
        </div>
      ) : null}
    </Card>
  );
}

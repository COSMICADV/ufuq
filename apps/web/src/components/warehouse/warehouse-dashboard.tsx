'use client';

import Link from 'next/link';
import { useCallback } from 'react';
import { createTranslator, formatDate } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';

import { fetchOne } from '../../lib/api-client';
import { inventoryPath, productPath, stockTone } from '../../lib/inventory';
import { localName, warehousePath } from '../../lib/warehouse';
import type { Movement, WarehouseDashboard as Dashboard } from '../../lib/warehouse';
import { Alert, Badge, Card, DataTable, EmptyState } from '../design-system';
import { loadSession } from '../employees/use-session';
import { Cell, ErrorState, LoadingState } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';
import { ActiveBadge, Amount, MovementBadge, Quantity, TypeBadge, When } from './warehouse-shared';

/**
 * `/admin/warehouse` — DOCUMENT 04 B19:
 * locations, units and value in stock (at average cost), stock by location,
 * recent movements and the 30-day movement trend.
 *
 * Phase 14 completed it: total products, the low-stock and out-of-stock
 * counts (on each product's total across locations) and the low-stock
 * table. `deferred` is empty; the notice for it shows only if the API ever
 * names something it cannot answer yet.
 */
export function WarehouseDashboard({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const load = useCallback(
    async (signal: AbortSignal) => {
      const [session, dashboard] = await Promise.all([
        loadSession(locale, signal),
        fetchOne<Dashboard>('/warehouses/dashboard', { locale, signal }),
      ]);
      return { session, dashboard };
    },
    [locale],
  );
  const resource = useResource(load);

  if (resource.state.status === 'loading') return <LoadingState t={t} rows={8} />;
  if (resource.state.status === 'error') {
    return <ErrorState error={resource.state.error} t={t} onRetry={resource.reload} />;
  }
  const { session, dashboard } = resource.state.value;
  const { kpis } = dashboard;
  const trendTotal = dashboard.activity_trend.reduce((sum, day) => sum + day.movements, 0);
  const trendMax = Math.max(1, ...dashboard.activity_trend.map((day) => day.movements));

  return (
    <>
      <div className="payroll-figures warehouse-kpis">
        <Card className="kpi">
          <span className="kpi__label">{t('warehouse.kpi_locations')}</span>
          <strong className="kpi__value" dir="ltr">
            {kpis.locations_total}
          </strong>
          <span className="kpi__delta">
            {t('warehouse.kpi_locations_active', { count: String(kpis.locations_active) })}
          </span>
        </Card>
        <Card className="kpi">
          <span className="kpi__label">{t('warehouse.kpi_total_products')}</span>
          <strong className="kpi__value" dir="ltr">
            {kpis.total_products}
          </strong>
          <span className="kpi__delta">
            {t('warehouse.kpi_in_stock_count', { count: String(kpis.products_in_stock) })}
          </span>
        </Card>
        <Card className="kpi">
          <span className="kpi__label">{t('warehouse.kpi_low_stock')}</span>
          <strong className="kpi__value" dir="ltr">
            {kpis.low_stock_count}
          </strong>
        </Card>
        <Card className="kpi">
          <span className="kpi__label">{t('warehouse.kpi_out_of_stock')}</span>
          <strong className="kpi__value" dir="ltr">
            {kpis.out_of_stock_count}
          </strong>
        </Card>
        <Card className="kpi">
          <span className="kpi__label">{t('warehouse.kpi_units')}</span>
          <strong className="kpi__value">
            <Quantity value={kpis.total_stock_units} />
          </strong>
        </Card>
        <Card className="kpi">
          <span className="kpi__label">{t('warehouse.kpi_value')}</span>
          <strong className="kpi__value">
            <Amount
              value={kpis.total_inventory_value}
              currency={session.currency}
              locale={locale}
            />
          </strong>
          <span className="kpi__delta">{t('warehouse.kpi_value_note')}</span>
        </Card>
      </div>

      {dashboard.deferred.length > 0 ? (
        <Alert tone="info" title={t('warehouse.deferred_title')}>
          {t('warehouse.deferred')}
        </Alert>
      ) : null}

      <Card
        title={t('warehouse.low_stock_table')}
        className="tasks-table warehouse-table"
        action={
          <Link className="tasks-back" href={inventoryPath(locale)}>
            {t('inventory.open_inventory')}
          </Link>
        }
      >
        {dashboard.low_stock.length === 0 ? (
          <EmptyState
            title={t('warehouse.no_low_stock_title')}
            description={t('warehouse.no_low_stock')}
            action={null}
          />
        ) : (
          <LowStockTable locale={locale} t={t} rows={dashboard.low_stock} />
        )}
      </Card>

      <Card title={t('warehouse.by_location')} className="tasks-table warehouse-table">
        {dashboard.by_location.length === 0 ? (
          <EmptyState
            title={t('warehouse.empty_locations_title')}
            description={t('warehouse.empty_locations')}
            action={
              <Link href={warehousePath(locale, 'locations')}>{t('warehouse.new_location')}</Link>
            }
          />
        ) : (
          <ByLocation locale={locale} t={t} dashboard={dashboard} currency={session.currency} />
        )}
      </Card>

      <Card title={t('warehouse.activity_trend')}>
        <p className="tasks-muted">
          {t('warehouse.activity_trend_total', { count: String(trendTotal) })}
        </p>
        <ol className="warehouse-trend" aria-label={t('warehouse.activity_trend')}>
          {dashboard.activity_trend.map((day) => (
            <li
              key={day.date}
              title={`${formatDate(new Date(`${day.date}T12:00:00Z`), { locale, timeZone: 'UTC' })}: ${String(day.movements)}`}
            >
              <span
                className="warehouse-trend__bar"
                style={{ blockSize: `${String(Math.floor((day.movements * 100) / trendMax))}%` }}
              />
            </li>
          ))}
        </ol>
      </Card>

      <Card title={t('warehouse.recent_movements')} className="tasks-table warehouse-table">
        {dashboard.recent_movements.length === 0 ? (
          <EmptyState
            title={t('warehouse.empty_movements_title')}
            description={t('warehouse.empty_movements')}
            action={null}
          />
        ) : (
          <MovementsTable
            locale={locale}
            t={t}
            movements={dashboard.recent_movements}
            timeZone={session.timeZone}
            showLocation
          />
        )}
      </Card>
    </>
  );
}

function LowStockTable({
  locale,
  t,
  rows,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly rows: Dashboard['low_stock'];
}): React.JSX.Element {
  const headers = [
    t('warehouse.col_product'),
    t('warehouse.col_sku'),
    t('inventory.col_total'),
    t('inventory.min_stock'),
    t('inventory.stock_status_label'),
  ];
  return (
    <DataTable
      headers={headers}
      rows={rows.map((row) => [
        <Cell key="name" label={headers[0] as string}>
          <Link href={productPath(locale, row.product.id)}>
            <span dir="auto">{localName(row.product, locale)}</span>
          </Link>
        </Cell>,
        <Cell key="sku" label={headers[1] as string}>
          <span dir="ltr">{row.product.sku}</span>
        </Cell>,
        <Cell key="total" label={headers[2] as string}>
          <Quantity value={row.total_quantity} unit={row.product.unit} />
        </Cell>,
        <Cell key="min" label={headers[3] as string}>
          <Quantity value={row.min_stock} />
        </Cell>,
        <Cell key="status" label={headers[4] as string}>
          <Badge tone={stockTone(row.stock_status)}>
            {t(`inventory.stock_status.${row.stock_status}`)}
          </Badge>
        </Cell>,
      ])}
    />
  );
}

function ByLocation({
  locale,
  t,
  dashboard,
  currency,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly dashboard: Dashboard;
  readonly currency: string;
}): React.JSX.Element {
  const headers = [
    t('warehouse.col_location'),
    t('warehouse.col_type'),
    t('warehouse.col_status'),
    t('warehouse.col_products'),
    t('warehouse.col_units'),
    t('warehouse.col_value'),
  ];
  return (
    <DataTable
      headers={headers}
      rows={dashboard.by_location.map((location) => [
        <Cell key="name" label={headers[0] as string}>
          <Link href={warehousePath(locale, 'locations', location.id)}>
            <span dir="auto">{localName(location, locale)}</span>
          </Link>
        </Cell>,
        <Cell key="type" label={headers[1] as string}>
          <TypeBadge type={location.type} t={t} />
        </Cell>,
        <Cell key="status" label={headers[2] as string}>
          <ActiveBadge active={location.is_active} t={t} />
        </Cell>,
        <Cell key="products" label={headers[3] as string}>
          <span dir="ltr">{location.product_count}</span>
        </Cell>,
        <Cell key="units" label={headers[4] as string}>
          <Quantity value={location.total_quantity} />
        </Cell>,
        <Cell key="value" label={headers[5] as string}>
          <Amount value={location.stock_value} currency={currency} locale={locale} />
        </Cell>,
      ])}
    />
  );
}

/** The ledger as a table — used by the dashboard and a location's detail page. */
export function MovementsTable({
  locale,
  t,
  movements,
  timeZone,
  showLocation,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly movements: readonly Movement[];
  readonly timeZone: string;
  readonly showLocation: boolean;
}): React.JSX.Element {
  const headers = [
    t('warehouse.col_date'),
    t('warehouse.col_movement'),
    t('warehouse.col_product'),
    ...(showLocation ? [t('warehouse.col_location')] : []),
    t('warehouse.col_quantity'),
    t('warehouse.col_balance_after'),
    t('warehouse.col_by'),
  ];
  return (
    <DataTable
      headers={headers}
      rows={movements.map((movement) => {
        let column = 0;
        const label = (): string => headers[column++] as string;
        return [
          <Cell key="date" label={label()}>
            <When value={movement.created_at} locale={locale} timeZone={timeZone} />
          </Cell>,
          <Cell key="type" label={label()}>
            <MovementBadge type={movement.type} t={t} />
          </Cell>,
          <Cell key="product" label={label()}>
            <span dir="auto">{localName(movement.product, locale)}</span>{' '}
            <span dir="ltr" className="tasks-muted">
              {movement.product.sku}
            </span>
          </Cell>,
          ...(showLocation
            ? [
                <Cell key="location" label={label()}>
                  <Link href={warehousePath(locale, 'locations', movement.warehouse.id)}>
                    <span dir="auto">{localName(movement.warehouse, locale)}</span>
                  </Link>
                </Cell>,
              ]
            : []),
          <Cell key="qty" label={label()}>
            <Quantity value={movement.quantity} unit={movement.product.unit} />
          </Cell>,
          <Cell key="balance" label={label()}>
            <Quantity value={movement.balance_after} />
          </Cell>,
          <Cell key="by" label={label()}>
            <span dir="ltr">{movement.created_by?.email ?? '—'}</span>
          </Cell>,
        ];
      })}
    />
  );
}

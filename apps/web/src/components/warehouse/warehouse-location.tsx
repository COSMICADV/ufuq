'use client';

import { useCallback, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { fetchMany, fetchOne } from '../../lib/api-client';
import { localName } from '../../lib/warehouse';
import type { Movement, StockRow, Warehouse } from '../../lib/warehouse';
import { Button, Card, DataTable, EmptyState } from '../design-system';
import { loadSession } from '../employees/use-session';
import { Cell, ErrorState, LoadingState, SuccessNotice } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';
import { MovementsTable } from './warehouse-dashboard';
import { LocationDialog, ToggleDialog } from './warehouse-locations';
import { ActiveBadge, Amount, loadAllStock, Quantity, TypeBadge } from './warehouse-shared';
import { TransferDialog } from './warehouse-transfers';

const MOVEMENTS_PER_PAGE = 25;

/**
 * `/admin/warehouse/locations/:id` — one location: what it holds (read from
 * the ledger, never edited), its movement history, and "transfer from here".
 * An inactive location keeps its history readable.
 */
export function WarehouseLocation({
  locale,
  warehouseId,
}: {
  readonly locale: Locale;
  readonly warehouseId: string;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const [page, setPage] = useState(1);
  const load = useCallback(
    async (signal: AbortSignal) => {
      const [session, warehouse, stock, movements, warehouses] = await Promise.all([
        loadSession(locale, signal),
        fetchOne<Warehouse>(`/warehouses/${warehouseId}`, { locale, signal }),
        loadAllStock(locale, warehouseId, signal),
        fetchMany<Movement>('/stock-movements', {
          locale,
          signal,
          query: {
            warehouse_id: warehouseId,
            page: String(page),
            per_page: String(MOVEMENTS_PER_PAGE),
          },
        }),
        fetchMany<Warehouse>('/warehouses', { locale, signal, query: { per_page: '100' } }),
      ]);
      return { session, warehouse, stock, movements, warehouses: warehouses.items };
    },
    [locale, warehouseId, page],
  );
  const resource = useResource(load);
  const [dialog, setDialog] = useState<'edit' | 'toggle' | 'transfer' | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (resource.state.status === 'loading') return <LoadingState t={t} rows={8} />;
  if (resource.state.status === 'error') {
    return <ErrorState error={resource.state.error} t={t} onRetry={resource.reload} />;
  }
  const { session, warehouse, stock, movements, warehouses } = resource.state.value;
  const canManage = session.permissions.has('warehouse.manage');
  const canTransfer = session.permissions.has('stock.transfer');
  const finished = (message: string): void => {
    setDialog(null);
    setDone(message);
    resource.reload();
  };

  return (
    <>
      <SuccessNotice message={done} t={t} />
      <Card
        title={localName(warehouse, locale)}
        action={
          <span className="warehouse-actions">
            <TypeBadge type={warehouse.type} t={t} />
            <ActiveBadge active={warehouse.is_active} t={t} />
          </span>
        }
      >
        <div className="payroll-figures">
          <div className="payroll-figure">
            <span className="payroll-figure__label">{t('warehouse.col_products')}</span>
            <strong className="payroll-figure__value" dir="ltr">
              {warehouse.product_count}
            </strong>
          </div>
          <div className="payroll-figure">
            <span className="payroll-figure__label">{t('warehouse.col_units')}</span>
            <strong className="payroll-figure__value">
              <Quantity value={warehouse.total_quantity} />
            </strong>
          </div>
          <div className="payroll-figure">
            <span className="payroll-figure__label">{t('warehouse.col_value')}</span>
            <strong className="payroll-figure__value">
              <Amount value={warehouse.stock_value} currency={session.currency} locale={locale} />
            </strong>
          </div>
          {warehouse.address === null ? null : (
            <div className="payroll-figure">
              <span className="payroll-figure__label">{t('warehouse.address')}</span>
              <span dir="auto">{warehouse.address}</span>
            </div>
          )}
        </div>
        <div className="tasks-toolbar">
          {canTransfer && warehouse.is_active && stock.length > 0 ? (
            <Button
              onClick={() => {
                setDone(null);
                setDialog('transfer');
              }}
            >
              {t('warehouse.transfer_from_here')}
            </Button>
          ) : null}
          {canManage ? (
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setDone(null);
                  setDialog('edit');
                }}
              >
                {t('warehouse.edit_location')}
              </Button>
              <Button
                variant={warehouse.is_active ? 'destructive-ghost' : 'secondary'}
                onClick={() => {
                  setDone(null);
                  setDialog('toggle');
                }}
              >
                {warehouse.is_active ? t('warehouse.deactivate') : t('warehouse.activate')}
              </Button>
            </>
          ) : null}
        </div>
      </Card>

      <Card title={t('warehouse.stock_title')} className="tasks-table warehouse-table">
        {stock.length === 0 ? (
          <EmptyState
            title={t('warehouse.empty_stock_title')}
            description={`${t('warehouse.empty_stock')} ${t('warehouse.no_products_note')}`}
            action={null}
          />
        ) : (
          <StockTable locale={locale} rows={stock} currency={session.currency} />
        )}
      </Card>

      <Card title={t('warehouse.movements_title')} className="tasks-table warehouse-table">
        {movements.items.length === 0 ? (
          <EmptyState
            title={t('warehouse.empty_movements_title')}
            description={t('warehouse.empty_movements')}
            action={null}
          />
        ) : (
          <>
            <MovementsTable
              locale={locale}
              t={t}
              movements={movements.items}
              timeZone={session.timeZone}
              showLocation={false}
            />
            {movements.meta.total_pages > 1 ? (
              <nav className="pagination" aria-label={t('settings.pagination')}>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => {
                    setPage(page - 1);
                  }}
                >
                  {t('action.previous')}
                </Button>
                <span>
                  {t('settings.page_of', {
                    page: String(page),
                    total: String(movements.meta.total_pages),
                  })}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={page >= movements.meta.total_pages}
                  onClick={() => {
                    setPage(page + 1);
                  }}
                >
                  {t('action.next')}
                </Button>
              </nav>
            ) : null}
          </>
        )}
      </Card>

      {dialog === 'edit' ? (
        <LocationDialog
          locale={locale}
          t={t}
          original={warehouse}
          onClose={() => {
            setDialog(null);
          }}
          onSaved={() => {
            finished(t('warehouse.location_saved'));
          }}
        />
      ) : null}
      {dialog === 'toggle' ? (
        <ToggleDialog
          locale={locale}
          t={t}
          warehouse={warehouse}
          onClose={() => {
            setDialog(null);
          }}
          onDone={(active) => {
            finished(active ? t('warehouse.activated') : t('warehouse.deactivated'));
          }}
        />
      ) : null}
      {dialog === 'transfer' ? (
        <TransferDialog
          locale={locale}
          t={t}
          warehouses={warehouses}
          initialSource={warehouse.id}
          onClose={() => {
            setDialog(null);
          }}
          onDone={() => {
            finished(t('warehouse.transfer_done'));
          }}
        />
      ) : null}
    </>
  );
}

function StockTable({
  locale,
  rows,
  currency,
}: {
  readonly locale: Locale;
  readonly rows: readonly StockRow[];
  readonly currency: string;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const headers = [
    t('warehouse.col_product'),
    t('warehouse.col_sku'),
    t('warehouse.col_quantity'),
    t('warehouse.col_average_cost'),
    t('warehouse.col_value'),
  ];
  return (
    <DataTable
      headers={headers}
      rows={rows.map((row) => [
        <Cell key="product" label={headers[0] as string}>
          <span dir="auto">{localName(row.product, locale)}</span>
        </Cell>,
        <Cell key="sku" label={headers[1] as string}>
          <span dir="ltr">{row.product.sku}</span>
        </Cell>,
        <Cell key="qty" label={headers[2] as string}>
          <Quantity value={row.quantity} unit={row.product.unit} />
        </Cell>,
        <Cell key="avg" label={headers[3] as string}>
          <Amount value={row.average_cost} currency={currency} locale={locale} />
        </Cell>,
        <Cell key="value" label={headers[4] as string}>
          <Amount value={row.stock_value} currency={currency} locale={locale} />
        </Cell>,
      ])}
    />
  );
}

'use client';

import { useCallback, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';

import { fetchMany, fetchOne } from '../../lib/api-client';
import { productName } from '../../lib/inventory';
import type { Product, ReconciliationReport } from '../../lib/inventory';
import { localName, MOVEMENT_TYPES, quantityLabel } from '../../lib/warehouse';
import type { Movement, Warehouse } from '../../lib/warehouse';
import { Alert, Button, Card, EmptyState, Field, Input, Select } from '../design-system';
import { loadSession } from '../employees/use-session';
import { describeError, ErrorState, LoadingState } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';
import { MovementsTable } from '../warehouse/warehouse-dashboard';
import { PageNav } from './inventory-shared';

const PER_PAGE = 25;

interface Filters {
  readonly product_id: string;
  readonly warehouse_id: string;
  readonly type: string;
  readonly from: string;
  readonly to: string;
}

const NO_FILTERS: Filters = { product_id: '', warehouse_id: '', type: '', from: '', to: '' };

/**
 * `/admin/inventory/movements` (every product) and
 * `/admin/inventory/:id/movements` (one product) — DOCUMENT 04 B24:
 * chronological, filterable by product, location, type and date range.
 * **Read-only**: no edit and no delete action exists anywhere (rule 2). The
 * all-products ledger also carries the reconciliation check (rule 3).
 */
export function MovementsLedger({
  locale,
  productId,
}: {
  readonly locale: Locale;
  readonly productId?: string;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const [filters, setFilters] = useState<Filters>({ ...NO_FILTERS, product_id: productId ?? '' });
  const [page, setPage] = useState(1);
  const loadContext = useCallback(
    async (signal: AbortSignal) => {
      const [session, warehouses, products] = await Promise.all([
        loadSession(locale, signal),
        fetchMany<Warehouse>('/warehouses', { locale, signal, query: { per_page: '100' } }),
        productId === undefined
          ? fetchMany<Product>('/products', {
              locale,
              signal,
              query: { per_page: '100', sort: 'sku' },
            })
          : fetchOne<Product>(`/products/${productId}`, { locale, signal }).then((p) => ({
              items: [p],
            })),
      ]);
      return { session, warehouses: warehouses.items, products: products.items };
    },
    [locale, productId],
  );
  const context = useResource(loadContext);
  const loadMovements = useCallback(
    (signal: AbortSignal) => {
      const query: Record<string, string> = { page: String(page), per_page: String(PER_PAGE) };
      for (const [key, value] of Object.entries(filters)) if (value !== '') query[key] = value;
      return fetchMany<Movement>('/stock-movements', { locale, signal, query });
    },
    [locale, filters, page],
  );
  const movements = useResource(loadMovements);
  const set = (patch: Partial<Filters>): void => {
    setFilters({ ...filters, ...patch });
    setPage(1);
  };

  if (context.state.status === 'loading') return <LoadingState t={t} rows={8} />;
  if (context.state.status === 'error') {
    return <ErrorState error={context.state.error} t={t} onRetry={context.reload} />;
  }
  const { session, warehouses, products } = context.state.value;
  const single = products[0];

  return (
    <>
      {productId !== undefined && single !== undefined ? (
        <h2 className="inventory-subtitle" dir="auto">
          {productName(single, locale)} <span dir="ltr">({single.sku})</span>
        </h2>
      ) : null}
      {productId === undefined && session.permissions.has('stock.movement_create') ? (
        <ReconciliationPanel locale={locale} t={t} />
      ) : null}
      <div className="inventory-filters">
        {productId === undefined ? (
          <Field label={t('inventory.col_product')}>
            <Select
              value={filters.product_id}
              onChange={(event) => {
                set({ product_id: event.target.value });
              }}
            >
              <option value="">{t('inventory.all')}</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {`${productName(p, locale)} (${p.sku})`}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <Field label={t('inventory.location')}>
          <Select
            value={filters.warehouse_id}
            onChange={(event) => {
              set({ warehouse_id: event.target.value });
            }}
          >
            <option value="">{t('inventory.all')}</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {localName(w, locale)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('inventory.movement_type')}>
          <Select
            value={filters.type}
            onChange={(event) => {
              set({ type: event.target.value });
            }}
          >
            <option value="">{t('inventory.all')}</option>
            {MOVEMENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`warehouse.movement.${type}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('inventory.from')}>
          <Input
            type="date"
            dir="ltr"
            value={filters.from}
            onChange={(event) => {
              set({ from: event.target.value });
            }}
          />
        </Field>
        <Field label={t('inventory.to')}>
          <Input
            type="date"
            dir="ltr"
            value={filters.to}
            onChange={(event) => {
              set({ to: event.target.value });
            }}
          />
        </Field>
      </div>
      <p className="tasks-muted">{t('inventory.ledger_readonly')}</p>
      {movements.state.status === 'loading' ? <LoadingState t={t} rows={8} /> : null}
      {movements.state.status === 'error' ? (
        <ErrorState error={movements.state.error} t={t} onRetry={movements.reload} />
      ) : null}
      {movements.state.status === 'ready' && movements.state.value.items.length === 0 ? (
        <EmptyState
          title={t('warehouse.empty_movements_title')}
          description={t('inventory.no_movements_filtered')}
          action={null}
        />
      ) : null}
      {movements.state.status === 'ready' && movements.state.value.items.length > 0 ? (
        <Card className="tasks-table warehouse-table">
          <MovementsTable
            locale={locale}
            t={t}
            movements={movements.state.value.items}
            timeZone={session.timeZone}
            showLocation
          />
          <PageNav
            page={page}
            totalPages={movements.state.value.meta.total_pages}
            onPage={setPage}
            t={t}
          />
        </Card>
      ) : null}
    </>
  );
}

/**
 * DOCUMENT 17 rule 3 / "Cache and ledger disagree": check the cache against
 * the ledger; rebuild from the ledger if they differ. Every run is audited.
 */
function ReconciliationPanel({
  locale,
  t,
}: {
  readonly locale: Locale;
  readonly t: Translator;
}): React.JSX.Element {
  const [report, setReport] = useState<ReconciliationReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (rebuild: boolean): void => {
    setBusy(true);
    setError(null);
    fetchOne<ReconciliationReport>('/inventory/reconciliation', {
      locale,
      method: 'POST',
      body: { rebuild },
    })
      .then(setReport)
      .catch((failure: unknown) => {
        setError(describeError(failure, t));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <Card title={t('inventory.reconciliation')}>
      <p className="tasks-muted">{t('inventory.reconciliation_help')}</p>
      <div className="tasks-toolbar">
        <Button
          variant="secondary"
          loading={busy}
          onClick={() => {
            run(false);
          }}
        >
          {t('inventory.reconcile_check')}
        </Button>
        {report !== null && report.mode === 'check' && report.mismatches.length > 0 ? (
          <Button
            variant="destructive"
            loading={busy}
            onClick={() => {
              run(true);
            }}
          >
            {t('inventory.reconcile_rebuild')}
          </Button>
        ) : null}
      </div>
      {error === null ? null : (
        <Alert tone="danger" title={t('requests.action_failed')}>
          {error}
        </Alert>
      )}
      {report === null ? null : report.mismatches.length === 0 &&
        report.chain_breaks.length === 0 ? (
        <Alert tone="success" title={t('inventory.reconcile_clean_title')}>
          {t('inventory.reconcile_clean', { count: String(report.balances_checked) })}
        </Alert>
      ) : (
        <Alert
          tone={report.mode === 'rebuild' ? 'success' : 'warning'}
          title={
            report.mode === 'rebuild'
              ? t('inventory.reconcile_rebuilt_title')
              : t('inventory.reconcile_mismatch_title')
          }
        >
          <ul className="warehouse-lines">
            {report.mismatches.map((m) => (
              <li key={`${m.product_id}-${m.warehouse_id}`}>
                <span dir="ltr">{m.sku}</span>
                {' — '}
                {t('inventory.reconcile_row', {
                  cached: m.cached_quantity === null ? '—' : quantityLabel(m.cached_quantity),
                  ledger: quantityLabel(m.ledger_quantity),
                  cached_cost: m.cached_average_cost ?? '—',
                  ledger_cost: m.ledger_average_cost,
                })}
              </li>
            ))}
          </ul>
          {report.chain_breaks.length > 0 ? (
            <p>{t('inventory.reconcile_chain', { count: String(report.chain_breaks.length) })}</p>
          ) : null}
        </Alert>
      )}
    </Card>
  );
}

'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { fetchMany } from '../../lib/api-client';
import {
  inventoryPath,
  PRODUCT_STATUSES,
  productName,
  productPath,
  STOCK_STATUSES,
} from '../../lib/inventory';
import type { Product } from '../../lib/inventory';
import { localName } from '../../lib/warehouse';
import { Card, DataTable, EmptyState, Field, Input, Select } from '../design-system';
import { loadSession } from '../employees/use-session';
import { Amount, Quantity } from '../warehouse/warehouse-shared';
import { Cell, ErrorState, LoadingState } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';
import {
  loadRefs,
  PageNav,
  ProductImage,
  ProductStatusBadge,
  StockBadge,
} from './inventory-shared';

const PER_PAGE = 25;

interface Filters {
  readonly search: string;
  readonly category_id: string;
  readonly warehouse_id: string;
  readonly supplier_id: string;
  readonly status: string;
  readonly stock_status: string;
  readonly sort: string;
}

const NO_FILTERS: Filters = {
  search: '',
  category_id: '',
  warehouse_id: '',
  supplier_id: '',
  status: '',
  stock_status: '',
  sort: 'name',
};

/**
 * `/admin/inventory` — DOCUMENT 04 B22: image, name, SKU, category, unit,
 * total quantity across locations, min stock, stock status chip, cost and
 * selling price. Filters: category, location, status, supplier; search on
 * name and SKU. Quantities are read from the ledger's cache — never edited.
 */
export function ProductsList({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [page, setPage] = useState(1);
  // The reference lists load once; the products reload with every filter, so
  // the filter controls never disappear while results are on their way.
  const loadRefsOnce = useCallback(
    async (signal: AbortSignal) => {
      const [session, refs] = await Promise.all([
        loadSession(locale, signal),
        loadRefs(locale, signal),
      ]);
      return { session, refs };
    },
    [locale],
  );
  const context = useResource(loadRefsOnce);
  const loadProducts = useCallback(
    (signal: AbortSignal) => {
      const query: Record<string, string> = { page: String(page), per_page: String(PER_PAGE) };
      for (const [key, value] of Object.entries(filters))
        if (value.trim() !== '') query[key] = value.trim();
      if (filters.sort === 'total_quantity_desc') {
        query.sort = 'total_quantity';
        query.order = 'desc';
      }
      return fetchMany<Product>('/products', { locale, signal, query });
    },
    [locale, filters, page],
  );
  const resource = useResource(loadProducts);
  const set = (patch: Partial<Filters>): void => {
    setFilters({ ...filters, ...patch });
    setPage(1);
  };

  const toolbar = (
    <div className="inventory-filters">
      <Field label={t('inventory.search')}>
        <Input
          type="search"
          value={filters.search}
          placeholder={t('inventory.search_placeholder')}
          onChange={(event) => {
            set({ search: event.target.value });
          }}
        />
      </Field>
      {context.state.status === 'ready' ? (
        <>
          <Field label={t('inventory.category')}>
            <Select
              value={filters.category_id}
              onChange={(event) => {
                set({ category_id: event.target.value });
              }}
            >
              <option value="">{t('inventory.all')}</option>
              {context.state.value.refs.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {localName(c, locale)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('inventory.location')}>
            <Select
              value={filters.warehouse_id}
              onChange={(event) => {
                set({ warehouse_id: event.target.value });
              }}
            >
              <option value="">{t('inventory.all')}</option>
              {context.state.value.refs.warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {localName(w, locale)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('inventory.supplier')}>
            <Select
              value={filters.supplier_id}
              onChange={(event) => {
                set({ supplier_id: event.target.value });
              }}
            >
              <option value="">{t('inventory.all')}</option>
              {context.state.value.refs.suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
        </>
      ) : null}
      <Field label={t('inventory.stock_status_label')}>
        <Select
          value={filters.stock_status}
          onChange={(event) => {
            set({ stock_status: event.target.value });
          }}
        >
          <option value="">{t('inventory.all')}</option>
          {STOCK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`inventory.stock_status.${s}`)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('inventory.status_label')}>
        <Select
          value={filters.status}
          onChange={(event) => {
            set({ status: event.target.value });
          }}
        >
          <option value="">{t('inventory.all')}</option>
          {PRODUCT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`inventory.status.${s}`)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('inventory.sort')}>
        <Select
          value={filters.sort}
          onChange={(event) => {
            set({ sort: event.target.value });
          }}
        >
          <option value="name">{t('inventory.sort_name')}</option>
          <option value="sku">{t('inventory.sort_sku')}</option>
          <option value="total_quantity">{t('inventory.sort_quantity_asc')}</option>
          <option value="total_quantity_desc">{t('inventory.sort_quantity_desc')}</option>
        </Select>
      </Field>
    </div>
  );

  if (context.state.status === 'error') {
    return <ErrorState error={context.state.error} t={t} onRetry={context.reload} />;
  }
  if (context.state.status === 'loading') return <LoadingState t={t} rows={8} />;
  const { session } = context.state.value;
  const products = resource.state.status === 'ready' ? resource.state.value : null;
  const filtered = Object.entries(filters).some(([key, value]) => key !== 'sort' && value !== '');
  const headers = [
    t('inventory.col_product'),
    t('warehouse.col_sku'),
    t('inventory.category'),
    t('inventory.unit'),
    t('inventory.col_total'),
    t('inventory.min_stock'),
    t('inventory.stock_status_label'),
    t('inventory.cost_price'),
    t('inventory.selling_price'),
  ];

  return (
    <>
      {session.permissions.has('product.create') ? (
        <div className="tasks-toolbar">
          <Link className="button button--primary button--md" href={inventoryPath(locale, 'new')}>
            <span>{t('inventory.new_product')}</span>
          </Link>
        </div>
      ) : null}
      {toolbar}
      {resource.state.status === 'error' ? (
        <ErrorState error={resource.state.error} t={t} onRetry={resource.reload} />
      ) : products === null ? (
        <LoadingState t={t} rows={8} />
      ) : products.items.length === 0 ? (
        <EmptyState
          title={filtered ? t('inventory.empty_filtered_title') : t('inventory.empty_title')}
          description={filtered ? t('inventory.empty_filtered') : t('inventory.empty')}
          action={null}
        />
      ) : (
        <Card className="tasks-table warehouse-table">
          <DataTable
            headers={headers}
            rows={products.items.map((product) => [
              <Cell key="name" label={headers[0] as string}>
                <span className="inventory-product-cell">
                  <ProductImage attachmentId={product.image_attachment_id} alt="" />
                  <Link href={productPath(locale, product.id)}>
                    <span dir="auto">{productName(product, locale)}</span>
                  </Link>
                  {product.status === 'discontinued' ? (
                    <ProductStatusBadge status={product.status} t={t} />
                  ) : null}
                </span>
              </Cell>,
              <Cell key="sku" label={headers[1] as string}>
                <span dir="ltr">{product.sku}</span>
              </Cell>,
              <Cell key="category" label={headers[2] as string}>
                <span dir="auto">
                  {product.category === null ? '—' : localName(product.category, locale)}
                </span>
              </Cell>,
              <Cell key="unit" label={headers[3] as string}>
                <span dir="auto">{product.unit}</span>
              </Cell>,
              <Cell key="total" label={headers[4] as string}>
                <Quantity value={product.total_quantity} />
              </Cell>,
              <Cell key="min" label={headers[5] as string}>
                <Quantity value={product.min_stock} />
              </Cell>,
              <Cell key="status" label={headers[6] as string}>
                <StockBadge status={product.stock_status} t={t} />
              </Cell>,
              <Cell key="cost" label={headers[7] as string}>
                <Amount value={product.cost_price} currency={session.currency} locale={locale} />
              </Cell>,
              <Cell key="price" label={headers[8] as string}>
                <Amount value={product.selling_price} currency={session.currency} locale={locale} />
              </Cell>,
            ])}
          />
          <PageNav page={page} totalPages={products.meta.total_pages} onPage={setPage} t={t} />
        </Card>
      )}
    </>
  );
}

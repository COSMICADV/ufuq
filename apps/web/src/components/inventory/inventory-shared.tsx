'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';

import { apiUrl, fetchMany } from '../../lib/api-client';
import { inventoryPath, stockTone } from '../../lib/inventory';
import type { Category, ProductStatus, StockStatus, Supplier } from '../../lib/inventory';
import type { Warehouse } from '../../lib/warehouse';
import { Badge, Button } from '../design-system';

/**
 * The frame every inventory screen sits in — DOCUMENT 03 §7's page
 * skeleton, with the inventory sections (products, movements, suppliers) as
 * links so each is addressable. Functional layout; the visual redesign comes
 * later.
 */
export function InventoryShell({
  locale,
  current,
  back,
  children,
}: {
  readonly locale: Locale;
  readonly current: 'products' | 'movements' | 'suppliers';
  readonly back?: { readonly href: string; readonly label: string };
  readonly children: ReactNode;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const sections: readonly ['products' | 'movements' | 'suppliers', string, string][] = [
    ['products', t('inventory.nav_products'), inventoryPath(locale)],
    ['movements', t('inventory.nav_movements'), inventoryPath(locale, 'movements')],
    ['suppliers', t('inventory.nav_suppliers'), inventoryPath(locale, 'suppliers')],
  ];
  return (
    <div className="tasks-page">
      <header className="page-heading">
        <div>
          <h1>{t('inventory.title')}</h1>
          <p>{t('inventory.description')}</p>
        </div>
        {back === undefined ? null : (
          <Link className="tasks-back" href={back.href}>
            {back.label}
          </Link>
        )}
      </header>
      <nav className="warehouse-nav" aria-label={t('inventory.nav_label')}>
        {sections.map(([key, label, href]) => (
          <Link
            key={key}
            href={href}
            className={key === current ? 'is-current' : ''}
            {...(key === current ? { 'aria-current': 'page' as const } : {})}
          >
            {label}
          </Link>
        ))}
      </nav>
      <main className="tasks-page__content">{children}</main>
    </div>
  );
}

export function StockBadge({
  status,
  t,
}: {
  readonly status: StockStatus;
  readonly t: Translator;
}): React.JSX.Element {
  return <Badge tone={stockTone(status)}>{t(`inventory.stock_status.${status}`)}</Badge>;
}

export function ProductStatusBadge({
  status,
  t,
}: {
  readonly status: ProductStatus;
  readonly t: Translator;
}): React.JSX.Element {
  return (
    <Badge tone={status === 'active' ? 'success' : 'cancelled'}>
      {t(`inventory.status.${status}`)}
    </Badge>
  );
}

/** The product image, served by the attachment store with its own access checks. */
export function ProductImage({
  attachmentId,
  alt,
  size = 'sm',
}: {
  readonly attachmentId: string | null;
  readonly alt: string;
  readonly size?: 'sm' | 'lg';
}): React.JSX.Element {
  if (attachmentId === null) {
    return (
      <span className={`inventory-image inventory-image--${size} is-empty`} aria-hidden="true" />
    );
  }
  return (
    // The file is behind the session cookie and the attachment policy, so it
    // is a plain request to the API, not Next's image optimiser.
    <img
      className={`inventory-image inventory-image--${size}`}
      src={apiUrl(`/attachments/${attachmentId}`)}
      alt={alt}
      loading="lazy"
    />
  );
}

/** Previous / next for a list kept in component state. Renders nothing for one page. */
export function PageNav({
  page,
  totalPages,
  onPage,
  t,
}: {
  readonly page: number;
  readonly totalPages: number;
  readonly onPage: (page: number) => void;
  readonly t: Translator;
}): React.JSX.Element | null {
  if (totalPages <= 1) return null;
  return (
    <nav className="pagination" aria-label={t('settings.pagination')}>
      <Button
        variant="ghost"
        size="sm"
        disabled={page <= 1}
        onClick={() => {
          onPage(page - 1);
        }}
      >
        {t('action.previous')}
      </Button>
      <span>{t('settings.page_of', { page: String(page), total: String(totalPages) })}</span>
      <Button
        variant="ghost"
        size="sm"
        disabled={page >= totalPages}
        onClick={() => {
          onPage(page + 1);
        }}
      >
        {t('action.next')}
      </Button>
    </nav>
  );
}

export interface CatalogueRefs {
  readonly categories: readonly Category[];
  readonly suppliers: readonly Supplier[];
  readonly warehouses: readonly Warehouse[];
}

/** The reference lists the product and movement forms choose from. */
export async function loadRefs(locale: Locale, signal: AbortSignal): Promise<CatalogueRefs> {
  const [categories, suppliers, warehouses] = await Promise.all([
    fetchMany<Category>('/product-categories', { locale, signal, query: { per_page: '100' } }),
    fetchMany<Supplier>('/suppliers', { locale, signal, query: { per_page: '100' } }),
    fetchMany<Warehouse>('/warehouses', { locale, signal, query: { per_page: '100' } }),
  ]);
  return { categories: categories.items, suppliers: suppliers.items, warehouses: warehouses.items };
}

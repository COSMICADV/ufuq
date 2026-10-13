'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { createTranslator, formatDateTime } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';

import { fetchMany } from '../../lib/api-client';
import { money, movementTone, quantityLabel, warehousePath } from '../../lib/warehouse';
import type { MovementType, StockRow, WarehouseSection, WarehouseType } from '../../lib/warehouse';
import { Badge } from '../design-system';

/**
 * The frame every warehouse screen sits in — DOCUMENT 03 §7's page skeleton,
 * with the three sections (overview, locations, transfers) as links so each
 * is addressable. Functional layout; the visual redesign comes later.
 */
export function WarehouseShell({
  locale,
  current,
  back,
  children,
}: {
  readonly locale: Locale;
  readonly current: 'dashboard' | WarehouseSection;
  readonly back?: { readonly href: string; readonly label: string };
  readonly children: ReactNode;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const sections: readonly ['dashboard' | WarehouseSection, string, string][] = [
    ['dashboard', t('warehouse.nav_dashboard'), warehousePath(locale)],
    ['locations', t('warehouse.nav_locations'), warehousePath(locale, 'locations')],
    ['transfers', t('warehouse.nav_transfers'), warehousePath(locale, 'transfers')],
  ];
  return (
    <div className="tasks-page">
      <header className="page-heading">
        <div>
          <h1>{t('warehouse.title')}</h1>
          <p>{t('warehouse.description')}</p>
        </div>
        {back === undefined ? null : (
          <Link className="tasks-back" href={back.href}>
            {back.label}
          </Link>
        )}
      </header>
      <nav className="warehouse-nav" aria-label={t('warehouse.nav_label')}>
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

/** A quantity, left-to-right inside any text, with its unit. Never rounded. */
export function Quantity({
  value,
  unit,
}: {
  readonly value: string;
  readonly unit?: string;
}): React.JSX.Element {
  return (
    <span dir="ltr" className="warehouse-quantity">
      {quantityLabel(value)}
      {unit === undefined ? null : <span className="warehouse-unit"> {unit}</span>}
    </span>
  );
}

export function Amount({
  value,
  currency,
  locale,
}: {
  readonly value: string;
  readonly currency: string;
  readonly locale: Locale;
}): React.JSX.Element {
  return (
    <span dir="ltr" className="payroll-amount">
      {money(value, currency, locale)}
    </span>
  );
}

export function TypeBadge({
  type,
  t,
}: {
  readonly type: WarehouseType;
  readonly t: Translator;
}): React.JSX.Element {
  return <Badge tone="info">{t(`warehouse.type.${type}`)}</Badge>;
}

export function ActiveBadge({
  active,
  t,
}: {
  readonly active: boolean;
  readonly t: Translator;
}): React.JSX.Element {
  return (
    <Badge tone={active ? 'success' : 'cancelled'}>
      {active ? t('warehouse.status_active') : t('warehouse.status_inactive')}
    </Badge>
  );
}

export function MovementBadge({
  type,
  t,
}: {
  readonly type: MovementType;
  readonly t: Translator;
}): React.JSX.Element {
  return <Badge tone={movementTone(type)}>{t(`warehouse.movement.${type}`)}</Badge>;
}

export function When({
  value,
  locale,
  timeZone,
}: {
  readonly value: string;
  readonly locale: Locale;
  readonly timeZone: string;
}): React.JSX.Element {
  return <span dir="ltr">{formatDateTime(new Date(value), { locale, timeZone })}</span>;
}

/**
 * Everything a location holds, every page of it — the transfer dialog lists
 * products from this, so none may be missing.
 */
export async function loadAllStock(
  locale: Locale,
  warehouseId: string,
  signal?: AbortSignal,
): Promise<StockRow[]> {
  const rows: StockRow[] = [];
  for (let page = 1; ; page++) {
    const result = await fetchMany<StockRow>(`/warehouses/${warehouseId}/stock`, {
      locale,
      query: { page: String(page), per_page: '100' },
      ...(signal === undefined ? {} : { signal }),
    });
    rows.push(...result.items);
    if (page >= result.meta.total_pages || result.items.length === 0) return rows;
  }
}

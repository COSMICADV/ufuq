'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';

import { fetchMany, fetchOne, uploadForm } from '../../lib/api-client';
import { productName, productPath } from '../../lib/inventory';
import type { ProductDetail } from '../../lib/inventory';
import { localName, warehousePath } from '../../lib/warehouse';
import type { Movement } from '../../lib/warehouse';
import { Alert, Button, Card, DataTable, EmptyState, Modal } from '../design-system';
import { loadSession } from '../employees/use-session';
import {
  Cell,
  describeError,
  ErrorState,
  LoadingState,
  SuccessNotice,
} from '../settings/screen-states';
import { useResource } from '../settings/use-resource';
import { MovementsTable } from '../warehouse/warehouse-dashboard';
import { Amount, Quantity, TypeBadge } from '../warehouse/warehouse-shared';
import { loadRefs, ProductImage, ProductStatusBadge, StockBadge } from './inventory-shared';
import { MovementDialog } from './movement-dialog';
import { EditProductDialog } from './product-form';

const RECENT = 5;

/**
 * `/admin/inventory/:id` — DOCUMENT 04 B23. Header: image, name, SKU, status,
 * total quantity. Sections: details, per-location stock, movement history,
 * supplier, pricing, valuation. Actions: edit, adjust stock (the movement
 * form), deactivate.
 *
 * **There is no editable quantity** — the only way stock changes from here is
 * "Record a movement", which posts an immutable movement.
 */
export function ProductDetailScreen({
  locale,
  productId,
}: {
  readonly locale: Locale;
  readonly productId: string;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const load = useCallback(
    async (signal: AbortSignal) => {
      const [session, product, movements, refs] = await Promise.all([
        loadSession(locale, signal),
        fetchOne<ProductDetail>(`/products/${productId}`, { locale, signal }),
        fetchMany<Movement>(`/products/${productId}/movements`, {
          locale,
          signal,
          query: { per_page: String(RECENT) },
        }),
        loadRefs(locale, signal),
      ]);
      return { session, product, movements, refs };
    },
    [locale, productId],
  );
  const resource = useResource(load);
  const [dialog, setDialog] = useState<'edit' | 'move' | 'status' | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  if (resource.state.status === 'loading') return <LoadingState t={t} rows={10} />;
  if (resource.state.status === 'error') {
    return <ErrorState error={resource.state.error} t={t} onRetry={resource.reload} />;
  }
  const { session, product, movements, refs } = resource.state.value;
  const can = (permission: string): boolean => session.permissions.has(permission);
  const finished = (message: string): void => {
    setDialog(null);
    setDone(message);
    resource.reload();
  };

  const upload = (file: File): void => {
    setUploading(true);
    setImageError(null);
    const body = new FormData();
    body.set('related_type', 'product');
    body.set('related_id', product.id);
    body.set('file', file);
    uploadForm<{ id: string }>('/attachments', body, { locale })
      .then((attachment) =>
        fetchOne<ProductDetail>(`/products/${product.id}`, {
          locale,
          method: 'PATCH',
          body: { image_attachment_id: attachment.id },
        }),
      )
      .then(() => {
        setUploading(false);
        finished(t('inventory.image_saved'));
      })
      .catch((failure: unknown) => {
        setUploading(false);
        setImageError(describeError(failure, t));
      });
  };

  return (
    <>
      <SuccessNotice message={done} t={t} />
      <Card>
        <div className="inventory-header">
          <ProductImage
            attachmentId={product.image_attachment_id}
            alt={productName(product, locale)}
            size="lg"
          />
          <div className="inventory-header__text">
            <h2 dir="auto">{productName(product, locale)}</h2>
            <p className="inventory-header__meta">
              <span dir="ltr">{product.sku}</span>
              <StockBadge status={product.stock_status} t={t} />
              <ProductStatusBadge status={product.status} t={t} />
            </p>
            <p className="inventory-header__total">
              {t('inventory.col_total')}:{' '}
              <Quantity value={product.total_quantity} unit={product.unit} />
            </p>
          </div>
        </div>
        {product.status === 'discontinued' ? (
          <Alert tone="warning" title={t('inventory.discontinued_title')}>
            {t('inventory.discontinued_body')}
          </Alert>
        ) : null}
        <div className="tasks-toolbar">
          {can('stock.movement_create') && product.status === 'active' ? (
            <Button
              onClick={() => {
                setDone(null);
                setDialog('move');
              }}
            >
              {t('inventory.record_movement')}
            </Button>
          ) : null}
          {can('product.update') ? (
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setDone(null);
                  setDialog('edit');
                }}
              >
                {t('inventory.edit_product')}
              </Button>
              <label className="button button--secondary button--md inventory-upload">
                <span>{uploading ? t('state.loading') : t('inventory.upload_image')}</span>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  disabled={uploading}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file !== undefined) upload(file);
                    event.target.value = '';
                  }}
                />
              </label>
              <Button
                variant={product.status === 'active' ? 'destructive-ghost' : 'secondary'}
                onClick={() => {
                  setDone(null);
                  setDialog('status');
                }}
              >
                {product.status === 'active' ? t('inventory.deactivate') : t('inventory.activate')}
              </Button>
            </>
          ) : null}
        </div>
        {imageError === null ? null : (
          <Alert tone="danger" title={t('requests.action_failed')}>
            {imageError}
          </Alert>
        )}
      </Card>

      <div className="inventory-sections">
        <Card title={t('inventory.details')}>
          <dl className="payroll-breakdown">
            <div>
              <dt>{t('inventory.category')}</dt>
              <dd dir="auto">
                {product.category === null ? '—' : localName(product.category, locale)}
              </dd>
            </div>
            <div>
              <dt>{t('inventory.unit')}</dt>
              <dd dir="auto">{product.unit}</dd>
            </div>
            <div>
              <dt>{t('inventory.supplier')}</dt>
              <dd dir="auto">{product.supplier?.name ?? '—'}</dd>
            </div>
            <div>
              <dt>{t('inventory.description_label')}</dt>
              <dd dir="auto">{product.description ?? '—'}</dd>
            </div>
          </dl>
        </Card>
        <Card title={t('inventory.pricing')}>
          <dl className="payroll-breakdown">
            <div>
              <dt>{t('inventory.cost_price')}</dt>
              <dd>
                <Amount value={product.cost_price} currency={session.currency} locale={locale} />
              </dd>
            </div>
            <div>
              <dt>{t('inventory.selling_price')}</dt>
              <dd>
                <Amount value={product.selling_price} currency={session.currency} locale={locale} />
              </dd>
            </div>
            <div>
              <dt>{t('inventory.min_stock')}</dt>
              <dd>
                <Quantity value={product.min_stock} unit={product.unit} />
              </dd>
            </div>
            <div className="payroll-breakdown__total">
              <dt>{t('inventory.valuation')}</dt>
              <dd>
                <Amount value={product.stock_value} currency={session.currency} locale={locale} />
              </dd>
            </div>
          </dl>
          <p className="tasks-muted">{t('inventory.valuation_note')}</p>
        </Card>
      </div>

      <Card title={t('inventory.per_location')} className="tasks-table warehouse-table">
        {product.stock.length === 0 ? (
          <EmptyState
            title={t('inventory.no_stock_title')}
            description={t('inventory.no_stock')}
            action={null}
          />
        ) : (
          <StockByLocation locale={locale} t={t} product={product} currency={session.currency} />
        )}
      </Card>

      <Card
        title={t('inventory.movement_history')}
        className="tasks-table warehouse-table"
        action={
          <Link className="tasks-back" href={productPath(locale, product.id, true)}>
            {t('inventory.all_movements')}
          </Link>
        }
      >
        {movements.items.length === 0 ? (
          <EmptyState
            title={t('warehouse.empty_movements_title')}
            description={t('inventory.no_movements')}
            action={null}
          />
        ) : (
          <MovementsTable
            locale={locale}
            t={t}
            movements={movements.items}
            timeZone={session.timeZone}
            showLocation
          />
        )}
      </Card>

      {dialog === 'edit' ? (
        <EditProductDialog
          locale={locale}
          t={t}
          product={product}
          refs={refs}
          onClose={() => {
            setDialog(null);
          }}
          onSaved={() => {
            finished(t('inventory.product_saved'));
          }}
        />
      ) : null}
      {dialog === 'move' ? (
        <MovementDialog
          locale={locale}
          t={t}
          product={product}
          warehouses={refs.warehouses}
          onClose={() => {
            setDialog(null);
          }}
          onDone={(movement) => {
            finished(
              movement.negative_stock
                ? t('inventory.movement_recorded_negative')
                : t('inventory.movement_recorded'),
            );
          }}
        />
      ) : null}
      {dialog === 'status' ? (
        <StatusDialog
          locale={locale}
          t={t}
          product={product}
          onClose={() => {
            setDialog(null);
          }}
          onDone={(active) => {
            finished(active ? t('inventory.activated') : t('inventory.deactivated'));
          }}
        />
      ) : null}
    </>
  );
}

function StockByLocation({
  locale,
  t,
  product,
  currency,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly product: ProductDetail;
  readonly currency: string;
}): React.JSX.Element {
  const headers = [
    t('warehouse.col_location'),
    t('warehouse.col_type'),
    t('warehouse.col_quantity'),
    t('warehouse.col_average_cost'),
    t('warehouse.col_value'),
  ];
  return (
    <DataTable
      headers={headers}
      rows={product.stock.map((row) => [
        <Cell key="loc" label={headers[0] as string}>
          <Link href={warehousePath(locale, 'locations', row.warehouse.id)}>
            <span dir="auto">{localName(row.warehouse, locale)}</span>
          </Link>
        </Cell>,
        <Cell key="type" label={headers[1] as string}>
          <TypeBadge type={row.warehouse.type} t={t} />
        </Cell>,
        <Cell key="qty" label={headers[2] as string}>
          <Quantity value={row.quantity} unit={product.unit} />
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

/** Deactivate (stock and history remain; no new movement) or reactivate — DOCUMENT 17 rule 12. */
function StatusDialog({
  locale,
  t,
  product,
  onClose,
  onDone,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly product: ProductDetail;
  readonly onClose: () => void;
  readonly onDone: (active: boolean) => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = product.status === 'active' ? 'discontinued' : 'active';
  return (
    <Modal
      open
      title={next === 'active' ? t('inventory.activate') : t('inventory.deactivate_title')}
      closeLabel={t('action.close')}
      onClose={onClose}
      footer={
        <>
          <Button
            variant={next === 'active' ? 'primary' : 'destructive'}
            loading={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              fetchOne<ProductDetail>(`/products/${product.id}`, {
                locale,
                method: 'PATCH',
                body: { status: next },
              })
                .then(() => {
                  onDone(next === 'active');
                })
                .catch((failure: unknown) => {
                  setBusy(false);
                  setError(describeError(failure, t));
                });
            }}
          >
            {next === 'active' ? t('inventory.activate') : t('inventory.deactivate')}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t('action.cancel')}
          </Button>
        </>
      }
    >
      <div className="tasks-form__grid">
        {error === null ? null : (
          <Alert tone="danger" title={t('requests.action_failed')}>
            {error}
          </Alert>
        )}
        <p>
          <strong dir="auto">{productName(product, locale)}</strong>
        </p>
        {next === 'discontinued' ? (
          <p>{t('inventory.deactivate_body', { quantity: product.total_quantity })}</p>
        ) : null}
      </div>
    </Modal>
  );
}

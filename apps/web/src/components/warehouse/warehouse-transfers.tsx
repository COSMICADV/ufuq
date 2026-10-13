'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';

import { ApiError, fetchMany, fetchOne, issueKeys } from '../../lib/api-client';
import {
  EMPTY_LINE,
  emptyTransferForm,
  insufficientDetail,
  localName,
  newIdempotencyKey,
  quantityLabel,
  transferBody,
  validateTransferForm,
} from '../../lib/warehouse';
import type { Issues, StockRow, Transfer, TransferForm, Warehouse } from '../../lib/warehouse';
import {
  Alert,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Textarea,
} from '../design-system';
import { loadSession } from '../employees/use-session';
import {
  Cell,
  describeError,
  ErrorState,
  LoadingState,
  optionalError,
  SuccessNotice,
} from '../settings/screen-states';
import { useResource } from '../settings/use-resource';
import { Amount, loadAllStock, Quantity, When } from './warehouse-shared';

/**
 * `/admin/warehouse/transfers` — DOCUMENT 04 B21, DOCUMENT 05 FLOW 18: every
 * transfer with its locations, products and value, and "تحويل جديد".
 */
export function WarehouseTransfers({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const load = useCallback(
    async (signal: AbortSignal) => {
      const [session, transfers, warehouses] = await Promise.all([
        loadSession(locale, signal),
        fetchMany<Transfer>('/warehouses/transfers', { locale, signal, query: { per_page: '50' } }),
        fetchMany<Warehouse>('/warehouses', { locale, signal, query: { per_page: '100' } }),
      ]);
      return { session, transfers: transfers.items, warehouses: warehouses.items };
    },
    [locale],
  );
  const resource = useResource(load);
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  if (resource.state.status === 'loading') return <LoadingState t={t} rows={6} />;
  if (resource.state.status === 'error') {
    return <ErrorState error={resource.state.error} t={t} onRetry={resource.reload} />;
  }
  const { session, transfers, warehouses } = resource.state.value;
  const canTransfer = session.permissions.has('stock.transfer');
  const headers = [
    t('warehouse.col_date'),
    t('warehouse.col_from'),
    t('warehouse.col_to'),
    t('warehouse.col_lines'),
    t('warehouse.col_value'),
    t('warehouse.col_by'),
    t('warehouse.col_note'),
  ];

  return (
    <>
      <SuccessNotice message={done} t={t} />
      {canTransfer ? (
        <div className="tasks-toolbar">
          <Button
            onClick={() => {
              setDone(null);
              setOpen(true);
            }}
          >
            {t('warehouse.new_transfer')}
          </Button>
        </div>
      ) : null}
      {transfers.length === 0 ? (
        <EmptyState
          title={t('warehouse.empty_transfers_title')}
          description={`${t('warehouse.empty_transfers')} ${t('warehouse.no_products_note')}`}
          action={null}
        />
      ) : (
        <Card className="tasks-table warehouse-table">
          <DataTable
            headers={headers}
            rows={transfers.map((transfer) => [
              <Cell key="date" label={headers[0] as string}>
                <When value={transfer.created_at} locale={locale} timeZone={session.timeZone} />
              </Cell>,
              <Cell key="from" label={headers[1] as string}>
                <span dir="auto">{localName(transfer.source, locale)}</span>
              </Cell>,
              <Cell key="to" label={headers[2] as string}>
                <span dir="auto">{localName(transfer.destination, locale)}</span>
              </Cell>,
              <Cell key="lines" label={headers[3] as string}>
                <ul className="warehouse-lines">
                  {transfer.lines.map((line) => (
                    <li key={line.out_movement_id}>
                      <span dir="auto">{localName(line.product, locale)}</span>{' '}
                      <Quantity value={line.quantity} unit={line.product.unit} />
                    </li>
                  ))}
                </ul>
              </Cell>,
              <Cell key="value" label={headers[4] as string}>
                <Amount value={transfer.value} currency={session.currency} locale={locale} />
              </Cell>,
              <Cell key="by" label={headers[5] as string}>
                <span dir="ltr">{transfer.created_by?.email ?? '—'}</span>
              </Cell>,
              <Cell key="note" label={headers[6] as string}>
                <span dir="auto">{transfer.note ?? '—'}</span>
              </Cell>,
            ])}
          />
        </Card>
      )}
      {open ? (
        <TransferDialog
          locale={locale}
          t={t}
          warehouses={warehouses}
          onClose={() => {
            setOpen(false);
          }}
          onDone={() => {
            setOpen(false);
            setDone(t('warehouse.transfer_done'));
            resource.reload();
          }}
        />
      ) : null}
    </>
  );
}

/**
 * The transfer form — DOCUMENT 05 FLOW 18. Products come from what the
 * source holds, each with its available quantity; nothing here sets a
 * quantity. One Idempotency-Key per dialog, so a double submit or a retry
 * after a dropped response moves the stock once (DOCUMENT 08 §8).
 */
export function TransferDialog({
  locale,
  t,
  warehouses,
  initialSource = '',
  onClose,
  onDone,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly warehouses: readonly Warehouse[];
  readonly initialSource?: string;
  readonly onClose: () => void;
  readonly onDone: (transfer: Transfer) => void;
}): React.JSX.Element {
  const active = warehouses.filter((warehouse) => warehouse.is_active);
  const [form, setForm] = useState<TransferForm>(() => emptyTransferForm(initialSource));
  const [stock, setStock] = useState<readonly StockRow[] | null>(null);
  const [stockError, setStockError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Issues>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key] = useState(newIdempotencyKey);

  useEffect(() => {
    if (form.source_warehouse_id === '') {
      setStock(null);
      return;
    }
    const controller = new AbortController();
    setStock(null);
    setStockError(null);
    loadAllStock(locale, form.source_warehouse_id, controller.signal)
      .then(setStock)
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setStockError(describeError(failure, t));
      });
    return () => {
      controller.abort();
    };
  }, [form.source_warehouse_id, locale, t]);

  const available = useMemo(
    () => new Map((stock ?? []).map((row) => [row.product.id, row.quantity])),
    [stock],
  );
  const productById = useMemo(
    () => new Map((stock ?? []).map((row) => [row.product.id, row])),
    [stock],
  );

  const update = (next: TransferForm): void => {
    setForm(next);
    if (Object.keys(issues).length > 0) setIssues(validateTransferForm(next, available));
  };
  const setLine = (index: number, patch: Partial<TransferForm['lines'][number]>): void => {
    update({
      ...form,
      lines: form.lines.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    });
  };

  const submit = (): void => {
    const found = validateTransferForm(form, available);
    setIssues(found);
    setError(null);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    fetchOne<Transfer>('/warehouses/transfers', {
      locale,
      method: 'POST',
      body: transferBody(form),
      headers: { 'Idempotency-Key': key },
    })
      .then(onDone)
      .catch((failure: unknown) => {
        setBusy(false);
        if (failure instanceof ApiError && failure.code === 'STOCK_INSUFFICIENT') {
          const detail = insufficientDetail(failure);
          const row = detail === null ? undefined : productById.get(detail.productId);
          setError(
            detail === null
              ? describeError(failure, t)
              : `${row === undefined ? '' : `${localName(row.product, locale)}: `}${t(
                  'warehouse.insufficient',
                  {
                    available: quantityLabel(detail.available),
                    requested: quantityLabel(detail.requested),
                  },
                )}`,
          );
          return;
        }
        if (failure instanceof ApiError && failure.status === 422) {
          const mapped = issueKeys(failure);
          if (Object.keys(mapped).length > 0) setIssues(mapped);
        }
        setError(describeError(failure, t));
      });
  };

  const message = (field: string): string | undefined => {
    const issue = issues[field];
    return issue === undefined ? undefined : t(issue);
  };

  return (
    <Modal
      open
      title={t('warehouse.transfer_title')}
      closeLabel={t('action.close')}
      onClose={onClose}
      footer={
        <>
          <Button loading={busy} disabled={stock === null || stock.length === 0} onClick={submit}>
            {t('warehouse.confirm_transfer')}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t('action.cancel')}
          </Button>
        </>
      }
    >
      <div className="tasks-form__grid">
        {error === null ? null : (
          <Alert tone="danger" title={t('warehouse.transfer_failed')}>
            {error}
          </Alert>
        )}
        <p className="tasks-muted">{t('warehouse.movements_for_transfer')}</p>
        <Field
          label={t('warehouse.source')}
          required
          {...optionalError(message('source_warehouse_id'))}
        >
          <Select
            value={form.source_warehouse_id}
            onChange={(event) => {
              update({ ...form, source_warehouse_id: event.target.value, lines: [EMPTY_LINE] });
            }}
          >
            <option value="">{t('warehouse.choose_location')}</option>
            {active.map((warehouse) => (
              <option key={warehouse.id} value={warehouse.id}>
                {localName(warehouse, locale)}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label={t('warehouse.destination')}
          required
          {...optionalError(message('destination_warehouse_id'))}
        >
          <Select
            value={form.destination_warehouse_id}
            onChange={(event) => {
              update({ ...form, destination_warehouse_id: event.target.value });
            }}
          >
            <option value="">{t('warehouse.choose_location')}</option>
            {active
              .filter((warehouse) => warehouse.id !== form.source_warehouse_id)
              .map((warehouse) => (
                <option key={warehouse.id} value={warehouse.id}>
                  {localName(warehouse, locale)}
                </option>
              ))}
          </Select>
        </Field>
        {form.source_warehouse_id === '' ? null : stockError !== null ? (
          <Alert tone="danger" title={t('state.error')}>
            {stockError}
          </Alert>
        ) : stock === null ? (
          <LoadingState t={t} rows={2} />
        ) : stock.length === 0 ? (
          <Alert tone="info" title={t('warehouse.source_empty')}>
            {t('warehouse.no_products_note')}
          </Alert>
        ) : (
          <fieldset className="warehouse-transfer-lines">
            {form.lines.map((line, index) => {
              const row = productById.get(line.product_id);
              return (
                <div key={index} className="warehouse-transfer-line">
                  <Field
                    label={t('warehouse.line_product')}
                    required
                    {...optionalError(message(`lines.${String(index)}.product_id`))}
                  >
                    <Select
                      value={line.product_id}
                      onChange={(event) => {
                        setLine(index, { product_id: event.target.value });
                      }}
                    >
                      <option value="">{t('warehouse.choose_product')}</option>
                      {stock.map((option) => (
                        <option key={option.product.id} value={option.product.id}>
                          {`${localName(option.product, locale)} (${option.product.sku})`}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field
                    label={t('warehouse.line_quantity')}
                    required
                    {...(row === undefined
                      ? {}
                      : {
                          helper: t('warehouse.line_available', {
                            available: `${quantityLabel(row.quantity)} ${row.product.unit}`,
                          }),
                        })}
                    {...optionalError(message(`lines.${String(index)}.quantity`))}
                  >
                    <Input
                      dir="ltr"
                      inputMode="decimal"
                      value={line.quantity}
                      onChange={(event) => {
                        setLine(index, { quantity: event.target.value });
                      }}
                    />
                  </Field>
                  {form.lines.length > 1 ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        update({ ...form, lines: form.lines.filter((_, i) => i !== index) });
                      }}
                    >
                      {t('warehouse.remove_line')}
                    </Button>
                  ) : null}
                </div>
              );
            })}
            {form.lines.length < stock.length ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  update({ ...form, lines: [...form.lines, EMPTY_LINE] });
                }}
              >
                {t('warehouse.add_line')}
              </Button>
            ) : null}
          </fieldset>
        )}
        <Field label={t('warehouse.note')} {...optionalError(message('note'))}>
          <Textarea
            dir="auto"
            rows={2}
            value={form.note}
            onChange={(event) => {
              update({ ...form, note: event.target.value });
            }}
          />
        </Field>
      </div>
    </Modal>
  );
}

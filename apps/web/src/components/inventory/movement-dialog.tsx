'use client';

import { useState } from 'react';
import type { Locale, Translator } from '@ufuq/i18n';

import { ApiError, fetchOne, issueKeys } from '../../lib/api-client';
import {
  EMPTY_MOVEMENT_FORM,
  MOVEMENT_FORM_TYPES,
  costAllowed,
  movementBody,
  movementIsOutbound,
  reasonRequired,
  stockFigures,
  validateMovementForm,
} from '../../lib/inventory';
import type { CreatedMovement, Issues, MovementForm, ProductDetail } from '../../lib/inventory';
import { localName, newIdempotencyKey, quantityLabel } from '../../lib/warehouse';
import type { Warehouse } from '../../lib/warehouse';
import { Alert, Button, Field, Input, Modal, Select, Textarea } from '../design-system';
import { describeError, optionalError } from '../settings/screen-states';

/**
 * "حركة مخزون" — DOCUMENT 05 FLOW 18 from a product's page. The type decides
 * the direction; an adjustment asks which way. A unit cost is asked for on
 * inbound types (required on a purchase) and never on outbound ones; a
 * reason on adjustment and damage.
 *
 * Negative stock (rule 5): when the company allows it and the movement would
 * take the location below zero, the server answers 409
 * `STOCK_NEGATIVE_WARNING` with the figures; this dialog shows them and the
 * Admin confirms, which resends the same movement with
 * `acknowledge_negative_stock`. With the setting off it is simply refused,
 * naming what is available. One Idempotency-Key per dialog.
 */
export function MovementDialog({
  locale,
  t,
  product,
  warehouses,
  initialWarehouse = '',
  onClose,
  onDone,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly product: ProductDetail;
  readonly warehouses: readonly Warehouse[];
  readonly initialWarehouse?: string;
  readonly onClose: () => void;
  readonly onDone: (movement: CreatedMovement) => void;
}): React.JSX.Element {
  const [form, setForm] = useState<MovementForm>({
    ...EMPTY_MOVEMENT_FORM,
    warehouse_id: initialWarehouse,
  });
  const [issues, setIssues] = useState<Issues>({});
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<{
    available: string;
    requested: string;
    resulting: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(newIdempotencyKey);
  const active = warehouses.filter((w) => w.is_active);
  const held = product.stock.find((s) => s.warehouse.id === form.warehouse_id)?.quantity ?? '0.000';

  const update = (patch: Partial<MovementForm>): void => {
    const next = { ...form, ...patch };
    setForm(next);
    setWarning(null);
    if (Object.keys(issues).length > 0) setIssues(validateMovementForm(next));
  };

  const send = (acknowledge: boolean): void => {
    const found = validateMovementForm(form);
    setIssues(found);
    setError(null);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    fetchOne<CreatedMovement>('/stock-movements', {
      locale,
      method: 'POST',
      body: movementBody(form, product.id, acknowledge),
      headers: { 'Idempotency-Key': key },
    })
      .then(onDone)
      .catch((failure: unknown) => {
        setBusy(false);
        // A refusal is a different request next time: a fresh key.
        setKey(newIdempotencyKey());
        if (failure instanceof ApiError && failure.code === 'STOCK_NEGATIVE_WARNING') {
          const figures = stockFigures(failure);
          setWarning({
            available: figures?.available ?? held,
            requested: figures?.requested ?? form.quantity,
            resulting: figures?.resulting ?? '',
          });
          return;
        }
        if (failure instanceof ApiError && failure.code === 'STOCK_INSUFFICIENT') {
          const figures = stockFigures(failure);
          setError(
            figures === null
              ? describeError(failure, t)
              : t('warehouse.insufficient', {
                  available: quantityLabel(figures.available),
                  requested: quantityLabel(figures.requested),
                }),
          );
          return;
        }
        if (failure instanceof ApiError && failure.status === 422) setIssues(issueKeys(failure));
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
      title={t('inventory.movement_title')}
      closeLabel={t('action.close')}
      onClose={onClose}
      footer={
        <>
          {warning === null ? (
            <Button
              loading={busy}
              onClick={() => {
                send(false);
              }}
            >
              {t('inventory.record_movement')}
            </Button>
          ) : (
            <Button
              variant="destructive"
              loading={busy}
              onClick={() => {
                send(true);
              }}
            >
              {t('inventory.confirm_negative')}
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            {t('action.cancel')}
          </Button>
        </>
      }
    >
      <div className="tasks-form__grid">
        {error === null ? null : (
          <Alert tone="danger" title={t('inventory.movement_failed')}>
            {error}
          </Alert>
        )}
        {warning === null ? null : (
          <Alert tone="warning" title={t('inventory.negative_title')}>
            {t('inventory.negative_body', {
              available: quantityLabel(warning.available),
              requested: quantityLabel(warning.requested),
              resulting: quantityLabel(warning.resulting),
            })}
          </Alert>
        )}
        <p className="tasks-muted">{t('inventory.movement_help')}</p>
        <Field label={t('inventory.location')} required {...optionalError(message('warehouse_id'))}>
          <Select
            value={form.warehouse_id}
            onChange={(event) => {
              update({ warehouse_id: event.target.value });
            }}
          >
            <option value="">{t('warehouse.choose_location')}</option>
            {active.map((w) => (
              <option key={w.id} value={w.id}>
                {localName(w, locale)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('inventory.movement_type')} required {...optionalError(message('type'))}>
          <Select
            value={form.type}
            onChange={(event) => {
              const type = event.target.value as MovementForm['type'];
              update({
                type,
                ...(type !== '' && !costAllowed({ ...form, type }) ? { unit_cost: '' } : {}),
              });
            }}
          >
            <option value="">{t('inventory.choose_type')}</option>
            {MOVEMENT_FORM_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`warehouse.movement.${type}`)}
              </option>
            ))}
          </Select>
        </Field>
        {form.type === 'adjustment' ? (
          <Field label={t('inventory.direction')} required>
            <Select
              value={form.direction}
              onChange={(event) => {
                const direction = event.target.value as MovementForm['direction'];
                update({ direction, ...(direction === 'decrease' ? { unit_cost: '' } : {}) });
              }}
            >
              <option value="decrease">{t('inventory.direction_decrease')}</option>
              <option value="increase">{t('inventory.direction_increase')}</option>
            </Select>
          </Field>
        ) : null}
        <Field
          label={t('inventory.quantity')}
          required
          helper={t('warehouse.line_available', {
            available: `${quantityLabel(held)} ${product.unit}`,
          })}
          {...optionalError(message('quantity'))}
        >
          <Input
            dir="ltr"
            inputMode="decimal"
            value={form.quantity}
            onChange={(event) => {
              update({ quantity: event.target.value });
            }}
          />
        </Field>
        {costAllowed(form) ? (
          <Field
            label={t('inventory.unit_cost')}
            required={form.type === 'purchase'}
            {...(form.type === 'purchase' ? {} : { helper: t('inventory.unit_cost_default') })}
            {...optionalError(message('unit_cost'))}
          >
            <Input
              dir="ltr"
              inputMode="decimal"
              value={form.unit_cost}
              onChange={(event) => {
                update({ unit_cost: event.target.value });
              }}
            />
          </Field>
        ) : movementIsOutbound(form) ? (
          <p className="tasks-muted">{t('inventory.outbound_cost_note')}</p>
        ) : null}
        <Field
          label={t('inventory.reason')}
          required={reasonRequired(form.type)}
          {...optionalError(message('reason'))}
        >
          <Textarea
            dir="auto"
            rows={2}
            value={form.reason}
            onChange={(event) => {
              update({ reason: event.target.value });
            }}
          />
        </Field>
      </div>
    </Modal>
  );
}

'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';

import { ApiError, fetchMany, fetchOne, issueKeys } from '../../lib/api-client';
import {
  EMPTY_WAREHOUSE_FORM,
  WAREHOUSE_TYPES,
  formFromWarehouse,
  localName,
  validateWarehouseForm,
  warehouseBody,
  warehousePath,
} from '../../lib/warehouse';
import type { Issues, Warehouse, WarehouseForm } from '../../lib/warehouse';
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
import { ActiveBadge, Amount, Quantity, TypeBadge } from './warehouse-shared';

/**
 * `/admin/warehouse/locations` — DOCUMENT 04 B20: every location of every
 * type (an online channel is one of them, with the same stock model), what
 * it holds, and add / edit / deactivate. A location holding stock is never
 * deactivated: the server refuses it and this screen says why.
 */
export function WarehouseLocations({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const load = useCallback(
    async (signal: AbortSignal) => {
      const [session, warehouses] = await Promise.all([
        loadSession(locale, signal),
        fetchMany<Warehouse>('/warehouses', { locale, signal, query: { per_page: '100' } }),
      ]);
      return { session, warehouses: warehouses.items };
    },
    [locale],
  );
  const resource = useResource(load);
  const [editing, setEditing] = useState<Warehouse | 'new' | null>(null);
  const [toggling, setToggling] = useState<Warehouse | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (resource.state.status === 'loading') return <LoadingState t={t} rows={6} />;
  if (resource.state.status === 'error') {
    return <ErrorState error={resource.state.error} t={t} onRetry={resource.reload} />;
  }
  const { session, warehouses } = resource.state.value;
  const canManage = session.permissions.has('warehouse.manage');
  const headers = [
    t('warehouse.col_location'),
    t('warehouse.col_type'),
    t('warehouse.col_status'),
    t('warehouse.col_products'),
    t('warehouse.col_units'),
    t('warehouse.col_value'),
    ...(canManage ? [''] : []),
  ];
  const finished = (message: string): void => {
    setEditing(null);
    setToggling(null);
    setDone(message);
    resource.reload();
  };

  return (
    <>
      <SuccessNotice message={done} t={t} />
      {canManage ? (
        <div className="tasks-toolbar">
          <Button
            onClick={() => {
              setDone(null);
              setEditing('new');
            }}
          >
            {t('warehouse.new_location')}
          </Button>
        </div>
      ) : null}
      {warehouses.length === 0 ? (
        <EmptyState
          title={t('warehouse.empty_locations_title')}
          description={t('warehouse.empty_locations')}
          action={null}
        />
      ) : (
        <Card className="tasks-table warehouse-table">
          <DataTable
            headers={headers}
            rows={warehouses.map((warehouse) => [
              <Cell key="name" label={headers[0] as string}>
                <Link href={warehousePath(locale, 'locations', warehouse.id)}>
                  <span dir="auto">{localName(warehouse, locale)}</span>
                </Link>
              </Cell>,
              <Cell key="type" label={headers[1] as string}>
                <TypeBadge type={warehouse.type} t={t} />
              </Cell>,
              <Cell key="status" label={headers[2] as string}>
                <ActiveBadge active={warehouse.is_active} t={t} />
              </Cell>,
              <Cell key="products" label={headers[3] as string}>
                <span dir="ltr">{warehouse.product_count}</span>
              </Cell>,
              <Cell key="units" label={headers[4] as string}>
                <Quantity value={warehouse.total_quantity} />
              </Cell>,
              <Cell key="value" label={headers[5] as string}>
                <Amount value={warehouse.stock_value} currency={session.currency} locale={locale} />
              </Cell>,
              ...(canManage
                ? [
                    <Cell key="actions" label="">
                      <span className="warehouse-actions">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            setDone(null);
                            setEditing(warehouse);
                          }}
                        >
                          {t('warehouse.edit_location')}
                        </Button>
                        <Button
                          variant={warehouse.is_active ? 'destructive-ghost' : 'secondary'}
                          size="sm"
                          onClick={() => {
                            setDone(null);
                            setToggling(warehouse);
                          }}
                        >
                          {warehouse.is_active
                            ? t('warehouse.deactivate')
                            : t('warehouse.activate')}
                        </Button>
                      </span>
                    </Cell>,
                  ]
                : []),
            ])}
          />
        </Card>
      )}
      {editing === null ? null : (
        <LocationDialog
          locale={locale}
          t={t}
          original={editing === 'new' ? undefined : editing}
          onClose={() => {
            setEditing(null);
          }}
          onSaved={(created) => {
            finished(created ? t('warehouse.location_created') : t('warehouse.location_saved'));
          }}
        />
      )}
      {toggling === null ? null : (
        <ToggleDialog
          locale={locale}
          t={t}
          warehouse={toggling}
          onClose={() => {
            setToggling(null);
          }}
          onDone={(active) => {
            finished(active ? t('warehouse.activated') : t('warehouse.deactivated'));
          }}
        />
      )}
    </>
  );
}

/** Add or edit a location. Nothing here touches stock. */
export function LocationDialog({
  locale,
  t,
  original,
  onClose,
  onSaved,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly original: Warehouse | undefined;
  readonly onClose: () => void;
  readonly onSaved: (created: boolean) => void;
}): React.JSX.Element {
  const [form, setForm] = useState<WarehouseForm>(
    original === undefined ? EMPTY_WAREHOUSE_FORM : formFromWarehouse(original),
  );
  const [issues, setIssues] = useState<Issues>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const update = (patch: Partial<WarehouseForm>): void => {
    const next = { ...form, ...patch };
    setForm(next);
    if (Object.keys(issues).length > 0) setIssues(validateWarehouseForm(next));
  };
  const submit = (): void => {
    const found = validateWarehouseForm(form);
    setIssues(found);
    setError(null);
    if (Object.keys(found).length > 0) return;
    const body = warehouseBody(form, original);
    if (original !== undefined && Object.keys(body).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    fetchOne<Warehouse>(original === undefined ? '/warehouses' : `/warehouses/${original.id}`, {
      locale,
      method: original === undefined ? 'POST' : 'PATCH',
      body,
    })
      .then(() => {
        onSaved(original === undefined);
      })
      .catch((failure: unknown) => {
        setBusy(false);
        if (failure instanceof ApiError && failure.status === 422) setIssues(issueKeys(failure));
        setError(describeError(failure, t));
      });
  };
  const message = (field: keyof WarehouseForm): string | undefined => {
    const issue = issues[field];
    return issue === undefined ? undefined : t(issue);
  };

  return (
    <Modal
      open
      title={original === undefined ? t('warehouse.new_location') : t('warehouse.edit_location')}
      closeLabel={t('action.close')}
      onClose={onClose}
      footer={
        <>
          <Button loading={busy} onClick={submit}>
            {t('action.save')}
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
        <Field label={t('warehouse.name_ar')} required {...optionalError(message('name_ar'))}>
          <Input
            dir="rtl"
            value={form.name_ar}
            onChange={(event) => {
              update({ name_ar: event.target.value });
            }}
          />
        </Field>
        <Field label={t('warehouse.name_en')} required {...optionalError(message('name_en'))}>
          <Input
            dir="ltr"
            value={form.name_en}
            onChange={(event) => {
              update({ name_en: event.target.value });
            }}
          />
        </Field>
        <Field label={t('warehouse.type_label')} required {...optionalError(message('type'))}>
          <Select
            value={form.type}
            onChange={(event) => {
              update({ type: event.target.value as WarehouseForm['type'] });
            }}
          >
            <option value="">{t('warehouse.choose_type')}</option>
            {WAREHOUSE_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`warehouse.type.${type}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('warehouse.address')} {...optionalError(message('address'))}>
          <Textarea
            dir="auto"
            rows={2}
            value={form.address}
            onChange={(event) => {
              update({ address: event.target.value });
            }}
          />
        </Field>
      </div>
    </Modal>
  );
}

/** Deactivate (refused while stock remains — WAREHOUSE_HAS_STOCK) or reactivate. */
export function ToggleDialog({
  locale,
  t,
  warehouse,
  onClose,
  onDone,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly warehouse: Warehouse;
  readonly onClose: () => void;
  readonly onDone: (active: boolean) => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = !warehouse.is_active;
  const submit = (): void => {
    setBusy(true);
    setError(null);
    fetchOne<Warehouse>(`/warehouses/${warehouse.id}`, {
      locale,
      method: 'PATCH',
      body: { is_active: next },
    })
      .then(() => {
        onDone(next);
      })
      .catch((failure: unknown) => {
        setBusy(false);
        setError(describeError(failure, t));
      });
  };
  return (
    <Modal
      open
      title={next ? t('warehouse.activate') : t('warehouse.deactivate_title')}
      closeLabel={t('action.close')}
      onClose={onClose}
      footer={
        <>
          <Button variant={next ? 'primary' : 'destructive'} loading={busy} onClick={submit}>
            {next ? t('warehouse.activate') : t('warehouse.deactivate')}
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
          <strong dir="auto">{localName(warehouse, locale)}</strong>
        </p>
        {next ? null : <p>{t('warehouse.deactivate_body')}</p>}
      </div>
    </Modal>
  );
}

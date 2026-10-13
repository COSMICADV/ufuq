'use client';

import { useCallback, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';

import { ApiError, fetchMany, fetchOne, issueKeys } from '../../lib/api-client';
import {
  EMPTY_SUPPLIER_FORM,
  formFromSupplier,
  supplierBody,
  validateSupplierForm,
} from '../../lib/inventory';
import type { Issues, Supplier, SupplierForm } from '../../lib/inventory';
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Input,
  Modal,
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
import { PageNav } from './inventory-shared';

const PER_PAGE = 25;

/**
 * `/admin/inventory/suppliers` — DOCUMENT 06 §3.33: name, contact person,
 * phone, email, address, status. Add, edit, deactivate (a supplier is never
 * deleted — its products keep it).
 */
export function Suppliers({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const load = useCallback(
    async (signal: AbortSignal) => {
      const [session, suppliers] = await Promise.all([
        loadSession(locale, signal),
        fetchMany<Supplier>('/suppliers', {
          locale,
          signal,
          query: {
            page: String(page),
            per_page: String(PER_PAGE),
            ...(search.trim() === '' ? {} : { search: search.trim() }),
          },
        }),
      ]);
      return { session, suppliers };
    },
    [locale, page, search],
  );
  const resource = useResource(load);
  const [editing, setEditing] = useState<Supplier | 'new' | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const searchBox = (
    <div className="inventory-filters">
      <Field label={t('inventory.search')}>
        <Input
          type="search"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
        />
      </Field>
    </div>
  );
  if (resource.state.status === 'error') {
    return <ErrorState error={resource.state.error} t={t} onRetry={resource.reload} />;
  }
  const ready = resource.state.status === 'ready' ? resource.state.value : null;
  const canCreate = ready?.session.permissions.has('product.create') ?? false;
  const canEdit = ready?.session.permissions.has('product.update') ?? false;
  const headers = [
    t('inventory.supplier_name'),
    t('inventory.contact_person'),
    t('inventory.phone'),
    t('inventory.email'),
    t('inventory.col_products_count'),
    t('warehouse.col_status'),
    ...(canEdit ? [''] : []),
  ];

  return (
    <>
      <SuccessNotice message={done} t={t} />
      {canCreate ? (
        <div className="tasks-toolbar">
          <Button
            onClick={() => {
              setDone(null);
              setEditing('new');
            }}
          >
            {t('inventory.new_supplier')}
          </Button>
        </div>
      ) : null}
      {searchBox}
      {ready === null ? (
        <LoadingState t={t} rows={6} />
      ) : ready.suppliers.items.length === 0 ? (
        <EmptyState
          title={t('inventory.empty_suppliers_title')}
          description={t('inventory.empty_suppliers')}
          action={null}
        />
      ) : (
        <Card className="tasks-table warehouse-table">
          <DataTable
            headers={headers}
            rows={ready.suppliers.items.map((supplier) => [
              <Cell key="name" label={headers[0] as string}>
                <span dir="auto">{supplier.name}</span>
              </Cell>,
              <Cell key="contact" label={headers[1] as string}>
                <span dir="auto">{supplier.contact_person ?? '—'}</span>
              </Cell>,
              <Cell key="phone" label={headers[2] as string}>
                <span dir="ltr">{supplier.phone ?? '—'}</span>
              </Cell>,
              <Cell key="email" label={headers[3] as string}>
                <span dir="ltr">{supplier.email ?? '—'}</span>
              </Cell>,
              <Cell key="count" label={headers[4] as string}>
                <span dir="ltr">{supplier.product_count}</span>
              </Cell>,
              <Cell key="status" label={headers[5] as string}>
                <Badge tone={supplier.status === 'active' ? 'success' : 'cancelled'}>
                  {t(`inventory.supplier_status.${supplier.status}`)}
                </Badge>
              </Cell>,
              ...(canEdit
                ? [
                    <Cell key="actions" label="">
                      <span className="warehouse-actions">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            setDone(null);
                            setEditing(supplier);
                          }}
                        >
                          {t('inventory.edit_supplier')}
                        </Button>
                        <ToggleSupplier
                          locale={locale}
                          t={t}
                          supplier={supplier}
                          onDone={(message) => {
                            setDone(message);
                            resource.reload();
                          }}
                        />
                      </span>
                    </Cell>,
                  ]
                : []),
            ])}
          />
          <PageNav
            page={page}
            totalPages={ready.suppliers.meta.total_pages}
            onPage={setPage}
            t={t}
          />
        </Card>
      )}
      {editing === null ? null : (
        <SupplierDialog
          locale={locale}
          t={t}
          original={editing === 'new' ? undefined : editing}
          onClose={() => {
            setEditing(null);
          }}
          onSaved={(created) => {
            setEditing(null);
            setDone(created ? t('inventory.supplier_created') : t('inventory.supplier_saved'));
            resource.reload();
          }}
        />
      )}
    </>
  );
}

function ToggleSupplier({
  locale,
  t,
  supplier,
  onDone,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly supplier: Supplier;
  readonly onDone: (message: string) => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const next = supplier.status === 'active' ? 'inactive' : 'active';
  return (
    <Button
      variant={next === 'inactive' ? 'destructive-ghost' : 'secondary'}
      size="sm"
      loading={busy}
      onClick={() => {
        setBusy(true);
        fetchOne<Supplier>(`/suppliers/${supplier.id}`, {
          locale,
          method: 'PATCH',
          body: { status: next },
        })
          .then(() => {
            onDone(
              next === 'active'
                ? t('inventory.supplier_activated')
                : t('inventory.supplier_deactivated'),
            );
          })
          .catch(() => {
            setBusy(false);
          });
      }}
    >
      {next === 'inactive' ? t('inventory.deactivate') : t('inventory.activate')}
    </Button>
  );
}

function SupplierDialog({
  locale,
  t,
  original,
  onClose,
  onSaved,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly original: Supplier | undefined;
  readonly onClose: () => void;
  readonly onSaved: (created: boolean) => void;
}): React.JSX.Element {
  const [form, setForm] = useState<SupplierForm>(
    original === undefined ? EMPTY_SUPPLIER_FORM : formFromSupplier(original),
  );
  const [issues, setIssues] = useState<Issues>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const update = (patch: Partial<SupplierForm>): void => {
    const next = { ...form, ...patch };
    setForm(next);
    if (Object.keys(issues).length > 0) setIssues(validateSupplierForm(next));
  };
  const submit = (): void => {
    const found = validateSupplierForm(form);
    setIssues(found);
    setError(null);
    if (Object.keys(found).length > 0) return;
    const body = supplierBody(form, original);
    if (original !== undefined && Object.keys(body).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    fetchOne<Supplier>(original === undefined ? '/suppliers' : `/suppliers/${original.id}`, {
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
  const message = (field: string): string | undefined => {
    const issue = issues[field];
    return issue === undefined ? undefined : t(issue);
  };
  const text = (
    field: keyof SupplierForm,
    label: string,
    dir: 'ltr' | 'auto' = 'auto',
    required = false,
  ) => (
    <Field label={label} required={required} {...optionalError(message(field))}>
      <Input
        dir={dir}
        value={form[field]}
        onChange={(event) => {
          update({ [field]: event.target.value });
        }}
      />
    </Field>
  );
  return (
    <Modal
      open
      title={original === undefined ? t('inventory.new_supplier') : t('inventory.edit_supplier')}
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
        {text('name', t('inventory.supplier_name'), 'auto', true)}
        {text('contact_person', t('inventory.contact_person'))}
        {text('phone', t('inventory.phone'), 'ltr')}
        {text('email', t('inventory.email'), 'ltr')}
        <Field label={t('inventory.address')} {...optionalError(message('address'))}>
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

'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';

import { ApiError, fetchOne, issueKeys } from '../../lib/api-client';
import {
  EMPTY_PRODUCT_FORM,
  duplicateSku,
  formFromProduct,
  productBody,
  productPath,
  validateProductForm,
} from '../../lib/inventory';
import type { Category, Issues, Product, ProductDetail, ProductForm } from '../../lib/inventory';
import { localName } from '../../lib/warehouse';
import { Alert, Button, Card, Field, Input, Modal, Select, Textarea } from '../design-system';
import { describeError, ErrorState, LoadingState, optionalError } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';
import { loadRefs } from './inventory-shared';
import type { CatalogueRefs } from './inventory-shared';

/** A server refusal as field issues; a duplicate SKU names the product that has it (rule 10). */
function refusal(
  failure: unknown,
  t: Translator,
  locale: Locale,
): { issues: Issues; message: string } {
  if (failure instanceof ApiError && failure.status === 422) {
    const issues: Record<string, string> = { ...issueKeys(failure) };
    for (const key of [
      'existing_product_id',
      'existing_product_name_ar',
      'existing_product_name_en',
    ]) {
      Reflect.deleteProperty(issues, key);
    }
    if (failure.fields['initial_stock.warehouse_id'] !== undefined)
      issues.initial_warehouse_id = 'validation.not_found';
    if (failure.fields['initial_stock.quantity'] !== undefined)
      issues.initial_quantity = 'validation.quantity';
    const existing = duplicateSku(failure);
    const message =
      existing === null
        ? t('validation.generic')
        : t('inventory.sku_taken', { name: locale === 'ar' ? existing.name_ar : existing.name_en });
    return { issues, message };
  }
  return { issues: {}, message: describeError(failure, t) };
}

/**
 * The product fields — DOCUMENT 05 FLOW 17: name, SKU, category, unit, min
 * stock, cost, selling price, supplier, description; on creation, the
 * optional initial stock (location + quantity). **No quantity field
 * otherwise** (DOCUMENT 04 B23).
 */
export function ProductFields({
  locale,
  t,
  form,
  issues,
  refs,
  creating,
  onChange,
  onCategoryCreated,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly form: ProductForm;
  readonly issues: Issues;
  readonly refs: CatalogueRefs;
  readonly creating: boolean;
  readonly onChange: (patch: Partial<ProductForm>) => void;
  readonly onCategoryCreated: (category: Category) => void;
}): React.JSX.Element {
  const [addingCategory, setAddingCategory] = useState(false);
  const message = (field: string): string | undefined => {
    const issue = issues[field];
    return issue === undefined ? undefined : t(issue);
  };
  const text = (
    field: keyof ProductForm,
    label: string,
    extra: { dir?: 'ltr' | 'rtl' | 'auto'; required?: boolean; inputMode?: 'decimal' } = {},
  ) => (
    <Field label={label} required={extra.required === true} {...optionalError(message(field))}>
      <Input
        name={field}
        dir={extra.dir ?? 'auto'}
        {...(extra.inputMode === undefined ? {} : { inputMode: extra.inputMode })}
        value={form[field]}
        onChange={(event) => {
          onChange({ [field]: event.target.value });
        }}
      />
    </Field>
  );
  const activeSuppliers = refs.suppliers.filter(
    (s) => s.status === 'active' || s.id === form.supplier_id,
  );
  const activeWarehouses = refs.warehouses.filter((w) => w.is_active);
  return (
    <div className="tasks-form__grid">
      {text('name_ar', t('inventory.name_ar'), { dir: 'rtl', required: true })}
      {text('name_en', t('inventory.name_en'), { dir: 'ltr', required: true })}
      {text('sku', t('inventory.sku'), { dir: 'ltr', required: true })}
      {text('unit', t('inventory.unit'), { required: true })}
      <Field label={t('inventory.category')} {...optionalError(message('category_id'))}>
        <span className="inventory-inline">
          <Select
            value={form.category_id}
            onChange={(event) => {
              onChange({ category_id: event.target.value });
            }}
          >
            <option value="">{t('inventory.no_category')}</option>
            {refs.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {localName(c, locale)}
              </option>
            ))}
          </Select>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={() => {
              setAddingCategory(true);
            }}
          >
            {t('inventory.new_category')}
          </Button>
        </span>
      </Field>
      <Field label={t('inventory.supplier')} {...optionalError(message('supplier_id'))}>
        <Select
          value={form.supplier_id}
          onChange={(event) => {
            onChange({ supplier_id: event.target.value });
          }}
        >
          <option value="">{t('inventory.no_supplier')}</option>
          {activeSuppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </Field>
      {text('min_stock', t('inventory.min_stock'), { dir: 'ltr', inputMode: 'decimal' })}
      {text('cost_price', t('inventory.cost_price'), { dir: 'ltr', inputMode: 'decimal' })}
      {text('selling_price', t('inventory.selling_price'), { dir: 'ltr', inputMode: 'decimal' })}
      <Field label={t('inventory.description_label')} {...optionalError(message('description'))}>
        <Textarea
          dir="auto"
          rows={3}
          value={form.description}
          onChange={(event) => {
            onChange({ description: event.target.value });
          }}
        />
      </Field>
      {creating ? (
        <fieldset className="inventory-fieldset">
          <legend>{t('inventory.initial_stock')}</legend>
          <p className="tasks-muted">{t('inventory.initial_stock_help')}</p>
          <Field
            label={t('inventory.location')}
            {...optionalError(message('initial_warehouse_id'))}
          >
            <Select
              value={form.initial_warehouse_id}
              onChange={(event) => {
                onChange({ initial_warehouse_id: event.target.value });
              }}
            >
              <option value="">{t('warehouse.choose_location')}</option>
              {activeWarehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {localName(w, locale)}
                </option>
              ))}
            </Select>
          </Field>
          {text('initial_quantity', t('inventory.initial_quantity'), {
            dir: 'ltr',
            inputMode: 'decimal',
          })}
          {text('initial_unit_cost', t('inventory.initial_unit_cost'), {
            dir: 'ltr',
            inputMode: 'decimal',
          })}
        </fieldset>
      ) : null}
      {addingCategory ? (
        <CategoryDialog
          locale={locale}
          t={t}
          categories={refs.categories}
          onClose={() => {
            setAddingCategory(false);
          }}
          onCreated={(category) => {
            setAddingCategory(false);
            onCategoryCreated(category);
          }}
        />
      ) : null}
    </div>
  );
}

/** `POST /product-categories` — name in both languages and an optional parent (DOCUMENT 06 §3.30). */
function CategoryDialog({
  locale,
  t,
  categories,
  onClose,
  onCreated,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly categories: readonly Category[];
  readonly onClose: () => void;
  readonly onCreated: (category: Category) => void;
}): React.JSX.Element {
  const [nameAr, setNameAr] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [parent, setParent] = useState('');
  const [issues, setIssues] = useState<Issues>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = (): void => {
    const found: Record<string, string> = {};
    if (nameAr.trim() === '') found.name_ar = 'validation.required';
    if (nameEn.trim() === '') found.name_en = 'validation.required';
    setIssues(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    setError(null);
    fetchOne<Category>('/product-categories', {
      locale,
      method: 'POST',
      body: {
        name_ar: nameAr.trim(),
        name_en: nameEn.trim(),
        ...(parent === '' ? {} : { parent_id: parent }),
      },
    })
      .then(onCreated)
      .catch((failure: unknown) => {
        setBusy(false);
        if (failure instanceof ApiError && failure.status === 422) setIssues(issueKeys(failure));
        setError(describeError(failure, t));
      });
  };
  const message = (field: string): string | undefined =>
    issues[field] === undefined ? undefined : t(issues[field]);
  return (
    <Modal
      open
      title={t('inventory.new_category')}
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
        <Field label={t('inventory.name_ar')} required {...optionalError(message('name_ar'))}>
          <Input
            dir="rtl"
            value={nameAr}
            onChange={(event) => {
              setNameAr(event.target.value);
            }}
          />
        </Field>
        <Field label={t('inventory.name_en')} required {...optionalError(message('name_en'))}>
          <Input
            dir="ltr"
            value={nameEn}
            onChange={(event) => {
              setNameEn(event.target.value);
            }}
          />
        </Field>
        <Field label={t('inventory.parent_category')} {...optionalError(message('parent_id'))}>
          <Select
            value={parent}
            onChange={(event) => {
              setParent(event.target.value);
            }}
          >
            <option value="">{t('inventory.no_category')}</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {localName(c, locale)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}

/** `/admin/inventory/new` — DOCUMENT 05 FLOW 17. */
export function NewProduct({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const router = useRouter();
  const load = useCallback((signal: AbortSignal) => loadRefs(locale, signal), [locale]);
  const resource = useResource(load);
  const [form, setForm] = useState<ProductForm>(EMPTY_PRODUCT_FORM);
  const [extraCategories, setExtraCategories] = useState<readonly Category[]>([]);
  const [issues, setIssues] = useState<Issues>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (resource.state.status === 'loading') return <LoadingState t={t} rows={8} />;
  if (resource.state.status === 'error') {
    return <ErrorState error={resource.state.error} t={t} onRetry={resource.reload} />;
  }
  const refs = {
    ...resource.state.value,
    categories: [...resource.state.value.categories, ...extraCategories],
  };

  const update = (patch: Partial<ProductForm>): void => {
    const next = { ...form, ...patch };
    setForm(next);
    if (Object.keys(issues).length > 0) setIssues(validateProductForm(next, true));
  };
  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const found = validateProductForm(form, true);
    setIssues(found);
    setError(null);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    fetchOne<ProductDetail>('/products', { locale, method: 'POST', body: productBody(form) })
      .then((created) => {
        router.push(productPath(locale, created.id));
      })
      .catch((failure: unknown) => {
        setBusy(false);
        const { issues: mapped, message } = refusal(failure, t, locale);
        setIssues(mapped);
        setError(message);
      });
  };

  return (
    <Card>
      <form onSubmit={submit} noValidate>
        {error === null ? null : (
          <Alert tone="danger" title={t('validation.generic_title')}>
            {error}
          </Alert>
        )}
        <ProductFields
          locale={locale}
          t={t}
          form={form}
          issues={issues}
          refs={refs}
          creating
          onChange={update}
          onCategoryCreated={(category) => {
            setExtraCategories([...extraCategories, category]);
            update({ category_id: category.id });
          }}
        />
        <div className="tasks-toolbar">
          <Button type="submit" loading={busy}>
            {t('inventory.create_product')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** Edit a product (every documented field except a quantity, which does not exist). */
export function EditProductDialog({
  locale,
  t,
  product,
  refs,
  onClose,
  onSaved,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly product: Product;
  readonly refs: CatalogueRefs;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}): React.JSX.Element {
  const [form, setForm] = useState<ProductForm>(formFromProduct(product));
  const [extraCategories, setExtraCategories] = useState<readonly Category[]>([]);
  const [issues, setIssues] = useState<Issues>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const update = (patch: Partial<ProductForm>): void => {
    const next = { ...form, ...patch };
    setForm(next);
    if (Object.keys(issues).length > 0) setIssues(validateProductForm(next, false));
  };
  const submit = (): void => {
    const found = validateProductForm(form, false);
    setIssues(found);
    setError(null);
    if (Object.keys(found).length > 0) return;
    const body = productBody(form, product);
    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    fetchOne<ProductDetail>(`/products/${product.id}`, { locale, method: 'PATCH', body })
      .then(onSaved)
      .catch((failure: unknown) => {
        setBusy(false);
        const { issues: mapped, message } = refusal(failure, t, locale);
        setIssues(mapped);
        setError(message);
      });
  };
  return (
    <Modal
      open
      title={t('inventory.edit_product')}
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
      {error === null ? null : (
        <Alert tone="danger" title={t('validation.generic_title')}>
          {error}
        </Alert>
      )}
      <ProductFields
        locale={locale}
        t={t}
        form={form}
        issues={issues}
        refs={{ ...refs, categories: [...refs.categories, ...extraCategories] }}
        creating={false}
        onChange={update}
        onCategoryCreated={(category) => {
          setExtraCategories([...extraCategories, category]);
          update({ category_id: category.id });
        }}
      />
    </Modal>
  );
}

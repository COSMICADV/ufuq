'use client';

import { createTranslator } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';
import { useCallback, useRef, useState } from 'react';

import { ApiError, issueKeys } from '../../lib/api-client';
import { encode, FULL_CROP, isImage, loadBitmap, render } from '../../lib/image-prep';
import {
  isMoney,
  itemImageUrl,
  loadMenu,
  removeItemImage,
  saveCategory,
  saveItem,
  uploadItemImage,
} from '../../lib/restaurant';
import type { Menu, MenuCategory, MenuItem, RestaurantMe } from '../../lib/restaurant';
import { Badge, Button, Field, Input, Modal, Textarea, Toggle } from '../design-system';
import { ErrorState, LoadingState } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';

import { money, RestaurantGate, restaurantBase } from './restaurant-parts';
import type { Surface } from './restaurant-parts';

const SUGGESTED = [
  'Burgers',
  'Pizza',
  'Sandwiches',
  'Main courses',
  'Desserts',
  'Drinks',
  'Coffee',
  'Extras',
] as const;

/** `/admin/restaurant/menu` — the owner's visual menu: categories, item cards with photos, sizes, extras and recipes. */
export function MenuManager({
  locale,
  surface,
}: {
  readonly locale: Locale;
  readonly surface: Surface;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const title = t('restaurant.menu.title');
  return (
    <RestaurantGate
      locale={locale}
      title={title}
      need="owner"
      description={t('restaurant.menu.help')}
      crumbs={[
        {
          label: t('restaurant.home.title'),
          href: `${restaurantBase(locale, surface)}/restaurant`,
        },
        { label: title },
      ]}
      wide
    >
      {(me) => <Manager locale={locale} t={t} me={me} />}
    </RestaurantGate>
  );
}

function Manager({
  locale,
  t,
  me,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly me: RestaurantMe;
}): React.JSX.Element {
  const load = useCallback((signal: AbortSignal) => loadMenu(locale, true, signal), [locale]);
  const menu = useResource(load);
  const [category, setCategory] = useState<string | null>(null);
  const [editing, setEditing] = useState<MenuItem | 'new' | null>(null);
  const [editingCategory, setEditingCategory] = useState<MenuCategory | 'new' | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  if (menu.state.status === 'loading') return <LoadingState t={t} rows={6} />;
  if (menu.state.status === 'error')
    return <ErrorState t={t} error={menu.state.error} onRetry={menu.reload} />;
  const value = menu.state.value;
  const categories = value.categories.filter((c) => showArchived || !c.archived);
  const current = categories.find((c) => c.id === category) ?? categories[0] ?? null;
  const items = value.items.filter(
    (i) => i.category_id === current?.id && (showArchived || !i.archived),
  );

  return (
    <div className="menu-manager">
      {value.categories.length === 0 ? (
        <div className="restaurant-setup">
          <h2>{t('restaurant.menu.start_title')}</h2>
          <p>{t('restaurant.menu.start_help')}</p>
          <div className="restaurant-days">
            {SUGGESTED.map((name) => (
              <button
                key={name}
                type="button"
                className="restaurant-chip"
                onClick={() =>
                  void saveCategory(locale, null, {
                    name: t(`restaurant.menu.suggested.${name.toLowerCase().replace(' ', '_')}`),
                  }).then(menu.replace, () => undefined)
                }
              >
                + {t(`restaurant.menu.suggested.${name.toLowerCase().replace(' ', '_')}`)}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div className="menu-manager__bar">
        <div
          className="pos__categories"
          role="tablist"
          aria-label={t('restaurant.menu.categories')}
        >
          {categories.map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={current?.id === c.id}
              className={`restaurant-chip${c.archived ? ' restaurant-chip--muted' : ''}`}
              onClick={() => setCategory(c.id)}
            >
              {c.name} <span className="kds__count">{c.item_count}</span>
            </button>
          ))}
          <button
            type="button"
            className="restaurant-chip restaurant-chip--add"
            onClick={() => setEditingCategory('new')}
          >
            + {t('restaurant.menu.add_category')}
          </button>
        </div>
        <div className="menu-manager__actions">
          <Toggle
            label={t('restaurant.menu.show_archived')}
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          {current ? (
            <Button variant="secondary" size="sm" onClick={() => setEditingCategory(current)}>
              {t('restaurant.menu.edit_category')}
            </Button>
          ) : null}
          <Button disabled={!current} onClick={() => setEditing('new')}>
            {t('restaurant.menu.add_item')}
          </Button>
        </div>
      </div>

      {current && items.length === 0 ? (
        <p className="restaurant-empty">{t('restaurant.menu.no_items')}</p>
      ) : null}
      <ul className="pos__grid menu-manager__grid">
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className={`pos__product${item.archived ? ' pos__product--archived' : ''}`}
              onClick={() => setEditing(item)}
            >
              <span className="pos__photo">
                {item.image_version !== null ? (
                  <img src={itemImageUrl(item.id, item.image_version)} alt="" loading="lazy" />
                ) : (
                  <span aria-hidden="true">📷</span>
                )}
              </span>
              <span className="pos__name">{item.name}</span>
              <span className="pos__price">
                {item.sizes.length > 0
                  ? item.sizes.map((s) => `${s.name} ${money(s.price, me, locale)}`).join(' · ')
                  : money(item.price, me, locale)}
              </span>
              <span className="menu-manager__badges">
                {!item.available ? (
                  <Badge tone="warning">{t('restaurant.menu.unavailable')}</Badge>
                ) : null}
                {item.archived ? <Badge tone="cancelled">{t('restaurant.archived')}</Badge> : null}
                {item.options.length > 0 ? (
                  <Badge tone="info">
                    {t('restaurant.menu.options_count', { count: String(item.options.length) })}
                  </Badge>
                ) : null}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {editing && current ? (
        <ItemDialog
          locale={locale}
          t={t}
          menu={value}
          item={editing === 'new' ? null : editing}
          categoryId={current.id}
          onClose={() => setEditing(null)}
          onSaved={() => {
            menu.refresh();
          }}
          onDone={() => {
            setEditing(null);
            menu.refresh();
          }}
        />
      ) : null}
      {editingCategory ? (
        <CategoryDialog
          locale={locale}
          t={t}
          category={editingCategory === 'new' ? null : editingCategory}
          onClose={() => setEditingCategory(null)}
          onSaved={(next) => {
            menu.replace(next);
            setEditingCategory(null);
          }}
        />
      ) : null}
    </div>
  );
}

function CategoryDialog({
  locale,
  t,
  category,
  onClose,
  onSaved,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly category: MenuCategory | null;
  readonly onClose: () => void;
  readonly onSaved: (menu: Menu) => void;
}): React.JSX.Element {
  const [name, setName] = useState(category?.name ?? '');
  const [order, setOrder] = useState(String(category?.sort_order ?? ''));
  const [archived, setArchived] = useState(category?.archived ?? false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (): Promise<void> => {
    if (!name.trim()) {
      setError(t('validation.required'));
      return;
    }
    const sort = order.trim() === '' ? undefined : Number.parseInt(order, 10);
    setBusy(true);
    try {
      onSaved(
        await saveCategory(locale, category?.id ?? null, {
          name: name.trim(),
          ...(sort !== undefined && Number.isInteger(sort) && sort >= 0
            ? { sort_order: sort }
            : {}),
          ...(category ? { archived } : {}),
        }),
      );
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.fields.name
          ? t('validation.already_taken')
          : t('restaurant.save_failed'),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title={category ? t('restaurant.menu.edit_category') : t('restaurant.menu.add_category')}
      onClose={onClose}
      closeLabel={t('restaurant.close')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('restaurant.cancel')}
          </Button>
          <Button loading={busy} onClick={() => void save()}>
            {t('restaurant.save')}
          </Button>
        </>
      }
    >
      <div className="restaurant-form">
        <Field label={t('restaurant.menu.category_name')} required {...(error ? { error } : {})}>
          <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('restaurant.menu.position')} helper={t('restaurant.menu.position_help')}>
          <Input
            value={order}
            inputMode="numeric"
            dir="ltr"
            onChange={(e) => setOrder(e.target.value)}
          />
        </Field>
        {category ? (
          <Toggle
            label={t('restaurant.menu.archive_category')}
            checked={archived}
            onChange={(e) => setArchived(e.target.checked)}
          />
        ) : null}
      </div>
    </Modal>
  );
}

interface Row {
  readonly key: number;
  name: string;
  price: string;
}

let rowKey = 0;
function row(name = '', price = ''): Row {
  rowKey += 1;
  return { key: rowKey, name, price };
}

function RowsEditor({
  t,
  legend,
  rows,
  onChange,
  namePlaceholder,
  addLabel,
  error,
}: {
  readonly t: Translator;
  readonly legend: string;
  readonly rows: readonly Row[];
  readonly onChange: (rows: Row[]) => void;
  readonly namePlaceholder: string;
  readonly addLabel: string;
  readonly error?: string;
}): React.JSX.Element {
  return (
    <fieldset className="menu-rows">
      <legend>{legend}</legend>
      {rows.map((r, index) => (
        <div key={r.key} className="menu-rows__row">
          <Input
            value={r.name}
            maxLength={80}
            placeholder={namePlaceholder}
            aria-label={`${legend} ${String(index + 1)}`}
            onChange={(e) =>
              onChange(rows.map((x) => (x.key === r.key ? { ...x, name: e.target.value } : x)))
            }
          />
          <Input
            value={r.price}
            dir="ltr"
            inputMode="decimal"
            placeholder="0.00"
            aria-label={t('restaurant.menu.price')}
            onChange={(e) =>
              onChange(rows.map((x) => (x.key === r.key ? { ...x, price: e.target.value } : x)))
            }
          />
          <button
            type="button"
            className="icon-button"
            aria-label={t('restaurant.remove')}
            onClick={() => onChange(rows.filter((x) => x.key !== r.key))}
          >
            ×
          </button>
        </div>
      ))}
      {error ? <p className="pos-chooser__error">{error}</p> : null}
      <button
        type="button"
        className="restaurant-chip restaurant-chip--add"
        onClick={() => onChange([...rows, row()])}
      >
        + {addLabel}
      </button>
    </fieldset>
  );
}

function ItemDialog({
  locale,
  t,
  menu,
  item,
  categoryId,
  onClose,
  onSaved,
  onDone,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly menu: Menu;
  readonly item: MenuItem | null;
  readonly categoryId: string;
  readonly onClose: () => void;
  readonly onSaved: () => void;
  readonly onDone: () => void;
}): React.JSX.Element {
  const [saved, setSaved] = useState<MenuItem | null>(item);
  const [name, setName] = useState(item?.name ?? '');
  const [category, setCategory] = useState(item?.category_id ?? categoryId);
  const [description, setDescription] = useState(item?.description ?? '');
  const [price, setPrice] = useState(item?.price ?? '');
  const [sizes, setSizes] = useState<Row[]>(item?.sizes.map((s) => row(s.name, s.price)) ?? []);
  const [extras, setExtras] = useState<Row[]>(
    item?.options.filter((o) => o.kind === 'extra').map((o) => row(o.name, o.price)) ?? [],
  );
  const [customs, setCustoms] = useState<Row[]>(
    item?.options.filter((o) => o.kind === 'customization').map((o) => row(o.name, o.price)) ?? [],
  );
  const [ingredients, setIngredients] = useState(item?.ingredients ?? '');
  const [recipe, setRecipe] = useState(item?.recipe ?? '');
  const [prep, setPrep] = useState(item?.prep_instructions ?? '');
  const [available, setAvailable] = useState(item?.available ?? true);
  const [archived, setArchived] = useState(item?.archived ?? false);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const rowsOk = (rows: readonly Row[]): boolean =>
    rows.every((r) => r.name.trim() !== '' && isMoney(r.price || '0'));

  const save = async (): Promise<void> => {
    const problems: Record<string, string> = {};
    if (!name.trim()) problems.name = t('validation.required');
    if (sizes.length === 0 && !isMoney(price)) problems.price = t('validation.invalid');
    if (!rowsOk(sizes)) problems.sizes = t('restaurant.menu.rows_invalid');
    if (!rowsOk(extras)) problems.extras = t('restaurant.menu.rows_invalid');
    if (!rowsOk(customs)) problems.customs = t('restaurant.menu.rows_invalid');
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    setBusy(true);
    try {
      const result = await saveItem(locale, saved?.id ?? null, {
        category_id: category,
        name: name.trim(),
        description: description.trim() || null,
        price: sizes.length > 0 ? (isMoney(price) ? price.trim() : '0') : price.trim(),
        ingredients: ingredients.trim() || null,
        recipe: recipe.trim() || null,
        prep_instructions: prep.trim() || null,
        available,
        ...(saved ? { archived } : {}),
        sizes: sizes.map((s) => ({ name: s.name.trim(), price: s.price.trim() })),
        options: [
          ...extras.map((o) => ({
            kind: 'extra' as const,
            name: o.name.trim(),
            price: (o.price || '0').trim(),
          })),
          ...customs.map((o) => ({
            kind: 'customization' as const,
            name: o.name.trim(),
            price: (o.price || '0').trim(),
          })),
        ],
      });
      const wasNew = saved === null;
      setSaved(result);
      onSaved();
      // A new item stays open so its photo can be added straight away.
      if (!wasNew) onDone();
    } catch (failure) {
      const mapped =
        failure instanceof ApiError
          ? Object.fromEntries(Object.entries(issueKeys(failure)).map(([k, v]) => [k, t(v)]))
          : {};
      setErrors(Object.keys(mapped).length > 0 ? mapped : { form: t('restaurant.save_failed') });
    } finally {
      setBusy(false);
    }
  };

  const choosePhoto = async (picked: File | undefined): Promise<void> => {
    if (!picked || !saved) return;
    if (!isImage(picked)) {
      setPhotoError(t('restaurant.menu.photo_type'));
      return;
    }
    setPhotoBusy(true);
    setPhotoError(null);
    try {
      const bitmap = await loadBitmap(picked);
      let blob: Blob;
      try {
        // A square-ish 1000 px JPEG: sharp on a POS screen and small to load.
        blob = await encode(render(bitmap, 0, FULL_CROP, { maxEdge: 1000 }));
      } finally {
        bitmap.close();
      }
      setSaved(await uploadItemImage(locale, saved.id, blob));
      onSaved();
    } catch (failure) {
      setPhotoError(
        failure instanceof ApiError && failure.fields.image
          ? t('restaurant.menu.photo_refused')
          : t('restaurant.menu.photo_failed'),
      );
    } finally {
      setPhotoBusy(false);
      if (file.current) file.current.value = '';
    }
  };

  const dropPhoto = async (): Promise<void> => {
    if (!saved) return;
    setPhotoBusy(true);
    try {
      setSaved(await removeItemImage(locale, saved.id));
      onSaved();
    } catch {
      setPhotoError(t('restaurant.menu.photo_failed'));
    } finally {
      setPhotoBusy(false);
    }
  };

  return (
    <Modal
      open
      title={saved ? saved.name : t('restaurant.menu.add_item')}
      onClose={saved && !item ? onDone : onClose}
      closeLabel={t('restaurant.close')}
      footer={
        <>
          <Button variant="ghost" onClick={saved && !item ? onDone : onClose}>
            {saved && !item ? t('restaurant.done') : t('restaurant.cancel')}
          </Button>
          <Button loading={busy} onClick={() => void save()}>
            {saved ? t('restaurant.save') : t('restaurant.menu.save_and_photo')}
          </Button>
        </>
      }
    >
      <div className="restaurant-form menu-item-form">
        <section className="menu-photo">
          <span className="pos__photo menu-photo__preview">
            {saved && saved.image_version !== null ? (
              <img src={itemImageUrl(saved.id, saved.image_version)} alt="" />
            ) : (
              <span aria-hidden="true">📷</span>
            )}
          </span>
          <div>
            <strong>{t('restaurant.menu.photo')}</strong>
            <p className="medical-muted">
              {saved ? t('restaurant.menu.photo_help') : t('restaurant.menu.photo_after_save')}
            </p>
            <input
              ref={file}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/heic"
              hidden
              onChange={(e) => void choosePhoto(e.target.files?.[0])}
            />
            <div className="medical-actions">
              <Button
                variant="secondary"
                size="sm"
                disabled={!saved}
                loading={photoBusy}
                onClick={() => file.current?.click()}
              >
                {(saved?.image_version ?? null) !== null
                  ? t('restaurant.menu.replace_photo')
                  : t('restaurant.menu.upload_photo')}
              </Button>
              {(saved?.image_version ?? null) !== null ? (
                <Button
                  variant="destructive-ghost"
                  size="sm"
                  disabled={photoBusy}
                  onClick={() => void dropPhoto()}
                >
                  {t('restaurant.menu.remove_photo')}
                </Button>
              ) : null}
            </div>
            {photoError ? <p className="pos-chooser__error">{photoError}</p> : null}
          </div>
        </section>

        <div className="restaurant-form__row">
          <Field
            label={t('restaurant.menu.name')}
            required
            {...(errors.name ? { error: errors.name } : {})}
          >
            <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field
            label={t('restaurant.menu.category')}
            required
            {...(errors.category_id ? { error: errors.category_id } : {})}
          >
            <select
              className="input"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              {menu.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label={t('restaurant.menu.description')}>
          <Textarea
            rows={2}
            maxLength={600}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        {sizes.length === 0 ? (
          <Field
            label={t('restaurant.menu.price')}
            required
            {...(errors.price ? { error: errors.price } : {})}
          >
            <Input
              value={price}
              dir="ltr"
              inputMode="decimal"
              placeholder="0.00"
              onChange={(e) => setPrice(e.target.value)}
            />
          </Field>
        ) : null}
        <RowsEditor
          t={t}
          legend={t('restaurant.menu.sizes')}
          rows={sizes}
          onChange={setSizes}
          namePlaceholder={t('restaurant.menu.size_hint')}
          addLabel={t('restaurant.menu.add_size')}
          {...(errors.sizes ? { error: errors.sizes } : {})}
        />
        <RowsEditor
          t={t}
          legend={t('restaurant.menu.extras')}
          rows={extras}
          onChange={setExtras}
          namePlaceholder={t('restaurant.menu.extra_hint')}
          addLabel={t('restaurant.menu.add_extra')}
          {...(errors.extras ? { error: errors.extras } : {})}
        />
        <RowsEditor
          t={t}
          legend={t('restaurant.menu.customizations')}
          rows={customs}
          onChange={setCustoms}
          namePlaceholder={t('restaurant.menu.custom_hint')}
          addLabel={t('restaurant.menu.add_custom')}
          {...(errors.customs ? { error: errors.customs } : {})}
        />
        <Field
          label={t('restaurant.menu.ingredients')}
          helper={t('restaurant.menu.ingredients_help')}
        >
          <Textarea
            rows={2}
            maxLength={1000}
            value={ingredients}
            onChange={(e) => setIngredients(e.target.value)}
          />
        </Field>
        <Field label={t('restaurant.menu.recipe')} helper={t('restaurant.menu.recipe_help')}>
          <Textarea
            rows={3}
            maxLength={4000}
            value={recipe}
            onChange={(e) => setRecipe(e.target.value)}
          />
        </Field>
        <Field label={t('restaurant.menu.prep')}>
          <Textarea
            rows={2}
            maxLength={2000}
            value={prep}
            onChange={(e) => setPrep(e.target.value)}
          />
        </Field>
        <Toggle
          label={t('restaurant.menu.available')}
          checked={available}
          onChange={(e) => setAvailable(e.target.checked)}
        />
        {saved && item ? (
          <Toggle
            label={t('restaurant.menu.archive_item')}
            checked={archived}
            onChange={(e) => setArchived(e.target.checked)}
          />
        ) : null}
        {saved && !item ? (
          <p className="medical-notice">{t('restaurant.menu.saved_add_photo')}</p>
        ) : null}
        {errors.form ? <p className="pos__failure">{errors.form}</p> : null}
      </div>
    </Modal>
  );
}

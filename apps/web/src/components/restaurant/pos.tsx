'use client';

import { createTranslator } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ApiError, issueKeys } from '../../lib/api-client';
import {
  cartTotals,
  createOrder,
  fromMinor,
  isMoney,
  itemImageUrl,
  loadMenu,
  loadTables,
  loadWaiters,
  newClientKey,
  toMinor,
} from '../../lib/restaurant';
import type {
  Menu,
  MenuItem,
  Order,
  OrderEvent,
  OrderType,
  PersonRef,
  RestaurantMe,
  Table,
} from '../../lib/restaurant';
import { Button, Field, Input, Modal, Select, Textarea } from '../design-system';
import { LoadingState } from '../settings/screen-states';

import {
  BranchPicker,
  canDo,
  LiveIndicator,
  money,
  RestaurantGate,
  restaurantBase,
  SoundToggle,
  StatusBadge,
  useLiveOrders,
  useSound,
  useWorkBranch,
} from './restaurant-parts';
import type { Surface } from './restaurant-parts';

interface CartLine {
  readonly key: string;
  readonly item: MenuItem;
  readonly sizeId: string | null;
  readonly optionIds: readonly string[];
  readonly quantity: number;
  readonly notes: string;
}

function lineKey(
  itemId: string,
  sizeId: string | null,
  optionIds: readonly string[],
  notes: string,
): string {
  return [itemId, sizeId ?? '', [...optionIds].sort().join(','), notes.trim()].join('|');
}

function unitMinor(line: Pick<CartLine, 'item' | 'sizeId' | 'optionIds'>): bigint {
  const size = line.item.sizes.find((s) => s.id === line.sizeId);
  const base = toMinor(size ? size.price : line.item.price);
  return line.item.options
    .filter((o) => line.optionIds.includes(o.id))
    .reduce((sum, o) => sum + toMinor(o.price), base);
}

/** The lowest price an item can be ordered at — for "from 85 EGP" on its card. */
function fromPrice(item: MenuItem): string {
  if (item.sizes.length === 0) return item.price;
  return item.sizes.reduce(
    (low, s) => (toMinor(s.price) < toMinor(low) ? s.price : low),
    item.sizes[0]?.price ?? item.price,
  );
}

/** `/…/pos` — the cashier's visual point of sale. */
export function RestaurantPos({
  locale,
  surface,
}: {
  readonly locale: Locale;
  readonly surface: Surface;
}): React.JSX.Element {
  const t = createTranslator(locale);
  return (
    <RestaurantGate locale={locale} title={t('restaurant.pos.title')} need="orders.create" wide>
      {(me) => <PosScreen locale={locale} surface={surface} t={t} me={me} />}
    </RestaurantGate>
  );
}

function PosScreen({
  locale,
  surface,
  t,
  me,
}: {
  readonly locale: Locale;
  readonly surface: Surface;
  readonly t: Translator;
  readonly me: RestaurantMe;
}): React.JSX.Element {
  const [branch, chooseBranch] = useWorkBranch(me);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [menuError, setMenuError] = useState(false);
  const [tables, setTables] = useState<readonly Table[]>([]);
  const [waiters, setWaiters] = useState<readonly PersonRef[]>([]);
  const [category, setCategory] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [type, setType] = useState<OrderType>('takeaway');
  const [tableId, setTableId] = useState<string | null>(null);
  const [waiterId, setWaiterId] = useState<string>('default');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [address, setAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [discount, setDiscount] = useState('');
  const [cart, setCart] = useState<readonly CartLine[]>([]);
  const [choosing, setChoosing] = useState<MenuItem | null>(null);
  const [pickingTable, setPickingTable] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<Order | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  // One key per order being built: a retry of the same order cannot create a second one.
  const clientKey = useRef(newClientKey());
  const [sound, setSound, play] = useSound();
  const [alerts, setAlerts] = useState<readonly OrderEvent[]>([]);

  const branchId = branch?.id ?? null;

  const loadAll = useCallback(() => {
    setMenuError(false);
    loadMenu(locale).then(setMenu, () => setMenuError(true));
  }, [locale]);
  useEffect(loadAll, [loadAll]);

  const refreshTables = useCallback(() => {
    if (!branchId || !canDo(me, 'tables.view')) return;
    loadTables(locale, branchId).then(setTables, () => undefined);
  }, [locale, branchId, me]);
  useEffect(() => {
    refreshTables();
    if (branchId && canDo(me, 'tables.view'))
      loadWaiters(locale, branchId).then(setWaiters, () => undefined);
  }, [refreshTables, locale, branchId, me]);

  const onEvent = useCallback(
    (event: OrderEvent) => {
      if (event.kind === 'status' && event.status === 'ready' && event.type !== 'dine_in') {
        setAlerts((current) =>
          [event, ...current.filter((a) => a.order_id !== event.order_id)].slice(0, 5),
        );
        play('ready');
      }
      if (event.type === 'dine_in') refreshTables();
    },
    [play, refreshTables],
  );
  const live = useLiveOrders(locale, 'active', branchId, onEvent);

  const items = useMemo(() => {
    if (!menu) return [];
    const q = search.trim().toLocaleLowerCase();
    return menu.items.filter(
      (item) =>
        (category === 'all' || item.category_id === category) &&
        (q === '' ||
          item.name.toLocaleLowerCase().includes(q) ||
          (item.description ?? '').toLocaleLowerCase().includes(q)),
    );
  }, [menu, category, search]);

  const add = (
    item: MenuItem,
    sizeId: string | null,
    optionIds: readonly string[],
    quantity: number,
    lineNotes: string,
  ): void => {
    const key = lineKey(item.id, sizeId, optionIds, lineNotes);
    setCart((current) => {
      const existing = current.find((l) => l.key === key);
      if (existing)
        return current.map((l) =>
          l.key === key ? { ...l, quantity: Math.min(999, l.quantity + quantity) } : l,
        );
      return [...current, { key, item, sizeId, optionIds, quantity, notes: lineNotes.trim() }];
    });
    setConfirmed(null);
  };

  const tap = (item: MenuItem): void => {
    if (!item.available) return;
    if (item.sizes.length > 0 || item.options.length > 0) setChoosing(item);
    else add(item, null, [], 1, '');
  };

  const setQuantity = (key: string, quantity: number): void => {
    setCart((current) =>
      quantity <= 0
        ? current.filter((l) => l.key !== key)
        : current.map((l) => (l.key === key ? { ...l, quantity: Math.min(999, quantity) } : l)),
    );
  };

  const totals = cartTotals({
    lines: cart.map((l) => unitMinor(l) * BigInt(l.quantity)),
    discount: isMoney(discount) ? discount : '0',
    type,
    taxRate: branch?.tax_rate ?? '0',
    serviceRate: branch?.service_rate ?? '0',
  });
  const count = cart.reduce((sum, l) => sum + l.quantity, 0);
  const table = tables.find((x) => x.id === tableId) ?? null;

  const reset = (): void => {
    setCart([]);
    setNotes('');
    setDiscount('');
    setCustomerName('');
    setCustomerPhone('');
    setAddress('');
    setTableId(null);
    setWaiterId('default');
    setErrors({});
    setFailure(null);
    clientKey.current = newClientKey();
  };

  const confirm = async (): Promise<void> => {
    const problems: Record<string, string> = {};
    if (cart.length === 0) problems.items = t('restaurant.pos.empty_cart');
    if (type === 'dine_in' && !tableId) problems.table_id = t('restaurant.pos.choose_table_first');
    if (type === 'delivery') {
      if (!customerName.trim()) problems.customer_name = t('validation.required');
      if (!customerPhone.trim()) problems.customer_phone = t('validation.required');
      if (!address.trim()) problems.delivery_address = t('validation.required');
    }
    if (discount.trim() && !isMoney(discount)) problems.discount = t('validation.invalid');
    if (totals.discountTooLarge) problems.discount = t('restaurant.pos.discount_too_large');
    setErrors(problems);
    if (Object.keys(problems).length > 0 || !branch) return;
    setSubmitting(true);
    setFailure(null);
    try {
      const order = await createOrder(locale, {
        client_key: clientKey.current,
        branch_id: branch.id,
        type,
        ...(type === 'dine_in' && tableId ? { table_id: tableId } : {}),
        ...(type === 'dine_in' && waiterId !== 'default'
          ? { waiter_id: waiterId === 'none' ? null : waiterId }
          : {}),
        ...(customerName.trim() ? { customer_name: customerName.trim() } : {}),
        ...(customerPhone.trim() ? { customer_phone: customerPhone.trim() } : {}),
        ...(type === 'delivery' ? { delivery_address: address.trim() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        ...(discount.trim() && isMoney(discount) && toMinor(discount) > 0n
          ? { discount: fromMinor(toMinor(discount)) }
          : {}),
        items: cart.map((l) => ({
          menu_item_id: l.item.id,
          ...(l.sizeId ? { size_id: l.sizeId } : {}),
          ...(l.optionIds.length > 0 ? { option_ids: l.optionIds } : {}),
          quantity: l.quantity,
          ...(l.notes ? { notes: l.notes } : {}),
        })),
      });
      setConfirmed(order);
      reset();
      setCartOpen(false);
      live.reload();
      refreshTables();
    } catch (error) {
      if (error instanceof ApiError && error.status === 422) {
        const mapped = issueKeys(error);
        setErrors(Object.fromEntries(Object.entries(mapped).map(([k, v]) => [k, t(v)])));
        setFailure(t('restaurant.pos.check_order'));
        // The menu may have changed under the cashier (an item made unavailable).
        loadAll();
      } else {
        // Network failure: the same key is kept, so trying again cannot duplicate the order.
        setFailure(t('restaurant.pos.send_failed'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const base = restaurantBase(locale, surface);
  const active = live.orders ?? [];

  return (
    <div className="pos">
      <div className="pos__toolbar">
        <BranchPicker t={t} me={me} branch={branch} onChange={chooseBranch} />
        <LiveIndicator t={t} live={live.live} />
        <SoundToggle t={t} on={sound} onChange={setSound} />
        {canDo(me, 'pickup') ? (
          <Link className="restaurant-chip" href={`${base}/pickup`}>
            {t('restaurant.nav.pickup')}
          </Link>
        ) : null}
        <Link className="restaurant-chip" href={`${base}/orders`}>
          {t('restaurant.nav.orders')}
        </Link>
      </div>

      {alerts.length > 0 ? (
        <div className="pos__alerts" role="alert">
          {alerts.map((a) => (
            <span key={a.order_id} className="pos__alert">
              {t(
                a.type === 'delivery'
                  ? 'restaurant.pos.ready_delivery'
                  : 'restaurant.pos.ready_pickup',
                { number: String(a.number) },
              )}
              <button
                type="button"
                aria-label={t('restaurant.dismiss')}
                onClick={() => setAlerts((c) => c.filter((x) => x.order_id !== a.order_id))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <div className="pos__body">
        <section className="pos__menu" aria-label={t('restaurant.pos.menu')}>
          <div className="pos__types" role="radiogroup" aria-label={t('restaurant.pos.order_type')}>
            {(['dine_in', 'takeaway', 'delivery'] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={type === value}
                className="pos__type"
                disabled={value === 'dine_in' && !canDo(me, 'tables.view')}
                onClick={() => {
                  setType(value);
                  setErrors({});
                  if (value === 'dine_in' && !tableId) setPickingTable(true);
                }}
              >
                <span aria-hidden="true">
                  {value === 'dine_in' ? '🍽️' : value === 'takeaway' ? '🛍️' : '🛵'}
                </span>
                {t(`restaurant.type.${value}`)}
              </button>
            ))}
          </div>
          <div className="pos__filters">
            <input
              type="search"
              className="input pos__search"
              placeholder={t('restaurant.pos.search')}
              aria-label={t('restaurant.pos.search')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div
              className="pos__categories"
              role="tablist"
              aria-label={t('restaurant.menu.categories')}
            >
              <button
                type="button"
                role="tab"
                aria-selected={category === 'all'}
                className="restaurant-chip"
                onClick={() => setCategory('all')}
              >
                {t('restaurant.pos.all')}
              </button>
              {menu?.categories.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="tab"
                  aria-selected={category === c.id}
                  className="restaurant-chip"
                  onClick={() => setCategory(c.id)}
                >
                  {c.name}
                </button>
              ))}
            </div>
          </div>
          {menuError ? (
            <div className="restaurant-error" role="alert">
              <p>{t('restaurant.load_failed')}</p>
              <Button variant="secondary" size="sm" onClick={loadAll}>
                {t('restaurant.retry')}
              </Button>
            </div>
          ) : !menu ? (
            <LoadingState t={t} rows={4} />
          ) : menu.items.length === 0 ? (
            <p className="restaurant-empty">
              {t('restaurant.pos.no_menu')}{' '}
              {me.owner ? (
                <Link href={`${base}/restaurant/menu`}>{t('restaurant.pos.build_menu')}</Link>
              ) : null}
            </p>
          ) : items.length === 0 ? (
            <p className="restaurant-empty">{t('restaurant.pos.no_match')}</p>
          ) : (
            <ul className="pos__grid">
              {items.map((item) => {
                const inCart = cart
                  .filter((l) => l.item.id === item.id)
                  .reduce((s, l) => s + l.quantity, 0);
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="pos__product"
                      disabled={!item.available}
                      onClick={() => tap(item)}
                    >
                      <span className="pos__photo">
                        {item.image_version !== null ? (
                          <img
                            src={itemImageUrl(item.id, item.image_version)}
                            alt=""
                            loading="lazy"
                          />
                        ) : (
                          <span aria-hidden="true">{item.name.slice(0, 1)}</span>
                        )}
                        {inCart > 0 ? <span className="pos__count">{inCart}</span> : null}
                      </span>
                      <span className="pos__name">{item.name}</span>
                      <span className="pos__price">
                        {item.sizes.length > 0
                          ? t('restaurant.pos.from', { price: money(fromPrice(item), me, locale) })
                          : money(item.price, me, locale)}
                      </span>
                      {!item.available ? (
                        <span className="pos__soldout">{t('restaurant.menu.unavailable')}</span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <aside
          className={`pos__cart${cartOpen ? ' pos__cart--open' : ''}`}
          aria-label={t('restaurant.pos.current_order')}
        >
          <header className="pos__cart-head">
            <h2>{t('restaurant.pos.current_order')}</h2>
            <button
              type="button"
              className="icon-button pos__cart-close"
              onClick={() => setCartOpen(false)}
              aria-label={t('restaurant.close')}
            >
              ×
            </button>
          </header>

          {confirmed ? (
            <div className="pos__confirmed" role="status">
              <strong>{t('restaurant.pos.sent', { number: String(confirmed.number) })}</strong>
              <span>{t('restaurant.pos.sent_help')}</span>
            </div>
          ) : null}

          <div className="pos__details">
            {type === 'dine_in' ? (
              <>
                <Field
                  label={t('restaurant.pos.table')}
                  required
                  {...(errors.table_id ? { error: errors.table_id } : {})}
                >
                  <button
                    type="button"
                    className="input pos__table-button"
                    onClick={() => setPickingTable(true)}
                  >
                    {table
                      ? t('restaurant.table_short', { label: table.label })
                      : t('restaurant.pos.choose_table')}
                  </button>
                </Field>
                {canDo(me, 'waiter.assign') && waiters.length > 0 ? (
                  <Field
                    label={t('restaurant.pos.waiter')}
                    {...(errors.waiter_id ? { error: errors.waiter_id } : {})}
                  >
                    <Select value={waiterId} onChange={(e) => setWaiterId(e.target.value)}>
                      <option value="default">
                        {table?.default_waiter
                          ? t('restaurant.pos.table_waiter', { name: table.default_waiter.name })
                          : t('restaurant.pos.no_default_waiter')}
                      </option>
                      {waiters.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                      <option value="none">{t('restaurant.pos.any_waiter')}</option>
                    </Select>
                  </Field>
                ) : null}
              </>
            ) : null}
            {type !== 'dine_in' ? (
              <div className="pos__customer">
                <Field
                  label={t('restaurant.pos.customer_name')}
                  required={type === 'delivery'}
                  {...(errors.customer_name ? { error: errors.customer_name } : {})}
                >
                  <Input
                    value={customerName}
                    maxLength={120}
                    onChange={(e) => setCustomerName(e.target.value)}
                    autoComplete="off"
                  />
                </Field>
                <Field
                  label={t('restaurant.pos.customer_phone')}
                  required={type === 'delivery'}
                  {...(errors.customer_phone ? { error: errors.customer_phone } : {})}
                >
                  <Input
                    value={customerPhone}
                    maxLength={40}
                    inputMode="tel"
                    dir="ltr"
                    onChange={(e) => setCustomerPhone(e.target.value)}
                    autoComplete="off"
                  />
                </Field>
              </div>
            ) : null}
            {type === 'delivery' ? (
              <Field
                label={t('restaurant.pos.address')}
                required
                {...(errors.delivery_address ? { error: errors.delivery_address } : {})}
              >
                <Textarea
                  value={address}
                  maxLength={400}
                  rows={2}
                  onChange={(e) => setAddress(e.target.value)}
                />
              </Field>
            ) : null}
          </div>

          {cart.length === 0 ? (
            <p className={`pos__empty${errors.items ? ' pos__empty--error' : ''}`}>
              {errors.items ?? t('restaurant.pos.tap_to_add')}
            </p>
          ) : (
            <ul className="pos__lines">
              {cart.map((line) => {
                const size = line.item.sizes.find((s) => s.id === line.sizeId);
                const options = line.item.options.filter((o) => line.optionIds.includes(o.id));
                return (
                  <li key={line.key} className="pos__line">
                    <div className="pos__line-main">
                      <strong>{line.item.name}</strong>
                      {size || options.length > 0 ? (
                        <small>
                          {[
                            size?.name,
                            ...options.map((o) => (o.kind === 'extra' ? `+ ${o.name}` : o.name)),
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </small>
                      ) : null}
                      {line.notes ? <small className="pos__line-note">“{line.notes}”</small> : null}
                    </div>
                    <div className="pos__qty">
                      <button
                        type="button"
                        aria-label={t('restaurant.pos.less')}
                        onClick={() => setQuantity(line.key, line.quantity - 1)}
                      >
                        −
                      </button>
                      <span aria-live="polite">{line.quantity}</span>
                      <button
                        type="button"
                        aria-label={t('restaurant.pos.more')}
                        onClick={() => setQuantity(line.key, line.quantity + 1)}
                      >
                        +
                      </button>
                    </div>
                    <span className="pos__line-total">
                      {money(fromMinor(unitMinor(line) * BigInt(line.quantity)), me, locale)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="pos__extras">
            <Field label={t('restaurant.pos.notes')}>
              <Input
                value={notes}
                maxLength={500}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={t('restaurant.pos.notes_hint')}
              />
            </Field>
            <Field
              label={t('restaurant.pos.discount')}
              {...(errors.discount ? { error: errors.discount } : {})}
            >
              <Input
                value={discount}
                inputMode="decimal"
                dir="ltr"
                placeholder="0.00"
                onChange={(e) => setDiscount(e.target.value)}
              />
            </Field>
          </div>

          <dl className="pos__totals">
            <div>
              <dt>{t('restaurant.totals.subtotal')}</dt>
              <dd>{money(totals.subtotal, me, locale)}</dd>
            </div>
            {toMinor(totals.discount) > 0n ? (
              <div>
                <dt>{t('restaurant.totals.discount')}</dt>
                <dd>−{money(totals.discount, me, locale)}</dd>
              </div>
            ) : null}
            {type === 'dine_in' && toMinor(branch?.service_rate ?? '0') > 0n ? (
              <div>
                <dt>{t('restaurant.totals.service', { rate: branch?.service_rate ?? '0' })}</dt>
                <dd>{money(totals.service, me, locale)}</dd>
              </div>
            ) : null}
            {toMinor(branch?.tax_rate ?? '0') > 0n ? (
              <div>
                <dt>{t('restaurant.totals.tax', { rate: branch?.tax_rate ?? '0' })}</dt>
                <dd>{money(totals.tax, me, locale)}</dd>
              </div>
            ) : null}
            <div className="pos__grand">
              <dt>{t('restaurant.totals.total')}</dt>
              <dd>{money(totals.total, me, locale)}</dd>
            </div>
          </dl>

          {failure ? (
            <p className="pos__failure" role="alert">
              {failure}
            </p>
          ) : null}
          <div className="pos__actions">
            <Button variant="ghost" onClick={reset} disabled={submitting || cart.length === 0}>
              {t('restaurant.pos.clear')}
            </Button>
            <Button
              size="lg"
              className="pos__confirm"
              loading={submitting}
              onClick={() => void confirm()}
            >
              {t('restaurant.pos.confirm', { total: money(totals.total, me, locale) })}
            </Button>
          </div>

          {active.length > 0 ? (
            <section className="pos__active" aria-label={t('restaurant.pos.active_orders')}>
              <h3>{t('restaurant.pos.active_orders')}</h3>
              <ul>
                {active
                  .slice()
                  .reverse()
                  .slice(0, 8)
                  .map((o) => (
                    <li key={o.id}>
                      <span className="pos__active-number">#{o.number}</span>
                      <span>
                        {o.type === 'dine_in' && o.table
                          ? t('restaurant.table_short', { label: o.table.label })
                          : (o.customer_name ?? t(`restaurant.type.${o.type}`))}
                      </span>
                      <StatusBadge t={t} status={o.status} type={o.type} />
                    </li>
                  ))}
              </ul>
            </section>
          ) : null}
        </aside>
      </div>

      <button type="button" className="pos__cart-bar" onClick={() => setCartOpen(true)}>
        <span>{t('restaurant.pos.view_order', { count: String(count) })}</span>
        <strong>{money(totals.total, me, locale)}</strong>
      </button>

      {choosing ? (
        <ItemChooser
          t={t}
          me={me}
          locale={locale}
          item={choosing}
          onClose={() => setChoosing(null)}
          onAdd={(sizeId, optionIds, quantity, lineNotes) => {
            add(choosing, sizeId, optionIds, quantity, lineNotes);
            setChoosing(null);
          }}
        />
      ) : null}

      <TablePicker
        t={t}
        open={pickingTable}
        tables={tables}
        selected={tableId}
        onClose={() => setPickingTable(false)}
        onPick={(id) => {
          setTableId(id);
          setPickingTable(false);
          setErrors((e) => {
            const { table_id: _removed, ...rest } = e;
            return rest;
          });
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

function ItemChooser({
  t,
  me,
  locale,
  item,
  onClose,
  onAdd,
}: {
  readonly t: Translator;
  readonly me: RestaurantMe;
  readonly locale: Locale;
  readonly item: MenuItem;
  readonly onClose: () => void;
  readonly onAdd: (
    sizeId: string | null,
    optionIds: readonly string[],
    quantity: number,
    notes: string,
  ) => void;
}): React.JSX.Element {
  const [sizeId, setSizeId] = useState<string | null>(
    item.sizes.length === 1 ? (item.sizes[0]?.id ?? null) : null,
  );
  const [optionIds, setOptionIds] = useState<readonly string[]>([]);
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState('');
  const [missingSize, setMissingSize] = useState(false);
  const extras = item.options.filter((o) => o.kind === 'extra');
  const customizations = item.options.filter((o) => o.kind === 'customization');
  const unit = unitMinor({ item, sizeId, optionIds });
  const toggle = (id: string): void =>
    setOptionIds((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
    );
  const submit = (): void => {
    if (item.sizes.length > 0 && !sizeId) {
      setMissingSize(true);
      return;
    }
    onAdd(sizeId, optionIds, quantity, notes);
  };
  return (
    <Modal
      open
      title={item.name}
      onClose={onClose}
      closeLabel={t('restaurant.close')}
      footer={
        <div className="pos-chooser__footer">
          <div className="pos__qty pos__qty--lg">
            <button
              type="button"
              aria-label={t('restaurant.pos.less')}
              onClick={() => setQuantity((q) => Math.max(1, q - 1))}
            >
              −
            </button>
            <span aria-live="polite">{quantity}</span>
            <button
              type="button"
              aria-label={t('restaurant.pos.more')}
              onClick={() => setQuantity((q) => Math.min(999, q + 1))}
            >
              +
            </button>
          </div>
          <Button size="lg" onClick={submit}>
            {t('restaurant.pos.add_to_order', {
              total: money(fromMinor(unit * BigInt(quantity)), me, locale),
            })}
          </Button>
        </div>
      }
    >
      <div className="pos-chooser">
        {item.image_version !== null ? (
          <img
            className="pos-chooser__photo"
            src={itemImageUrl(item.id, item.image_version)}
            alt=""
          />
        ) : null}
        {item.description ? <p className="pos-chooser__description">{item.description}</p> : null}
        {item.sizes.length > 0 ? (
          <fieldset
            className={`pos-chooser__group${missingSize ? ' pos-chooser__group--error' : ''}`}
          >
            <legend>
              {t('restaurant.pos.size')}{' '}
              <span className="pos-chooser__required">{t('restaurant.pos.required')}</span>
            </legend>
            <div className="pos-chooser__options">
              {item.sizes.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="pos-option"
                  aria-pressed={sizeId === s.id}
                  onClick={() => {
                    setSizeId(s.id);
                    setMissingSize(false);
                  }}
                >
                  <span>{s.name}</span>
                  <small>{money(s.price, me, locale)}</small>
                </button>
              ))}
            </div>
            {missingSize ? (
              <p className="pos-chooser__error">{t('restaurant.pos.choose_size')}</p>
            ) : null}
          </fieldset>
        ) : null}
        {extras.length > 0 ? (
          <fieldset className="pos-chooser__group">
            <legend>{t('restaurant.menu.extras')}</legend>
            <div className="pos-chooser__options">
              {extras.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  className="pos-option"
                  aria-pressed={optionIds.includes(o.id)}
                  onClick={() => toggle(o.id)}
                >
                  <span>{o.name}</span>
                  <small>
                    {toMinor(o.price) > 0n
                      ? `+ ${money(o.price, me, locale)}`
                      : t('restaurant.free')}
                  </small>
                </button>
              ))}
            </div>
          </fieldset>
        ) : null}
        {customizations.length > 0 ? (
          <fieldset className="pos-chooser__group">
            <legend>{t('restaurant.menu.customizations')}</legend>
            <div className="pos-chooser__options">
              {customizations.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  className="pos-option"
                  aria-pressed={optionIds.includes(o.id)}
                  onClick={() => toggle(o.id)}
                >
                  <span>{o.name}</span>
                  {toMinor(o.price) > 0n ? <small>+ {money(o.price, me, locale)}</small> : null}
                </button>
              ))}
            </div>
          </fieldset>
        ) : null}
        <Field label={t('restaurant.pos.item_notes')}>
          <Input
            value={notes}
            maxLength={300}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t('restaurant.pos.item_notes_hint')}
          />
        </Field>
      </div>
    </Modal>
  );
}

function TablePicker({
  t,
  open,
  tables,
  selected,
  onClose,
  onPick,
}: {
  readonly t: Translator;
  readonly open: boolean;
  readonly tables: readonly Table[];
  readonly selected: string | null;
  readonly onClose: () => void;
  readonly onPick: (id: string) => void;
}): React.JSX.Element | null {
  return (
    <Modal
      open={open}
      title={t('restaurant.pos.choose_table')}
      onClose={onClose}
      closeLabel={t('restaurant.close')}
    >
      {tables.length === 0 ? (
        <p className="restaurant-empty">{t('restaurant.tables.none')}</p>
      ) : (
        <ul className="table-grid table-grid--pick">
          {tables.map((table) => (
            <li key={table.id}>
              <button
                type="button"
                className={`table-tile${table.occupied_by ? ' table-tile--busy' : ''}`}
                aria-pressed={selected === table.id}
                onClick={() => onPick(table.id)}
              >
                <strong>{table.label}</strong>
                <small>{t('restaurant.tables.seats', { count: String(table.seats) })}</small>
                <small>
                  {table.occupied_by
                    ? t('restaurant.tables.occupied', { number: String(table.occupied_by.number) })
                    : t('restaurant.tables.free')}
                </small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

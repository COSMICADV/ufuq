'use client';

import { createTranslator } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';
import { useCallback, useState } from 'react';

import { FULFILMENT, setOrderStatus } from '../../lib/restaurant';
import type { Order, OrderEvent, RestaurantMe } from '../../lib/restaurant';
import { Button } from '../design-system';

import {
  BranchPicker,
  canDo,
  clock,
  lineDetail,
  ListState,
  LiveIndicator,
  minutesSince,
  RestaurantGate,
  SoundToggle,
  StatusBadge,
  TypeTag,
  useLiveOrders,
  useNow,
  useSound,
  useWorkBranch,
} from './restaurant-parts';
import type { Surface } from './restaurant-parts';

/** `/…/waiter` — dine-in orders: ready ones to serve first, then those still in the kitchen. */
export function WaiterBoard({
  locale,
}: {
  readonly locale: Locale;
  readonly surface: Surface;
}): React.JSX.Element {
  const t = createTranslator(locale);
  return (
    <RestaurantGate locale={locale} title={t('restaurant.waiter.title')} need="waiter.view" wide>
      {(me) => <Handover locale={locale} t={t} me={me} mode="waiter" />}
    </RestaurantGate>
  );
}

/** `/…/pickup` — take-away and delivery orders: ready ones to hand over, then those still in the kitchen. */
export function PickupBoard({
  locale,
}: {
  readonly locale: Locale;
  readonly surface: Surface;
}): React.JSX.Element {
  const t = createTranslator(locale);
  return (
    <RestaurantGate
      locale={locale}
      title={t('restaurant.pickup.title')}
      need={['pickup', 'deliver']}
      wide
    >
      {(me) => <Handover locale={locale} t={t} me={me} mode="pickup" />}
    </RestaurantGate>
  );
}

function Handover({
  locale,
  t,
  me,
  mode,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly me: RestaurantMe;
  readonly mode: 'waiter' | 'pickup';
}): React.JSX.Element {
  const [branch, chooseBranch] = useWorkBranch(me);
  const [sound, setSound, play] = useSound();
  const [alerts, setAlerts] = useState<readonly OrderEvent[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [mineOnly, setMineOnly] = useState(false);
  const now = useNow();
  const branchId = branch?.id ?? null;
  const self = me.employee_id;

  const onEvent = useCallback(
    (event: OrderEvent) => {
      if (event.kind !== 'status' || event.status !== 'ready') return;
      const forMe =
        mode === 'pickup'
          ? event.type !== 'dine_in'
          : event.type === 'dine_in' &&
            (event.waiter_id === null || event.waiter_id === self || me.owner);
      if (!forMe) return;
      setAlerts((current) =>
        [event, ...current.filter((a) => a.order_id !== event.order_id)].slice(0, 6),
      );
      play('ready');
    },
    [mode, self, me.owner, play],
  );
  const live = useLiveOrders(locale, mode === 'waiter' ? 'waiter' : 'pickup', branchId, onEvent);

  const handOver = async (order: Order): Promise<void> => {
    setBusy(order.id);
    setFailure(null);
    try {
      await setOrderStatus(locale, order.id, FULFILMENT[order.type]);
      setAlerts((current) => current.filter((a) => a.order_id !== order.id));
      live.reload();
    } catch {
      setFailure(t('restaurant.handover.failed', { number: String(order.number) }));
      live.reload();
    } finally {
      setBusy(null);
    }
  };

  const allowed = (order: Order): boolean =>
    order.type === 'dine_in'
      ? canDo(me, 'serve')
      : order.type === 'takeaway'
        ? canDo(me, 'pickup')
        : canDo(me, 'deliver');

  return (
    <div className="handover">
      <div className="pos__toolbar">
        <BranchPicker t={t} me={me} branch={branch} onChange={chooseBranch} />
        <LiveIndicator t={t} live={live.live} />
        <SoundToggle t={t} on={sound} onChange={setSound} />
        {mode === 'waiter' && self && !me.owner ? (
          <button
            type="button"
            className="restaurant-chip"
            aria-pressed={mineOnly}
            onClick={() => setMineOnly((v) => !v)}
          >
            {t('restaurant.waiter.mine_only')}
          </button>
        ) : null}
      </div>
      {alerts.length > 0 ? (
        <div className="pos__alerts" role="alert">
          {alerts.map((a) => (
            <span key={a.order_id} className="pos__alert">
              {t(
                mode === 'waiter'
                  ? 'restaurant.waiter.ready_alert'
                  : a.type === 'delivery'
                    ? 'restaurant.pos.ready_delivery'
                    : 'restaurant.pos.ready_pickup',
                {
                  number: String(a.number),
                },
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
      {failure ? (
        <p className="pos__failure" role="alert">
          {failure}
        </p>
      ) : null}
      <ListState
        t={t}
        orders={live.orders}
        error={live.error}
        onRetry={live.reload}
        empty={{
          title: t(`restaurant.${mode}.empty_title`),
          help: t(`restaurant.${mode}.empty_help`),
        }}
      >
        {(all) => {
          const orders = mineOnly ? all.filter((o) => o.waiter?.id === self) : all;
          // My orders first, then unassigned, then everyone else's.
          const rank = (o: Order): number =>
            o.waiter?.id === self ? 0 : o.waiter === null ? 1 : 2;
          const ready = orders
            .filter((o) => o.status === 'ready')
            .sort((a, b) => rank(a) - rank(b));
          const cooking = orders.filter((o) => o.status !== 'ready');
          return (
            <div className="handover__sections">
              <section aria-label={t('restaurant.handover.ready')}>
                <h2 className="handover__heading handover__heading--ready">
                  {t(mode === 'waiter' ? 'restaurant.waiter.ready' : 'restaurant.pickup.ready')}{' '}
                  <span className="kds__count">{ready.length}</span>
                </h2>
                {ready.length === 0 ? (
                  <p className="kds__none">{t('restaurant.handover.nothing_ready')}</p>
                ) : null}
                <div className="handover__grid">
                  {ready.map((order) => (
                    <article
                      key={order.id}
                      className={`ticket ticket--ready ticket--${order.type}${order.waiter?.id === self ? ' ticket--mine' : ''}`}
                    >
                      <header className="ticket__head">
                        <strong className="ticket__number">#{order.number}</strong>
                        <TypeTag t={t} order={order} />
                        <span className="ticket__time">
                          {order.ready_at
                            ? t('restaurant.handover.ready_for', {
                                count: String(minutesSince(order.ready_at, now)),
                              })
                            : ''}
                        </span>
                      </header>
                      {order.type === 'dine_in' ? (
                        <p className="handover__who">
                          {order.waiter
                            ? t('restaurant.waiter.assigned_to', { name: order.waiter.name })
                            : t('restaurant.waiter.unassigned')}
                        </p>
                      ) : (
                        <p className="handover__who">
                          {[order.customer_name, order.customer_phone]
                            .filter(Boolean)
                            .join(' · ') || t('restaurant.pickup.walk_in')}
                          {order.delivery_address ? <small>{order.delivery_address}</small> : null}
                        </p>
                      )}
                      <ul className="ticket__lines">
                        {order.items.map((line) => {
                          const detail = lineDetail(line);
                          return (
                            <li key={line.id}>
                              <span className="ticket__qty">{line.quantity}×</span>
                              <span>
                                <strong>{line.name}</strong>
                                {detail ? <small>{detail}</small> : null}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                      {allowed(order) ? (
                        <footer className="ticket__actions">
                          <Button
                            size="lg"
                            loading={busy === order.id}
                            onClick={() => void handOver(order)}
                          >
                            {t(`restaurant.handover.action.${order.type}`)}
                          </Button>
                        </footer>
                      ) : null}
                    </article>
                  ))}
                </div>
              </section>
              <section aria-label={t('restaurant.handover.in_kitchen')}>
                <h2 className="handover__heading">
                  {t('restaurant.handover.in_kitchen')}{' '}
                  <span className="kds__count">{cooking.length}</span>
                </h2>
                {cooking.length === 0 ? (
                  <p className="kds__none">{t('restaurant.handover.nothing_cooking')}</p>
                ) : null}
                <ul className="handover__list">
                  {cooking.map((order) => (
                    <li key={order.id}>
                      <strong>#{order.number}</strong>
                      <TypeTag t={t} order={order} />
                      <span className="handover__items">
                        {order.items.map((l) => `${String(l.quantity)}× ${l.name}`).join(', ')}
                      </span>
                      <StatusBadge t={t} status={order.status} type={order.type} />
                      <small>{clock(order.created_at, locale)}</small>
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          );
        }}
      </ListState>
    </div>
  );
}

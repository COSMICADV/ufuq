'use client';

import { createTranslator } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';
import { useCallback, useState } from 'react';

import { listOrders, setOrderStatus } from '../../lib/restaurant';
import type { Order, OrderEvent, OrderStatus, RestaurantMe } from '../../lib/restaurant';
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
  TypeTag,
  useLiveOrders,
  useNow,
  useSound,
  useWorkBranch,
} from './restaurant-parts';
import type { Surface } from './restaurant-parts';

/** `/…/kitchen` — the Kitchen Display System: tickets in New, Preparing and Done columns. */
export function KitchenDisplay({
  locale,
}: {
  readonly locale: Locale;
  readonly surface: Surface;
}): React.JSX.Element {
  const t = createTranslator(locale);
  return (
    <RestaurantGate locale={locale} title={t('restaurant.kitchen.title')} need="kitchen.view" wide>
      {(me) => <KitchenScreen locale={locale} t={t} me={me} />}
    </RestaurantGate>
  );
}

const COLUMNS: readonly OrderStatus[] = ['new', 'preparing', 'ready'];

function KitchenScreen({
  locale,
  t,
  me,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly me: RestaurantMe;
}): React.JSX.Element {
  const [branch, chooseBranch] = useWorkBranch(me);
  const [sound, setSound, play] = useSound();
  const [flash, setFlash] = useState<readonly number[]>([]);
  const [view, setView] = useState<'active' | 'done'>('active');
  const [done, setDone] = useState<readonly Order[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const now = useNow();
  const branchId = branch?.id ?? null;

  const onEvent = useCallback(
    (event: OrderEvent) => {
      if (event.kind === 'created') {
        play('new');
        setFlash((current) => [...current, event.number]);
        window.setTimeout(
          () => setFlash((current) => current.filter((n) => n !== event.number)),
          8000,
        );
      }
    },
    [play],
  );
  const live = useLiveOrders(locale, 'kitchen', branchId, onEvent);

  const loadDone = useCallback(() => {
    if (!branchId) return;
    setDone(null);
    listOrders(locale, 'history', branchId).then(setDone, () => setDone([]));
  }, [locale, branchId]);

  const move = async (order: Order, to: Exclude<OrderStatus, 'cancelled'>): Promise<void> => {
    setBusy(order.id);
    setFailure(null);
    try {
      const updated = await setOrderStatus(locale, order.id, to);
      live.replace(updated);
      live.reload();
    } catch {
      setFailure(t('restaurant.kitchen.update_failed', { number: String(order.number) }));
      live.reload();
    } finally {
      setBusy(null);
    }
  };

  const canUpdate = canDo(me, 'kitchen.update');

  return (
    <div className="kds">
      <div className="pos__toolbar">
        <BranchPicker t={t} me={me} branch={branch} onChange={chooseBranch} />
        <LiveIndicator t={t} live={live.live} />
        <SoundToggle t={t} on={sound} onChange={setSound} />
        <div className="kds__views" role="tablist">
          <button
            type="button"
            role="tab"
            className="restaurant-chip"
            aria-selected={view === 'active'}
            onClick={() => setView('active')}
          >
            {t('restaurant.kitchen.active')}
          </button>
          <button
            type="button"
            role="tab"
            className="restaurant-chip"
            aria-selected={view === 'done'}
            onClick={() => {
              setView('done');
              loadDone();
            }}
          >
            {t('restaurant.kitchen.completed')}
          </button>
        </div>
      </div>
      {flash.length > 0 ? (
        <p className="kds__flash" role="alert">
          {t('restaurant.kitchen.new_order', {
            numbers: flash.map((n) => `#${String(n)}`).join(' '),
          })}
        </p>
      ) : null}
      {failure ? (
        <p className="pos__failure" role="alert">
          {failure}
        </p>
      ) : null}

      {view === 'active' ? (
        <ListState
          t={t}
          orders={live.orders}
          error={live.error}
          onRetry={live.reload}
          empty={{
            title: t('restaurant.kitchen.empty_title'),
            help: t('restaurant.kitchen.empty_help'),
          }}
        >
          {(orders) => (
            <div className="kds__columns">
              {COLUMNS.map((status) => {
                const column = orders.filter((o) => o.status === status);
                return (
                  <section
                    key={status}
                    className={`kds__column kds__column--${status}`}
                    aria-label={t(`restaurant.kitchen.column.${status}`)}
                  >
                    <h2>
                      {t(`restaurant.kitchen.column.${status}`)}{' '}
                      <span className="kds__count">{column.length}</span>
                    </h2>
                    {column.length === 0 ? (
                      <p className="kds__none">{t('restaurant.kitchen.column_empty')}</p>
                    ) : null}
                    {column.map((order) => (
                      <Ticket
                        key={order.id}
                        t={t}
                        locale={locale}
                        order={order}
                        now={now}
                        fresh={flash.includes(order.number)}
                        busy={busy === order.id}
                        canUpdate={canUpdate}
                        onMove={(to) => void move(order, to)}
                      />
                    ))}
                  </section>
                );
              })}
            </div>
          )}
        </ListState>
      ) : (
        <ListState
          t={t}
          orders={done}
          error={null}
          onRetry={loadDone}
          empty={{
            title: t('restaurant.kitchen.done_empty_title'),
            help: t('restaurant.kitchen.done_empty_help'),
          }}
        >
          {(orders) => (
            <ul className="kds__done">
              {orders.map((order) => (
                <li key={order.id}>
                  <strong>#{order.number}</strong>
                  <TypeTag t={t} order={order} />
                  <span>
                    {order.items.map((l) => `${String(l.quantity)}× ${l.name}`).join(', ')}
                  </span>
                  <small>
                    {order.ready_at
                      ? t('restaurant.kitchen.done_at', { time: clock(order.ready_at, locale) })
                      : ''}
                  </small>
                </li>
              ))}
            </ul>
          )}
        </ListState>
      )}
    </div>
  );
}

function Ticket({
  t,
  locale,
  order,
  now,
  fresh,
  busy,
  canUpdate,
  onMove,
}: {
  readonly t: Translator;
  readonly locale: Locale;
  readonly order: Order;
  readonly now: number;
  readonly fresh: boolean;
  readonly busy: boolean;
  readonly canUpdate: boolean;
  readonly onMove: (to: Exclude<OrderStatus, 'cancelled'>) => void;
}): React.JSX.Element {
  const minutes = minutesSince(order.created_at, now);
  const late = order.status !== 'ready' && minutes >= 15;
  return (
    <article
      className={`ticket ticket--${order.type}${fresh ? ' ticket--fresh' : ''}${late ? ' ticket--late' : ''}`}
    >
      <header className="ticket__head">
        <strong className="ticket__number">#{order.number}</strong>
        <TypeTag t={t} order={order} />
        <span className="ticket__time" title={clock(order.created_at, locale)}>
          {t('restaurant.kitchen.minutes', { count: String(minutes) })}
        </span>
      </header>
      <ul className="ticket__lines">
        {order.items.map((line) => {
          const detail = lineDetail(line);
          return (
            <li key={line.id}>
              <span className="ticket__qty">{line.quantity}×</span>
              <span>
                <strong>{line.name}</strong>
                {detail ? <small>{detail}</small> : null}
                {line.notes ? <em>⚠ {line.notes}</em> : null}
              </span>
            </li>
          );
        })}
      </ul>
      {order.notes ? <p className="ticket__notes">⚠ {order.notes}</p> : null}
      {canUpdate ? (
        <footer className="ticket__actions">
          {order.status === 'new' ? (
            <Button size="lg" loading={busy} onClick={() => onMove('preparing')}>
              {t('restaurant.kitchen.start')}
            </Button>
          ) : null}
          {order.status === 'preparing' ? (
            <>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => onMove('new')}>
                {t('restaurant.kitchen.back')}
              </Button>
              <Button size="lg" loading={busy} onClick={() => onMove('ready')}>
                {t('restaurant.kitchen.done')}
              </Button>
            </>
          ) : null}
          {order.status === 'ready' ? (
            <>
              <span className="ticket__waiting">
                {t(`restaurant.kitchen.waiting.${order.type}`)}
              </span>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => onMove('preparing')}>
                {t('restaurant.kitchen.recall')}
              </Button>
            </>
          ) : null}
        </footer>
      ) : null}
    </article>
  );
}

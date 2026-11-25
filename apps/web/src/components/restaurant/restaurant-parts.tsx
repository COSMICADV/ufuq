'use client';

import { createTranslator, formatMoney, formatTime } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { listOrders, loadRestaurantMe, streamUrl } from '../../lib/restaurant';
import type {
  Order,
  OrderEvent,
  OrderStatus,
  OrderType,
  OrderView,
  RestaurantAction,
  RestaurantMe,
  WorkBranch,
} from '../../lib/restaurant';
import { Badge, EmptyState, Select } from '../design-system';
import { ErrorState, LoadingState } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';

export type Surface = 'admin' | 'app';

export function restaurantBase(locale: Locale, surface: Surface): string {
  return `/${locale}/${surface}`;
}

export function money(amount: string, me: RestaurantMe, locale: Locale): string {
  return formatMoney(amount, me.currency, { locale, showDecimals: true });
}

export function clock(iso: string, locale: Locale): string {
  return formatTime(new Date(iso), {
    locale,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
}

export function canDo(me: RestaurantMe, action: RestaurantAction): boolean {
  return me.actions.includes(action);
}

// ---------------------------------------------------------------------------
// Page frame
// ---------------------------------------------------------------------------

export function RestaurantPage({
  t,
  crumbs,
  title,
  description,
  action,
  wide,
  children,
}: {
  readonly t: Translator;
  readonly crumbs: readonly { readonly label: string; readonly href?: string }[];
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
  readonly wide?: boolean;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <div className={`employees restaurant${wide ? ' restaurant--wide' : ''}`}>
      <main className="employees__content">
        <nav className="page-breadcrumb" aria-label={t('restaurant.breadcrumb')}>
          <ol>
            {crumbs.map((crumb, index) =>
              crumb.href === undefined ? (
                <li key={index} aria-current="page">
                  {crumb.label}
                </li>
              ) : (
                <li key={index}>
                  <Link href={crumb.href}>{crumb.label}</Link>
                </li>
              ),
            )}
          </ol>
        </nav>
        <header className="page-heading">
          <div>
            <h1>{title}</h1>
            {description === undefined ? null : <p>{description}</p>}
          </div>
          {action ?? null}
        </header>
        {children}
      </main>
    </div>
  );
}

export function RestaurantUnavailable({
  t,
  reason,
}: {
  readonly t: Translator;
  readonly reason: 'disabled' | 'forbidden' | 'no_branch';
}): React.JSX.Element {
  return (
    <EmptyState
      title={t(`restaurant.unavailable.${reason}_title`)}
      description={t(`restaurant.unavailable.${reason}_help`)}
      action={null}
    />
  );
}

/**
 * Loads GET /restaurant/me and renders the page frame with the right
 * loading, error and "not for you" states; `children` runs only when the
 * caller holds `need` (or is the owner when `need` is 'owner').
 */
export function RestaurantGate({
  locale,
  title,
  crumbs,
  description,
  need,
  wide,
  action,
  children,
}: {
  readonly locale: Locale;
  readonly title: string;
  readonly crumbs?: readonly { readonly label: string; readonly href?: string }[];
  readonly description?: string;
  readonly need: RestaurantAction | 'owner' | readonly RestaurantAction[];
  readonly wide?: boolean;
  readonly action?: (me: RestaurantMe) => ReactNode;
  readonly children: (me: RestaurantMe) => ReactNode;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const load = useCallback((signal: AbortSignal) => loadRestaurantMe(locale, signal), [locale]);
  const me = useResource(load);
  const frame = (body: ReactNode, value?: RestaurantMe): React.JSX.Element => (
    <RestaurantPage
      t={t}
      crumbs={crumbs ?? [{ label: title }]}
      title={title}
      {...(description !== undefined ? { description } : {})}
      {...(wide ? { wide } : {})}
      action={value && action ? action(value) : undefined}
    >
      {body}
    </RestaurantPage>
  );
  if (me.state.status === 'loading') return frame(<LoadingState t={t} rows={6} />);
  if (me.state.status === 'error')
    return frame(<ErrorState t={t} error={me.state.error} onRetry={me.reload} />);
  const value = me.state.value;
  if (!value.enabled) return frame(<RestaurantUnavailable t={t} reason="disabled" />);
  const allowed =
    need === 'owner'
      ? value.owner
      : typeof need === 'string'
        ? canDo(value, need)
        : need.some((action) => canDo(value, action));
  if (!allowed) return frame(<RestaurantUnavailable t={t} reason="forbidden" />);
  if (need !== 'owner' && value.branches.length === 0) {
    return frame(<RestaurantUnavailable t={t} reason="no_branch" />);
  }
  return frame(children(value), value);
}

// ---------------------------------------------------------------------------
// Branch choice — staff work in their own branch; the owner picks one
// ---------------------------------------------------------------------------

const BRANCH_KEY = 'ufuq.restaurant.branch';

export function useWorkBranch(
  me: RestaurantMe,
): readonly [WorkBranch | null, (id: string) => void] {
  const [chosen, setChosen] = useState<string | null>(null);
  useEffect(() => {
    if (!me.owner) return;
    try {
      setChosen(window.localStorage.getItem(BRANCH_KEY));
    } catch {
      // Storage unavailable: the first branch is used.
    }
  }, [me.owner]);
  const choose = useCallback((id: string) => {
    setChosen(id);
    try {
      window.localStorage.setItem(BRANCH_KEY, id);
    } catch {
      // Storage unavailable: the choice lasts for this page only.
    }
  }, []);
  if (!me.owner) return [me.branch, choose];
  const branch = me.branches.find((b) => b.id === chosen) ?? me.branches[0] ?? null;
  return [branch, choose];
}

export function BranchPicker({
  t,
  me,
  branch,
  onChange,
}: {
  readonly t: Translator;
  readonly me: RestaurantMe;
  readonly branch: WorkBranch | null;
  readonly onChange: (id: string) => void;
}): React.JSX.Element | null {
  if (!me.owner) {
    return branch ? <span className="restaurant-branch-tag">{branch.name}</span> : null;
  }
  if (me.branches.length <= 1)
    return branch ? <span className="restaurant-branch-tag">{branch.name}</span> : null;
  return (
    <label className="restaurant-branch-picker">
      <span>{t('restaurant.branch')}</span>
      <Select value={branch?.id ?? ''} onChange={(e) => onChange(e.target.value)}>
        {me.branches.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </Select>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Live orders — the branch's orders, kept current by the live stream
// ---------------------------------------------------------------------------

export type LiveState = 'live' | 'connecting' | 'offline';

/** Refresh anyway every 15 s: a lost event only ever delays a screen. */
const POLL_MS = 15_000;

export function useLiveOrders(
  locale: Locale,
  view: OrderView,
  branchId: string | null,
  onEvent?: (event: OrderEvent) => void,
): {
  readonly orders: readonly Order[] | null;
  readonly error: unknown;
  readonly live: LiveState;
  readonly reload: () => void;
  readonly replace: (order: Order) => void;
} {
  const [orders, setOrders] = useState<readonly Order[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [live, setLive] = useState<LiveState>('connecting');
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const sequence = useRef(0);

  const reload = useCallback(() => {
    if (!branchId) return;
    const mine = ++sequence.current;
    listOrders(locale, view, branchId).then(
      (value) => {
        if (mine !== sequence.current) return;
        setOrders(value);
        setError(null);
      },
      (failure: unknown) => {
        if (mine !== sequence.current) return;
        setError(failure);
      },
    );
  }, [locale, view, branchId]);

  useEffect(() => {
    setOrders(null);
    reload();
    const timer = window.setInterval(reload, POLL_MS);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') reload();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [reload]);

  useEffect(() => {
    if (!branchId || typeof EventSource === 'undefined') {
      setLive('offline');
      return;
    }
    setLive('connecting');
    const source = new EventSource(streamUrl(branchId), { withCredentials: true });
    source.addEventListener('ready', () => setLive('live'));
    source.addEventListener('order', (message) => {
      try {
        const event = JSON.parse((message as MessageEvent<string>).data) as OrderEvent;
        handler.current?.(event);
      } catch {
        // A malformed event is ignored; the list still refreshes.
      }
      reload();
    });
    source.onerror = () => {
      // The browser reconnects by itself; the poll keeps the screen current meanwhile.
      setLive(source.readyState === EventSource.CLOSED ? 'offline' : 'connecting');
    };
    return () => {
      source.close();
    };
  }, [branchId, reload]);

  const replace = useCallback((order: Order) => {
    setOrders((current) =>
      current ? current.map((o) => (o.id === order.id ? order : o)) : current,
    );
  }, []);

  return { orders, error, live, reload, replace };
}

export function LiveIndicator({
  t,
  live,
}: {
  readonly t: Translator;
  readonly live: LiveState;
}): React.JSX.Element {
  return (
    <span className={`restaurant-live restaurant-live--${live}`} role="status">
      <span aria-hidden="true" />
      {t(`restaurant.live.${live}`)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Sound — a short chime from the browser, no file to load
// ---------------------------------------------------------------------------

const SOUND_KEY = 'ufuq.restaurant.sound';

export function useSound(): readonly [
  boolean,
  (on: boolean) => void,
  (kind?: 'new' | 'ready') => void,
] {
  const [on, setOn] = useState(true);
  const context = useRef<AudioContext | null>(null);
  useEffect(() => {
    try {
      setOn(window.localStorage.getItem(SOUND_KEY) !== 'off');
    } catch {
      // Default: on.
    }
  }, []);
  const toggle = useCallback((value: boolean) => {
    setOn(value);
    try {
      window.localStorage.setItem(SOUND_KEY, value ? 'on' : 'off');
    } catch {
      // The choice lasts for this page only.
    }
    // A user gesture unlocks audio for the rest of the visit.
    if (value && !context.current && typeof AudioContext !== 'undefined')
      context.current = new AudioContext();
  }, []);
  const play = useCallback(
    (kind: 'new' | 'ready' = 'new') => {
      if (!on || typeof AudioContext === 'undefined') return;
      try {
        const audio = context.current ?? new AudioContext();
        context.current = audio;
        const notes = kind === 'new' ? [880, 1175, 880] : [660, 990];
        notes.forEach((frequency, index) => {
          const oscillator = audio.createOscillator();
          const gain = audio.createGain();
          oscillator.type = 'sine';
          oscillator.frequency.value = frequency;
          const start = audio.currentTime + index * 0.18;
          gain.gain.setValueAtTime(0.0001, start);
          gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
          oscillator.connect(gain).connect(audio.destination);
          oscillator.start(start);
          oscillator.stop(start + 0.17);
        });
      } catch {
        // No audio available: the on-screen alert remains.
      }
    },
    [on],
  );
  return [on, toggle, play];
}

export function SoundToggle({
  t,
  on,
  onChange,
}: {
  readonly t: Translator;
  readonly on: boolean;
  readonly onChange: (on: boolean) => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="restaurant-chip"
      aria-pressed={on}
      onClick={() => onChange(!on)}
    >
      {on ? '🔔 ' : '🔕 '}
      {t(on ? 'restaurant.sound_on' : 'restaurant.sound_off')}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Small parts
// ---------------------------------------------------------------------------

const STATUS_TONE: Readonly<
  Record<OrderStatus, 'info' | 'warning' | 'success' | 'cancelled' | 'wfh' | 'danger'>
> = {
  new: 'info',
  preparing: 'warning',
  ready: 'success',
  served: 'wfh',
  picked_up: 'wfh',
  delivered: 'wfh',
  cancelled: 'cancelled',
};

export function StatusBadge({
  t,
  status,
  type,
}: {
  readonly t: Translator;
  readonly status: OrderStatus;
  readonly type?: OrderType;
}): React.JSX.Element {
  const key =
    status === 'ready' && type ? `restaurant.status.ready_${type}` : `restaurant.status.${status}`;
  return <Badge tone={STATUS_TONE[status]}>{t(key)}</Badge>;
}

export function TypeTag({
  t,
  order,
}: {
  readonly t: Translator;
  readonly order: Pick<Order, 'type' | 'table'>;
}): React.JSX.Element {
  return (
    <span className={`restaurant-type restaurant-type--${order.type}`}>
      {t(`restaurant.type.${order.type}`)}
      {order.type === 'dine_in' && order.table
        ? ` · ${t('restaurant.table_short', { label: order.table.label })}`
        : ''}
    </span>
  );
}

/** "now" that ticks every 15 s — for "5 min ago" on kitchen tickets. */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function minutesSince(iso: string, now: number): number {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
}

/** A line's size, extras and customizations in one short line. */
export function lineDetail(line: Order['items'][number]): string {
  return [
    line.size_name,
    ...line.options.map((o) => (o.kind === 'customization' ? o.name : `+ ${o.name}`)),
  ]
    .filter(Boolean)
    .join(' · ');
}

export function ListState({
  t,
  orders,
  error,
  onRetry,
  empty,
  children,
}: {
  readonly t: Translator;
  readonly orders: readonly Order[] | null;
  readonly error: unknown;
  readonly onRetry: () => void;
  readonly empty: { readonly title: string; readonly help: string };
  readonly children: (orders: readonly Order[]) => ReactNode;
}): React.JSX.Element {
  if (orders === null && error) {
    return (
      <div className="restaurant-error" role="alert">
        <p>{t('restaurant.load_failed')}</p>
        <button type="button" className="button button--secondary button--sm" onClick={onRetry}>
          <span>{t('restaurant.retry')}</span>
        </button>
      </div>
    );
  }
  if (orders === null) return <LoadingState t={t} rows={4} />;
  if (orders.length === 0)
    return <EmptyState title={empty.title} description={empty.help} action={null} />;
  return <>{children(orders)}</>;
}

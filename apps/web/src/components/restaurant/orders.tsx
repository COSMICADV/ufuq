'use client';

import { createTranslator } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';
import { useCallback, useEffect, useState } from 'react';

import { ApiError } from '../../lib/api-client';
import {
  cancelOrder,
  listOrders,
  loadOrder,
  loadWaiters,
  setOrderWaiter,
} from '../../lib/restaurant';
import type { Order, PersonRef, RestaurantMe } from '../../lib/restaurant';
import { Button, Card, DataTable, Field, Modal, Select, Textarea } from '../design-system';
import { Cell, LoadingState } from '../settings/screen-states';

import {
  BranchPicker,
  canDo,
  clock,
  lineDetail,
  ListState,
  LiveIndicator,
  money,
  RestaurantGate,
  StatusBadge,
  TypeTag,
  useLiveOrders,
  useWorkBranch,
} from './restaurant-parts';
import type { Surface } from './restaurant-parts';

/** `/…/orders` — the branch's open orders and today's finished ones, with each order's history. */
export function RestaurantOrders({
  locale,
}: {
  readonly locale: Locale;
  readonly surface: Surface;
}): React.JSX.Element {
  const t = createTranslator(locale);
  return (
    <RestaurantGate locale={locale} title={t('restaurant.orders.title')} need="orders.view" wide>
      {(me) => <OrdersScreen locale={locale} t={t} me={me} />}
    </RestaurantGate>
  );
}

function OrdersScreen({
  locale,
  t,
  me,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly me: RestaurantMe;
}): React.JSX.Element {
  const [branch, chooseBranch] = useWorkBranch(me);
  const [tab, setTab] = useState<'active' | 'history'>('active');
  const [history, setHistory] = useState<readonly Order[] | null>(null);
  const [historyError, setHistoryError] = useState<unknown>(null);
  const [open, setOpen] = useState<string | null>(null);
  const branchId = branch?.id ?? null;
  const live = useLiveOrders(locale, 'active', branchId);

  const loadHistory = useCallback(() => {
    if (!branchId) return;
    setHistory(null);
    setHistoryError(null);
    listOrders(locale, 'history', branchId).then(setHistory, setHistoryError);
  }, [locale, branchId]);
  useEffect(() => {
    if (tab === 'history') loadHistory();
  }, [tab, loadHistory]);

  const orders = tab === 'active' ? live.orders : history;
  const error = tab === 'active' ? live.error : historyError;

  return (
    <div>
      <div className="pos__toolbar">
        <BranchPicker t={t} me={me} branch={branch} onChange={chooseBranch} />
        <LiveIndicator t={t} live={live.live} />
        <div className="kds__views" role="tablist">
          <button
            type="button"
            role="tab"
            className="restaurant-chip"
            aria-selected={tab === 'active'}
            onClick={() => setTab('active')}
          >
            {t('restaurant.orders.open')}
          </button>
          <button
            type="button"
            role="tab"
            className="restaurant-chip"
            aria-selected={tab === 'history'}
            onClick={() => setTab('history')}
          >
            {t('restaurant.orders.today')}
          </button>
        </div>
      </div>
      <ListState
        t={t}
        orders={orders}
        error={error}
        onRetry={tab === 'active' ? live.reload : loadHistory}
        empty={{
          title: t(
            tab === 'active'
              ? 'restaurant.orders.empty_open_title'
              : 'restaurant.orders.empty_today_title',
          ),
          help: t(
            tab === 'active'
              ? 'restaurant.orders.empty_open_help'
              : 'restaurant.orders.empty_today_help',
          ),
        }}
      >
        {(list) => (
          <Card className="employees-table restaurant-table">
            <DataTable
              headers={[
                t('restaurant.orders.number'),
                t('restaurant.orders.type'),
                t('restaurant.orders.items'),
                t('restaurant.orders.total'),
                t('restaurant.orders.status'),
                t('restaurant.orders.time'),
                '',
              ]}
              rows={list.map((order) => [
                <Cell key="n" label={t('restaurant.orders.number')}>
                  <strong>#{order.number}</strong>
                </Cell>,
                <Cell key="type" label={t('restaurant.orders.type')}>
                  <TypeTag t={t} order={order} />
                </Cell>,
                <Cell key="items" label={t('restaurant.orders.items')}>
                  {order.items.map((l) => `${String(l.quantity)}× ${l.name}`).join(', ')}
                </Cell>,
                <Cell key="total" label={t('restaurant.orders.total')}>
                  {order.totals ? money(order.totals.total, me, locale) : '—'}
                </Cell>,
                <Cell key="status" label={t('restaurant.orders.status')}>
                  <StatusBadge t={t} status={order.status} type={order.type} />
                </Cell>,
                <Cell key="time" label={t('restaurant.orders.time')}>
                  {clock(order.created_at, locale)}
                </Cell>,
                <Cell key="open" label="">
                  <Button variant="secondary" size="sm" onClick={() => setOpen(order.id)}>
                    {t('restaurant.orders.details')}
                  </Button>
                </Cell>,
              ])}
            />
          </Card>
        )}
      </ListState>
      {open ? (
        <OrderDetail
          locale={locale}
          t={t}
          me={me}
          id={open}
          onClose={() => setOpen(null)}
          onChanged={() => {
            live.reload();
            if (tab === 'history') loadHistory();
          }}
        />
      ) : null}
    </div>
  );
}

export function OrderDetail({
  locale,
  t,
  me,
  id,
  onClose,
  onChanged,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly me: RestaurantMe;
  readonly id: string;
  readonly onClose: () => void;
  readonly onChanged: () => void;
}): React.JSX.Element {
  const [order, setOrder] = useState<Order | null>(null);
  const [failed, setFailed] = useState(false);
  const [waiters, setWaiters] = useState<readonly PersonRef[]>([]);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    loadOrder(locale, id).then(
      (value) => {
        setOrder(value);
        if (value.type === 'dine_in' && canDo(me, 'waiter.assign'))
          loadWaiters(locale, value.branch.id).then(setWaiters, () => undefined);
      },
      () => setFailed(true),
    );
  }, [locale, id, me]);

  const cancel = async (): Promise<void> => {
    if (reason.trim().length < 2) {
      setProblem(t('restaurant.orders.reason_required'));
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      setOrder(await cancelOrder(locale, id, reason.trim()));
      setCancelling(false);
      onChanged();
    } catch (error) {
      setProblem(
        error instanceof ApiError && error.status === 409
          ? t('restaurant.orders.cannot_cancel')
          : t('restaurant.orders.action_failed'),
      );
    } finally {
      setBusy(false);
    }
  };

  const reassign = async (waiterId: string): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      setOrder(await setOrderWaiter(locale, id, waiterId === '' ? null : waiterId));
      onChanged();
    } catch {
      setProblem(t('restaurant.orders.action_failed'));
    } finally {
      setBusy(false);
    }
  };

  const open = order !== null && ['new', 'preparing', 'ready'].includes(order.status);

  return (
    <Modal
      open
      title={
        order
          ? t('restaurant.orders.order_number', { number: String(order.number) })
          : t('restaurant.orders.details')
      }
      onClose={onClose}
      closeLabel={t('restaurant.close')}
      footer={
        order &&
        canDo(me, 'orders.cancel') &&
        (order.status === 'new' || order.status === 'preparing') ? (
          cancelling ? (
            <div className="order-detail__cancel">
              <Field
                label={t('restaurant.orders.cancel_reason')}
                required
                {...(problem ? { error: problem } : {})}
              >
                <Textarea
                  rows={2}
                  maxLength={300}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </Field>
              <div className="pos__actions">
                <Button variant="ghost" onClick={() => setCancelling(false)}>
                  {t('restaurant.orders.keep')}
                </Button>
                <Button variant="destructive" loading={busy} onClick={() => void cancel()}>
                  {t('restaurant.orders.confirm_cancel')}
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="destructive-ghost" onClick={() => setCancelling(true)}>
              {t('restaurant.orders.cancel')}
            </Button>
          )
        ) : undefined
      }
    >
      {failed ? (
        <p className="restaurant-error">{t('restaurant.load_failed')}</p>
      ) : !order ? (
        <LoadingState t={t} rows={4} />
      ) : (
        <div className="order-detail">
          <div className="order-detail__meta">
            <TypeTag t={t} order={order} />
            <StatusBadge t={t} status={order.status} type={order.type} />
            <span>
              {t('restaurant.orders.by', {
                name: order.created_by,
                time: clock(order.created_at, locale),
              })}
            </span>
          </div>
          {order.customer_name || order.customer_phone || order.delivery_address ? (
            <p className="order-detail__customer">
              {[order.customer_name, order.customer_phone].filter(Boolean).join(' · ')}
              {order.delivery_address ? <small>{order.delivery_address}</small> : null}
            </p>
          ) : null}
          {order.type === 'dine_in' ? (
            canDo(me, 'waiter.assign') && open ? (
              <Field label={t('restaurant.pos.waiter')}>
                <Select
                  value={order.waiter?.id ?? ''}
                  disabled={busy}
                  onChange={(e) => void reassign(e.target.value)}
                >
                  <option value="">{t('restaurant.pos.any_waiter')}</option>
                  {waiters.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : (
              <p>
                {order.waiter
                  ? t('restaurant.waiter.assigned_to', { name: order.waiter.name })
                  : t('restaurant.waiter.unassigned')}
              </p>
            )
          ) : null}
          <ul className="order-detail__lines">
            {order.items.map((line) => {
              const detail = lineDetail(line);
              return (
                <li key={line.id}>
                  <span className="ticket__qty">{line.quantity}×</span>
                  <span>
                    <strong>{line.name}</strong>
                    {detail ? <small>{detail}</small> : null}
                    {line.notes ? <em>“{line.notes}”</em> : null}
                  </span>
                  {line.line_total ? <span>{money(line.line_total, me, locale)}</span> : null}
                </li>
              );
            })}
          </ul>
          {order.notes ? <p className="ticket__notes">{order.notes}</p> : null}
          {order.totals ? (
            <dl className="pos__totals">
              <div>
                <dt>{t('restaurant.totals.subtotal')}</dt>
                <dd>{money(order.totals.subtotal, me, locale)}</dd>
              </div>
              {order.totals.discount !== '0.00' ? (
                <div>
                  <dt>{t('restaurant.totals.discount')}</dt>
                  <dd>−{money(order.totals.discount, me, locale)}</dd>
                </div>
              ) : null}
              {order.totals.service !== '0.00' ? (
                <div>
                  <dt>{t('restaurant.totals.service', { rate: order.totals.service_rate })}</dt>
                  <dd>{money(order.totals.service, me, locale)}</dd>
                </div>
              ) : null}
              {order.totals.tax !== '0.00' ? (
                <div>
                  <dt>{t('restaurant.totals.tax', { rate: order.totals.tax_rate })}</dt>
                  <dd>{money(order.totals.tax, me, locale)}</dd>
                </div>
              ) : null}
              <div className="pos__grand">
                <dt>{t('restaurant.totals.total')}</dt>
                <dd>{money(order.totals.total, me, locale)}</dd>
              </div>
            </dl>
          ) : null}
          {order.cancel_reason ? (
            <p className="pos__failure">
              {t('restaurant.orders.cancelled_because', { reason: order.cancel_reason })}
            </p>
          ) : null}
          {order.history && order.history.length > 0 ? (
            <section>
              <h3 className="order-detail__subhead">{t('restaurant.orders.history')}</h3>
              <ol className="order-detail__history">
                {order.history.map((h, index) => (
                  <li key={index}>
                    <span>{clock(h.at, locale)}</span>
                    <StatusBadge t={t} status={h.to} type={order.type} />
                    <span>{h.by}</span>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
          {problem && !cancelling ? <p className="pos__failure">{problem}</p> : null}
        </div>
      )}
    </Modal>
  );
}

'use client';

import { createTranslator } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { ApiError, fetchMany, fetchOne, issueKeys } from '../../lib/api-client';
import {
  isMoney,
  loadBranches,
  loadMenu,
  loadStaff,
  loadTables,
  loadWaiters,
  RESTAURANT_ROLES,
  removeStaff,
  saveBranch,
  saveStaff,
  saveTable,
} from '../../lib/restaurant';
import type {
  Branch,
  PersonRef,
  RestaurantMe,
  RestaurantRole,
  StaffMember,
  Table,
} from '../../lib/restaurant';
import {
  Badge,
  Button,
  Card,
  DataTable,
  Field,
  Input,
  Modal,
  Select,
  Toggle,
} from '../design-system';
import { Cell, ErrorState, LoadingState, Ltr } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';

import {
  BranchPicker,
  canDo,
  LiveIndicator,
  RestaurantGate,
  restaurantBase,
  useLiveOrders,
  useWorkBranch,
} from './restaurant-parts';
import type { Surface } from './restaurant-parts';

function translated(t: Translator, error: unknown): Readonly<Record<string, string>> {
  if (!(error instanceof ApiError)) return {};
  return Object.fromEntries(Object.entries(issueKeys(error)).map(([k, v]) => [k, t(v)]));
}

function hours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? String(h) : `${String(h)}:${String(m).padStart(2, '0')}`;
}

// ===========================================================================
// Home
// ===========================================================================

/** `/…/restaurant` — the restaurant's front page: setup for the owner, the right screen for each role. */
export function RestaurantHome({
  locale,
  surface,
}: {
  readonly locale: Locale;
  readonly surface: Surface;
}): React.JSX.Element {
  const t = createTranslator(locale);
  return (
    <RestaurantGate
      locale={locale}
      title={t('restaurant.home.title')}
      need={['menu.view', 'kitchen.view', 'waiter.view', 'pickup', 'orders.view']}
    >
      {(me) => <Home locale={locale} surface={surface} t={t} me={me} />}
    </RestaurantGate>
  );
}

function Home({
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
  const base = restaurantBase(locale, surface);
  const [counts, setCounts] = useState<{
    branches: number;
    items: number;
    staff: number;
    tables: number;
  } | null>(null);
  const [branch, chooseBranch] = useWorkBranch(me);
  const live = useLiveOrders(
    locale,
    canDo(me, 'orders.view')
      ? 'active'
      : canDo(me, 'kitchen.view')
        ? 'kitchen'
        : canDo(me, 'waiter.view')
          ? 'waiter'
          : 'pickup',
    branch?.id ?? null,
  );

  useEffect(() => {
    if (!me.owner) return;
    Promise.all([loadBranches(locale), loadMenu(locale), loadStaff(locale)]).then(
      async ([branches, menu, staff]) => {
        const open = branches.filter((b) => !b.archived);
        const tableLists = await Promise.all(open.map((b) => loadTables(locale, b.id)));
        setCounts({
          branches: open.length,
          items: menu.items.length,
          staff: staff.filter((s) => s.restaurant !== null).length,
          tables: tableLists.reduce((sum, list) => sum + list.length, 0),
        });
      },
      () => setCounts(null),
    );
  }, [locale, me.owner]);

  const orders = live.orders ?? [];
  const screens: { href: string; key: string; show: boolean }[] = [
    { href: `${base}/pos`, key: 'pos', show: canDo(me, 'orders.create') },
    { href: `${base}/kitchen`, key: 'kitchen', show: canDo(me, 'kitchen.view') },
    { href: `${base}/waiter`, key: 'waiter', show: canDo(me, 'waiter.view') },
    { href: `${base}/pickup`, key: 'pickup', show: canDo(me, 'pickup') || canDo(me, 'deliver') },
    { href: `${base}/orders`, key: 'orders', show: canDo(me, 'orders.view') },
  ];

  return (
    <div className="restaurant-home">
      {me.owner ? (
        <section className="restaurant-setup" aria-label={t('restaurant.home.setup')}>
          <h2>{t('restaurant.home.setup')}</h2>
          <p>{t('restaurant.home.setup_help')}</p>
          <ol className="restaurant-steps">
            {(
              [
                ['branches', counts?.branches ?? 0, `${base}/restaurant/branches`],
                ['menu', counts?.items ?? 0, `${base}/restaurant/menu`],
                ['team', counts?.staff ?? 0, `${base}/restaurant/team`],
                ['tables', counts?.tables ?? 0, `${base}/restaurant/tables`],
              ] as const
            ).map(([key, count, href], index) => (
              <li key={key} className={count > 0 ? 'restaurant-steps__done' : ''}>
                <span className="restaurant-steps__mark" aria-hidden="true">
                  {count > 0 ? '✓' : String(index + 1)}
                </span>
                <span>
                  <strong>{t(`restaurant.home.step.${key}`)}</strong>
                  <small>
                    {counts ? t(`restaurant.home.count.${key}`, { count: String(count) }) : '…'}
                  </small>
                </span>
                <Link className="button button--secondary button--sm" href={href}>
                  <span>{t(count > 0 ? 'restaurant.home.manage' : 'restaurant.home.start')}</span>
                </Link>
              </li>
            ))}
          </ol>
        </section>
      ) : (
        <p className="medical-callout">
          {me.role
            ? t('restaurant.home.you_are', {
                role: t(`restaurant.role.${me.role}`),
                branch: me.branch?.name ?? '',
              })
            : null}
          {me.role === 'delivery' ? ` ${t('restaurant.home.delivery_soon')}` : null}
        </p>
      )}

      {me.branches.length > 0 ? (
        <section className="restaurant-now" aria-label={t('restaurant.home.now')}>
          <div className="pos__toolbar">
            <h2>{t('restaurant.home.now')}</h2>
            <BranchPicker t={t} me={me} branch={branch} onChange={chooseBranch} />
            <LiveIndicator t={t} live={live.live} />
          </div>
          <div className="restaurant-kpis">
            {(['new', 'preparing', 'ready'] as const).map((status) => (
              <div key={status} className={`restaurant-kpi restaurant-kpi--${status}`}>
                <span>{t(`restaurant.kitchen.column.${status}`)}</span>
                <strong>
                  {live.orders === null
                    ? '…'
                    : String(orders.filter((o) => o.status === status).length)}
                </strong>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="restaurant-screens" aria-label={t('restaurant.home.screens')}>
        {screens
          .filter((s) => s.show)
          .map((s) => (
            <Link key={s.key} href={s.href} className="restaurant-screen">
              <strong>{t(`restaurant.nav.${s.key}`)}</strong>
              <small>{t(`restaurant.home.screen_help.${s.key}`)}</small>
            </Link>
          ))}
      </section>
    </div>
  );
}

// ===========================================================================
// Branches
// ===========================================================================

export function RestaurantBranches({
  locale,
  surface,
}: {
  readonly locale: Locale;
  readonly surface: Surface;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const title = t('restaurant.branches.title');
  return (
    <RestaurantGate
      locale={locale}
      title={title}
      need="owner"
      description={t('restaurant.branches.help')}
      crumbs={[
        {
          label: t('restaurant.home.title'),
          href: `${restaurantBase(locale, surface)}/restaurant`,
        },
        { label: title },
      ]}
    >
      {() => <Branches locale={locale} t={t} />}
    </RestaurantGate>
  );
}

function Branches({
  locale,
  t,
}: {
  readonly locale: Locale;
  readonly t: Translator;
}): React.JSX.Element {
  const load = useCallback((signal: AbortSignal) => loadBranches(locale, signal), [locale]);
  const branches = useResource(load);
  const [editing, setEditing] = useState<Branch | 'new' | null>(null);
  if (branches.state.status === 'loading') return <LoadingState t={t} rows={4} />;
  if (branches.state.status === 'error')
    return <ErrorState t={t} error={branches.state.error} onRetry={branches.reload} />;
  const list = branches.state.value;
  return (
    <>
      <div className="restaurant-bar">
        <Button onClick={() => setEditing('new')}>{t('restaurant.branches.add')}</Button>
      </div>
      {list.length === 0 ? (
        <p className="restaurant-empty">{t('restaurant.branches.none')}</p>
      ) : (
        <Card className="employees-table restaurant-table">
          <DataTable
            headers={[
              t('restaurant.branches.name'),
              t('restaurant.branches.address'),
              t('restaurant.branches.rates'),
              t('restaurant.branches.people'),
              '',
            ]}
            rows={list.map((b) => [
              <Cell key="n" label={t('restaurant.branches.name')}>
                <strong>{b.name}</strong>{' '}
                {b.archived ? <Badge tone="cancelled">{t('restaurant.archived')}</Badge> : null}
              </Cell>,
              <Cell key="a" label={t('restaurant.branches.address')}>
                {[b.address, b.phone].filter(Boolean).join(' · ') || '—'}
              </Cell>,
              <Cell key="r" label={t('restaurant.branches.rates')}>
                {t('restaurant.branches.rates_value', { tax: b.tax_rate, service: b.service_rate })}
              </Cell>,
              <Cell key="p" label={t('restaurant.branches.people')}>
                {t('restaurant.branches.people_value', {
                  staff: String(b.staff_count),
                  tables: String(b.table_count),
                })}
              </Cell>,
              <Cell key="e" label="">
                <Button variant="secondary" size="sm" onClick={() => setEditing(b)}>
                  {t('restaurant.edit')}
                </Button>
              </Cell>,
            ])}
          />
        </Card>
      )}
      {editing ? (
        <BranchDialog
          locale={locale}
          t={t}
          branch={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(value) => {
            branches.replace(value);
            setEditing(null);
          }}
        />
      ) : null}
    </>
  );
}

function BranchDialog({
  locale,
  t,
  branch,
  onClose,
  onSaved,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly branch: Branch | null;
  readonly onClose: () => void;
  readonly onSaved: (value: Branch[]) => void;
}): React.JSX.Element {
  const [name, setName] = useState(branch?.name ?? '');
  const [address, setAddress] = useState(branch?.address ?? '');
  const [phone, setPhone] = useState(branch?.phone ?? '');
  const [tax, setTax] = useState(branch?.tax_rate ?? '14.00');
  const [service, setService] = useState(branch?.service_rate ?? '0.00');
  const [archived, setArchived] = useState(branch?.archived ?? false);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const save = async (): Promise<void> => {
    const problems: Record<string, string> = {};
    if (!name.trim()) problems.name = t('validation.required');
    if (!isMoney(tax)) problems.tax_rate = t('validation.invalid');
    if (!isMoney(service)) problems.service_rate = t('validation.invalid');
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    setBusy(true);
    try {
      onSaved(
        await saveBranch(locale, branch?.id ?? null, {
          name: name.trim(),
          address: address.trim() || null,
          phone: phone.trim() || null,
          tax_rate: tax.trim(),
          service_rate: service.trim(),
          ...(branch ? { archived } : {}),
        }),
      );
    } catch (error) {
      const mapped = translated(t, error);
      setErrors(Object.keys(mapped).length > 0 ? mapped : { form: t('restaurant.save_failed') });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title={branch ? t('restaurant.branches.edit') : t('restaurant.branches.add')}
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
        <Field
          label={t('restaurant.branches.name')}
          required
          {...(errors.name ? { error: errors.name } : {})}
        >
          <Input
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('restaurant.branches.name_hint')}
          />
        </Field>
        <Field label={t('restaurant.branches.address')}>
          <Input value={address} maxLength={300} onChange={(e) => setAddress(e.target.value)} />
        </Field>
        <Field label={t('restaurant.branches.phone')}>
          <Input
            value={phone}
            maxLength={40}
            dir="ltr"
            inputMode="tel"
            onChange={(e) => setPhone(e.target.value)}
          />
        </Field>
        <div className="restaurant-form__row">
          <Field
            label={t('restaurant.branches.tax_rate')}
            helper={t('restaurant.branches.tax_help')}
            {...(errors.tax_rate ? { error: errors.tax_rate } : {})}
          >
            <Input
              value={tax}
              dir="ltr"
              inputMode="decimal"
              onChange={(e) => setTax(e.target.value)}
            />
          </Field>
          <Field
            label={t('restaurant.branches.service_rate')}
            helper={t('restaurant.branches.service_help')}
            {...(errors.service_rate ? { error: errors.service_rate } : {})}
          >
            <Input
              value={service}
              dir="ltr"
              inputMode="decimal"
              onChange={(e) => setService(e.target.value)}
            />
          </Field>
        </div>
        {branch ? (
          <Toggle
            label={t('restaurant.branches.archive')}
            checked={archived}
            onChange={(e) => setArchived(e.target.checked)}
          />
        ) : null}
        {errors.archived ? (
          <p className="pos__failure">{t('restaurant.branches.archive_blocked')}</p>
        ) : null}
        {errors.form ? <p className="pos__failure">{errors.form}</p> : null}
      </div>
    </Modal>
  );
}

// ===========================================================================
// Tables
// ===========================================================================

export function RestaurantTables({
  locale,
  surface,
}: {
  readonly locale: Locale;
  readonly surface: Surface;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const title = t('restaurant.tables.title');
  return (
    <RestaurantGate
      locale={locale}
      title={title}
      need="owner"
      description={t('restaurant.tables.help')}
      crumbs={[
        {
          label: t('restaurant.home.title'),
          href: `${restaurantBase(locale, surface)}/restaurant`,
        },
        { label: title },
      ]}
    >
      {(me) =>
        me.branches.length === 0 ? (
          <p className="restaurant-empty">
            {t('restaurant.tables.branch_first')}{' '}
            <Link href={`${restaurantBase(locale, surface)}/restaurant/branches`}>
              {t('restaurant.branches.add')}
            </Link>
          </p>
        ) : (
          <Tables locale={locale} t={t} me={me} />
        )
      }
    </RestaurantGate>
  );
}

function Tables({
  locale,
  t,
  me,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly me: RestaurantMe;
}): React.JSX.Element {
  const [branch, chooseBranch] = useWorkBranch(me);
  const [tables, setTables] = useState<readonly Table[] | null>(null);
  const [waiters, setWaiters] = useState<readonly PersonRef[]>([]);
  const [editing, setEditing] = useState<Table | 'new' | null>(null);
  const [failed, setFailed] = useState(false);
  const branchId = branch?.id ?? null;
  const reload = useCallback(() => {
    if (!branchId) return;
    setFailed(false);
    loadTables(locale, branchId, true).then(setTables, () => setFailed(true));
    loadWaiters(locale, branchId).then(setWaiters, () => setWaiters([]));
  }, [locale, branchId]);
  useEffect(reload, [reload]);
  return (
    <>
      <div className="restaurant-bar">
        <BranchPicker t={t} me={me} branch={branch} onChange={chooseBranch} />
        <Button onClick={() => setEditing('new')}>{t('restaurant.tables.add')}</Button>
      </div>
      {failed ? (
        <p className="restaurant-error">{t('restaurant.load_failed')}</p>
      ) : tables === null ? (
        <LoadingState t={t} rows={3} />
      ) : tables.length === 0 ? (
        <p className="restaurant-empty">{t('restaurant.tables.none')}</p>
      ) : (
        <ul className="table-grid">
          {tables.map((table) => (
            <li key={table.id}>
              <button
                type="button"
                className={`table-tile${table.occupied_by ? ' table-tile--busy' : ''}${table.archived ? ' table-tile--archived' : ''}`}
                onClick={() => setEditing(table)}
              >
                <strong>{table.label}</strong>
                <small>{t('restaurant.tables.seats', { count: String(table.seats) })}</small>
                <small>
                  {table.default_waiter
                    ? table.default_waiter.name
                    : t('restaurant.tables.no_waiter')}
                </small>
                <small>
                  {table.archived
                    ? t('restaurant.archived')
                    : table.occupied_by
                      ? t('restaurant.tables.occupied', {
                          number: String(table.occupied_by.number),
                        })
                      : t('restaurant.tables.free')}
                </small>
              </button>
            </li>
          ))}
        </ul>
      )}
      {editing && branchId ? (
        <TableDialog
          locale={locale}
          t={t}
          branchId={branchId}
          table={editing === 'new' ? null : editing}
          waiters={waiters}
          onClose={() => setEditing(null)}
          onSaved={(value) => {
            setTables(value);
            setEditing(null);
          }}
        />
      ) : null}
    </>
  );
}

function TableDialog({
  locale,
  t,
  branchId,
  table,
  waiters,
  onClose,
  onSaved,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly branchId: string;
  readonly table: Table | null;
  readonly waiters: readonly PersonRef[];
  readonly onClose: () => void;
  readonly onSaved: (value: Table[]) => void;
}): React.JSX.Element {
  const [label, setLabel] = useState(table?.label ?? '');
  const [seats, setSeats] = useState(String(table?.seats ?? 4));
  const [waiter, setWaiter] = useState(table?.default_waiter?.id ?? '');
  const [archived, setArchived] = useState(table?.archived ?? false);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const save = async (): Promise<void> => {
    const seatCount = Number.parseInt(seats, 10);
    const problems: Record<string, string> = {};
    if (!label.trim()) problems.label = t('validation.required');
    if (!Number.isInteger(seatCount) || seatCount < 1 || seatCount > 100)
      problems.seats = t('validation.invalid');
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    setBusy(true);
    try {
      onSaved(
        await saveTable(locale, table?.id ?? null, {
          ...(table ? { archived } : { branch_id: branchId }),
          label: label.trim(),
          seats: seatCount,
          default_waiter_id: waiter || null,
        }),
      );
    } catch (error) {
      const mapped = translated(t, error);
      setErrors(Object.keys(mapped).length > 0 ? mapped : { form: t('restaurant.save_failed') });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title={
        table ? t('restaurant.tables.edit', { label: table.label }) : t('restaurant.tables.add')
      }
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
        <div className="restaurant-form__row">
          <Field
            label={t('restaurant.tables.label')}
            required
            {...(errors.label ? { error: errors.label } : {})}
          >
            <Input
              value={label}
              maxLength={30}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="T1"
            />
          </Field>
          <Field
            label={t('restaurant.tables.seats_label')}
            {...(errors.seats ? { error: errors.seats } : {})}
          >
            <Input
              value={seats}
              inputMode="numeric"
              dir="ltr"
              onChange={(e) => setSeats(e.target.value)}
            />
          </Field>
        </div>
        <Field
          label={t('restaurant.tables.default_waiter')}
          helper={t('restaurant.tables.default_waiter_help')}
          {...(errors.default_waiter_id ? { error: errors.default_waiter_id } : {})}
        >
          <Select value={waiter} onChange={(e) => setWaiter(e.target.value)}>
            <option value="">{t('restaurant.tables.no_waiter')}</option>
            {waiters.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        </Field>
        {table ? (
          <Toggle
            label={t('restaurant.tables.archive')}
            checked={archived}
            onChange={(e) => setArchived(e.target.checked)}
          />
        ) : null}
        {errors.archived ? (
          <p className="pos__failure">{t('restaurant.tables.archive_blocked')}</p>
        ) : null}
        {errors.form ? <p className="pos__failure">{errors.form}</p> : null}
      </div>
    </Modal>
  );
}

// ===========================================================================
// Team
// ===========================================================================

export function RestaurantTeam({
  locale,
  surface,
}: {
  readonly locale: Locale;
  readonly surface: Surface;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const title = t('restaurant.team.title');
  return (
    <RestaurantGate
      locale={locale}
      title={title}
      need="owner"
      description={t('restaurant.team.help')}
      crumbs={[
        {
          label: t('restaurant.home.title'),
          href: `${restaurantBase(locale, surface)}/restaurant`,
        },
        { label: title },
      ]}
    >
      {(me) =>
        me.branches.length === 0 ? (
          <p className="restaurant-empty">
            {t('restaurant.tables.branch_first')}{' '}
            <Link href={`${restaurantBase(locale, surface)}/restaurant/branches`}>
              {t('restaurant.branches.add')}
            </Link>
          </p>
        ) : (
          <Team locale={locale} t={t} me={me} />
        )
      }
    </RestaurantGate>
  );
}

const WEEK = [6, 7, 1, 2, 3, 4, 5] as const; // Saturday first, as the Egyptian week starts.

function Team({
  locale,
  t,
  me,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly me: RestaurantMe;
}): React.JSX.Element {
  const load = useCallback((signal: AbortSignal) => loadStaff(locale, signal), [locale]);
  const staff = useResource(load);
  const [editing, setEditing] = useState<StaffMember | null>(null);
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState<string>('all');
  if (staff.state.status === 'loading') return <LoadingState t={t} rows={5} />;
  if (staff.state.status === 'error')
    return <ErrorState t={t} error={staff.state.error} onRetry={staff.reload} />;
  const list = staff.state.value.filter(
    (s) =>
      filter === 'all' ||
      (filter === 'none' ? s.restaurant === null : s.restaurant?.branch.id === filter),
  );
  return (
    <>
      <div className="restaurant-bar">
        <Select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label={t('restaurant.branch')}
        >
          <option value="all">{t('restaurant.team.all_branches')}</option>
          {me.branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
          <option value="none">{t('restaurant.team.not_on_team')}</option>
        </Select>
        <Button onClick={() => setAdding(true)}>{t('restaurant.team.add')}</Button>
      </div>
      {list.length === 0 ? (
        <p className="restaurant-empty">{t('restaurant.team.none')}</p>
      ) : (
        <Card className="employees-table restaurant-table">
          <DataTable
            headers={[
              t('restaurant.team.employee'),
              t('restaurant.team.role'),
              t('restaurant.branch'),
              t('restaurant.team.shift'),
              '',
            ]}
            rows={list.map((s) => [
              <Cell key="n" label={t('restaurant.team.employee')}>
                <span className="person">
                  <span className="avatar" aria-hidden="true">
                    {s.name.slice(0, 1)}
                  </span>
                  <span>
                    {s.name}
                    <small className="medical-muted">
                      {' '}
                      <Ltr>{s.email ?? s.employee_code}</Ltr>
                    </small>
                  </span>
                </span>
              </Cell>,
              <Cell key="r" label={t('restaurant.team.role')}>
                {s.restaurant ? (
                  <>
                    {t(`restaurant.role.${s.restaurant.role}`)}
                    {s.restaurant.job_title ? (
                      <span className="medical-muted"> · {s.restaurant.job_title}</span>
                    ) : null}
                    {!s.restaurant.active ? (
                      <Badge tone="cancelled">{t('restaurant.team.inactive')}</Badge>
                    ) : null}
                  </>
                ) : (
                  <span className="medical-muted">{t('restaurant.team.not_on_team')}</span>
                )}
              </Cell>,
              <Cell key="b" label={t('restaurant.branch')}>
                {s.restaurant?.branch.name ?? '—'}
              </Cell>,
              <Cell key="s" label={t('restaurant.team.shift')}>
                {s.restaurant && s.restaurant.shift_start && s.restaurant.shift_end ? (
                  <span>
                    <Ltr>
                      {s.restaurant.shift_start}–{s.restaurant.shift_end}
                    </Ltr>{' '}
                    <span className="medical-muted">
                      ·{' '}
                      {t('restaurant.team.days_count', {
                        count: String(s.restaurant.working_days.length),
                      })}{' '}
                      ·{' '}
                      {t('restaurant.team.weekly_hours', {
                        hours: hours(s.restaurant.weekly_minutes),
                      })}
                    </span>
                  </span>
                ) : (
                  '—'
                )}
              </Cell>,
              <Cell key="e" label="">
                <Button variant="secondary" size="sm" onClick={() => setEditing(s)}>
                  {s.restaurant ? t('restaurant.edit') : t('restaurant.team.assign')}
                </Button>
              </Cell>,
            ])}
          />
        </Card>
      )}
      {editing ? (
        <StaffDialog
          locale={locale}
          t={t}
          me={me}
          member={editing}
          onClose={() => setEditing(null)}
          onSaved={(value) => {
            staff.replace(value);
            setEditing(null);
          }}
        />
      ) : null}
      {adding ? (
        <NewEmployeeDialog
          locale={locale}
          t={t}
          me={me}
          onClose={() => setAdding(false)}
          onSaved={(value) => {
            staff.replace(value);
            setAdding(false);
          }}
        />
      ) : null}
    </>
  );
}

interface ShiftValues {
  branchId: string;
  role: RestaurantRole;
  jobTitle: string;
  days: number[];
  start: string;
  end: string;
  breakMinutes: string;
  active: boolean;
}

function ShiftFields({
  t,
  me,
  values,
  onChange,
  errors,
}: {
  readonly t: Translator;
  readonly me: RestaurantMe;
  readonly values: ShiftValues;
  readonly onChange: (next: ShiftValues) => void;
  readonly errors: Readonly<Record<string, string>>;
}): React.JSX.Element {
  const set = (patch: Partial<ShiftValues>): void => onChange({ ...values, ...patch });
  return (
    <>
      <div className="restaurant-form__row">
        <Field
          label={t('restaurant.branch')}
          required
          {...(errors.branch_id ? { error: errors.branch_id } : {})}
        >
          <Select value={values.branchId} onChange={(e) => set({ branchId: e.target.value })}>
            {me.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label={t('restaurant.team.role')}
          required
          {...(errors.role ? { error: errors.role } : {})}
        >
          <Select
            value={values.role}
            onChange={(e) => set({ role: e.target.value as RestaurantRole })}
          >
            {RESTAURANT_ROLES.map((role) => (
              <option key={role} value={role}>
                {t(`restaurant.role.${role}`)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <p className="restaurant-role-help">{t(`restaurant.role_help.${values.role}`)}</p>
      <Field label={t('restaurant.team.job_title')}>
        <Input
          value={values.jobTitle}
          maxLength={80}
          onChange={(e) => set({ jobTitle: e.target.value })}
          placeholder={t('restaurant.team.job_title_hint')}
        />
      </Field>
      <fieldset className="restaurant-days">
        <legend>{t('restaurant.team.working_days')}</legend>
        {WEEK.map((day) => (
          <button
            key={day}
            type="button"
            className="restaurant-chip"
            aria-pressed={values.days.includes(day)}
            onClick={() =>
              set({
                days: values.days.includes(day)
                  ? values.days.filter((d) => d !== day)
                  : [...values.days, day],
              })
            }
          >
            {t(`restaurant.day.${String(day)}`)}
          </button>
        ))}
      </fieldset>
      <div className="restaurant-form__row restaurant-form__row--3">
        <Field
          label={t('restaurant.team.shift_start')}
          {...(errors.shift_start ? { error: errors.shift_start } : {})}
        >
          <Input
            type="time"
            value={values.start}
            onChange={(e) => set({ start: e.target.value })}
          />
        </Field>
        <Field
          label={t('restaurant.team.shift_end')}
          {...(errors.shift_end ? { error: errors.shift_end } : {})}
        >
          <Input type="time" value={values.end} onChange={(e) => set({ end: e.target.value })} />
        </Field>
        <Field
          label={t('restaurant.team.break')}
          {...(errors.break_minutes ? { error: errors.break_minutes } : {})}
        >
          <Input
            value={values.breakMinutes}
            inputMode="numeric"
            dir="ltr"
            onChange={(e) => set({ breakMinutes: e.target.value })}
          />
        </Field>
      </div>
      <Toggle
        label={t('restaurant.team.active')}
        checked={values.active}
        onChange={(e) => set({ active: e.target.checked })}
      />
    </>
  );
}

function shiftProblems(t: Translator, v: ShiftValues): Record<string, string> {
  const problems: Record<string, string> = {};
  const brk = Number.parseInt(v.breakMinutes || '0', 10);
  if (!Number.isInteger(brk) || brk < 0 || brk > 480)
    problems.break_minutes = t('validation.invalid');
  if ((v.start === '') !== (v.end === ''))
    problems[v.start === '' ? 'shift_start' : 'shift_end'] = t('validation.required');
  return problems;
}

function shiftBody(v: ShiftValues): Parameters<typeof saveStaff>[2] {
  return {
    branch_id: v.branchId,
    role: v.role,
    job_title: v.jobTitle.trim() || null,
    working_days: [...v.days].sort((a, b) => a - b),
    shift_start: v.start || null,
    shift_end: v.end || null,
    break_minutes: Number.parseInt(v.breakMinutes || '0', 10),
    active: v.active,
  };
}

function StaffDialog({
  locale,
  t,
  me,
  member,
  onClose,
  onSaved,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly me: RestaurantMe;
  readonly member: StaffMember;
  readonly onClose: () => void;
  readonly onSaved: (value: StaffMember[]) => void;
}): React.JSX.Element {
  const r = member.restaurant;
  const [values, setValues] = useState<ShiftValues>({
    branchId: r?.branch.id ?? me.branches[0]?.id ?? '',
    role: r?.role ?? 'cashier',
    jobTitle: r?.job_title ?? '',
    days: [...(r?.working_days ?? [6, 7, 1, 2, 3])],
    start: r?.shift_start ?? '',
    end: r?.shift_end ?? '',
    breakMinutes: String(r?.break_minutes ?? 30),
    active: r?.active ?? true,
  });
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const save = async (): Promise<void> => {
    const problems = shiftProblems(t, values);
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    setBusy(true);
    try {
      onSaved(await saveStaff(locale, member.employee_id, shiftBody(values)));
    } catch (error) {
      const mapped = translated(t, error);
      setErrors(Object.keys(mapped).length > 0 ? mapped : { form: t('restaurant.save_failed') });
    } finally {
      setBusy(false);
    }
  };
  const remove = async (): Promise<void> => {
    setBusy(true);
    try {
      onSaved(await removeStaff(locale, member.employee_id));
    } catch {
      setErrors({ form: t('restaurant.save_failed') });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title={member.name}
      onClose={onClose}
      closeLabel={t('restaurant.close')}
      footer={
        <>
          {r ? (
            <Button variant="destructive-ghost" disabled={busy} onClick={() => void remove()}>
              {t('restaurant.team.remove')}
            </Button>
          ) : null}
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
        {!member.has_login ? (
          <p className="medical-callout">{t('restaurant.team.no_login')}</p>
        ) : null}
        <ShiftFields t={t} me={me} values={values} onChange={setValues} errors={errors} />
        {errors.form ? <p className="pos__failure">{errors.form}</p> : null}
      </div>
    </Modal>
  );
}

interface ScheduleOption {
  readonly id: string;
  readonly name: string;
  readonly is_default: boolean;
}

/** Creates the employee's account (POST /employees) and puts them on the team in one step. */
function NewEmployeeDialog({
  locale,
  t,
  me,
  onClose,
  onSaved,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly me: RestaurantMe;
  readonly onClose: () => void;
  readonly onSaved: (value: StaffMember[]) => void;
}): React.JSX.Element {
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [salary, setSalary] = useState('');
  const [schedules, setSchedules] = useState<readonly ScheduleOption[]>([]);
  const [values, setValues] = useState<ShiftValues>({
    branchId: me.branches[0]?.id ?? '',
    role: 'cashier',
    jobTitle: '',
    days: [6, 7, 1, 2, 3],
    start: '10:00',
    end: '18:00',
    breakMinutes: '30',
    active: true,
  });
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);

  useEffect(() => {
    fetchMany<ScheduleOption>('/work-schedules', { locale, query: { per_page: '100' } }).then(
      (result) => setSchedules(result.items),
      () => setSchedules([]),
    );
  }, [locale]);

  const save = async (): Promise<void> => {
    const problems: Record<string, string> = { ...shiftProblems(t, values) };
    if (!createdId) {
      if (!first.trim()) problems.first_name = t('validation.required');
      if (!last.trim()) problems.last_name = t('validation.required');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
        problems.email = t('validation.invalid');
      if (password.length < 10) problems.password = t('restaurant.team.password_rule');
      if (!isMoney(salary) || salary.trim() === '0')
        problems.monthly_salary = t('validation.invalid');
      if (schedules.length === 0) problems.form = t('restaurant.team.no_schedule');
    }
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    setBusy(true);
    try {
      let employeeId = createdId;
      if (!employeeId) {
        const schedule = schedules.find((s) => s.is_default) ?? schedules[0];
        const code = `R-${Date.now().toString(36).toUpperCase()}`;
        const today = new Date().toISOString().slice(0, 10);
        const created = await fetchOne<{ id: string }>('/employees', {
          locale,
          method: 'POST',
          body: {
            first_name: first.trim(),
            last_name: last.trim(),
            email: email.trim(),
            phone: phone.trim() || null,
            employee_code: code,
            work_schedule_id: schedule?.id,
            joining_date: today,
            role_key: 'employee',
            monthly_salary: salary.trim(),
            send_invitation: false,
            password,
          },
        });
        employeeId = created.id;
        // If the next step fails, a retry only assigns — it never creates a second account.
        setCreatedId(employeeId);
      }
      onSaved(await saveStaff(locale, employeeId, shiftBody(values)));
    } catch (error) {
      const mapped = translated(t, error);
      setErrors(Object.keys(mapped).length > 0 ? mapped : { form: t('restaurant.save_failed') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={t('restaurant.team.add')}
      onClose={onClose}
      closeLabel={t('restaurant.close')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('restaurant.cancel')}
          </Button>
          <Button loading={busy} onClick={() => void save()}>
            {t('restaurant.team.create')}
          </Button>
        </>
      }
    >
      <div className="restaurant-form">
        {createdId ? (
          <p className="medical-notice">{t('restaurant.team.created_assign')}</p>
        ) : (
          <>
            <div className="restaurant-form__row">
              <Field
                label={t('restaurant.team.first_name')}
                required
                {...(errors.first_name ? { error: errors.first_name } : {})}
              >
                <Input value={first} maxLength={100} onChange={(e) => setFirst(e.target.value)} />
              </Field>
              <Field
                label={t('restaurant.team.last_name')}
                required
                {...(errors.last_name ? { error: errors.last_name } : {})}
              >
                <Input value={last} maxLength={100} onChange={(e) => setLast(e.target.value)} />
              </Field>
            </div>
            <div className="restaurant-form__row">
              <Field
                label={t('restaurant.team.email')}
                required
                helper={t('restaurant.team.email_help')}
                {...(errors.email ? { error: errors.email } : {})}
              >
                <Input
                  type="email"
                  dir="ltr"
                  value={email}
                  autoComplete="off"
                  onChange={(e) => setEmail(e.target.value)}
                />
              </Field>
              <Field
                label={t('restaurant.team.phone')}
                {...(errors.phone ? { error: errors.phone } : {})}
              >
                <Input
                  dir="ltr"
                  inputMode="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
              </Field>
            </div>
            <div className="restaurant-form__row">
              <Field
                label={t('restaurant.team.password')}
                required
                helper={t('restaurant.team.password_rule')}
                {...(errors.password ? { error: errors.password } : {})}
              >
                <Input
                  type="password"
                  value={password}
                  autoComplete="new-password"
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
              <Field
                label={t('restaurant.team.salary')}
                required
                {...(errors.monthly_salary ? { error: errors.monthly_salary } : {})}
              >
                <Input
                  dir="ltr"
                  inputMode="decimal"
                  value={salary}
                  placeholder="6000.00"
                  onChange={(e) => setSalary(e.target.value)}
                />
              </Field>
            </div>
          </>
        )}
        <ShiftFields t={t} me={me} values={values} onChange={setValues} errors={errors} />
        {errors.form ? <p className="pos__failure">{errors.form}</p> : null}
      </div>
    </Modal>
  );
}

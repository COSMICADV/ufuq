'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { ApiError, fetchOne, sendNoContent } from '../../../lib/api-client';
import {
  ALERT_CHOICES,
  budgetTitle,
  categoryLabel,
  CURRENCIES,
  money,
  readAmount,
  shiftMonth,
} from '../../../lib/finance';
import type { Account, Budget, BudgetList, BudgetPeriod, Category } from '../../../lib/finance';
import { Button, Field, Input, Modal, Select } from '../../design-system';
import { ExpensesHeader } from './finance-parts';

type Scope = 'overall' | 'category';

export function monthLabel(month: string, locale: Locale): string {
  const [y, m] = month.split('-').map(Number);
  const tag = locale === 'ar' ? 'ar-EG-u-nu-latn' : locale;
  return new Intl.DateTimeFormat(tag, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y ?? 2026, (m ?? 1) - 1, 1)),
  );
}

function dayLabel(day: string, locale: Locale): string {
  const tag = locale === 'ar' ? 'ar-EG-u-nu-latn' : locale;
  return new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${day}T00:00:00Z`),
  );
}

/** A budget's bar: spent against the limit, with a tick at each alert. */
export function BudgetBar({
  period,
  thresholds,
}: {
  readonly period: BudgetPeriod;
  readonly thresholds: readonly number[];
}): React.JSX.Element {
  return (
    <span className={`budget-bar budget-bar--${period.state}`} aria-hidden="true">
      <span className="budget-bar__fill" style={{ inlineSize: `${String(Math.min(100, period.percent))}%` }} />
      {thresholds
        .filter((t) => t < 100)
        .map((t) => (
          <span key={t} className="budget-bar__tick" style={{ insetInlineStart: `${String(t)}%` }} />
        ))}
    </span>
  );
}

/** The in-app alert line for a budget that has crossed one of its thresholds. */
export function budgetAlert(budget: Budget, t: ReturnType<typeof createTranslator>): string | null {
  const current = budget.current;
  if (!current || current.level === null) return null;
  const title = budgetTitle(budget, t);
  if (current.state === 'over') return t('finance.budget.alert_over', { name: title });
  if (current.state === 'reached') return t('finance.budget.alert_reached', { name: title });
  return t('finance.budget.alert_level', { name: title, level: String(current.level) });
}

interface Draft {
  scope: Scope;
  categoryId: string;
  period: 'monthly' | 'custom';
  amount: string;
  currency: string;
  startMonth: string;
  startDate: string;
  endDate: string;
  rollover: boolean;
  alerts: number[];
  name: string;
}

/** Monthly and custom budgets: overall, per category (fuel and home included). */
export function BudgetsScreen({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const [month, setMonth] = useState<string | null>(null);
  const [data, setData] = useState<BudgetList | null>(null);
  const [categories, setCategories] = useState<readonly Category[]>([]);
  const [accounts, setAccounts] = useState<readonly Account[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState<Budget | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [history, setHistory] = useState<{ budget: Budget; rows: BudgetPeriod[] | null } | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setFailed(false);
      const query: Record<string, string> = showArchived ? { include_archived: 'true' } : {};
      if (month) query.month = month;
      const [list, cats, accs] = await Promise.all([
        fetchOne<BudgetList>('/personal/finance/budgets', { locale, query }),
        fetchOne<Category[]>('/personal/finance/categories', { locale }),
        fetchOne<Account[]>('/personal/finance/accounts', { locale }),
      ]);
      setData(list);
      setCategories(cats);
      setAccounts(accs);
      if (!month) setMonth(list.month);
    } catch {
      setFailed(true);
    }
  }, [locale, month, showArchived]);

  useEffect(() => {
    void load();
  }, [load]);

  const expenseOptions = useMemo(() => {
    const own = categories.filter((c) => c.kind === 'expense' && !c.archived);
    return own
      .filter((c) => c.parent_id === null)
      .flatMap((parent) => [
        { id: parent.id, label: categoryLabel(parent, t) },
        ...own.filter((c) => c.parent_id === parent.id).map((c) => ({ id: c.id, label: `— ${categoryLabel(c, t)}` })),
      ]);
  }, [categories, t]);

  const currencies = useMemo(() => {
    const own = new Set<string>([data?.currency ?? 'EGP', ...accounts.map((a) => a.currency)]);
    return [...own, ...CURRENCIES.filter((c) => !own.has(c))];
  }, [accounts, data]);

  const open = (budget: Budget | 'new', preset?: { scope: Scope; key?: string }): void => {
    setErrors({});
    setEditing(budget);
    const thisMonth = data?.month ?? month ?? '';
    if (budget === 'new') {
      const presetCategory = preset?.key ? categories.find((c) => c.key === preset.key)?.id ?? '' : '';
      setDraft({
        scope: preset?.scope ?? 'category',
        categoryId: presetCategory,
        period: 'monthly',
        amount: '',
        currency: data?.currency ?? 'EGP',
        startMonth: thisMonth,
        startDate: `${thisMonth}-01`,
        endDate: '',
        rollover: false,
        alerts: [80, 90, 100],
        name: '',
      });
    } else {
      setDraft({
        scope: budget.category_id ? 'category' : 'overall',
        categoryId: budget.category_id ?? '',
        period: budget.period,
        amount: budget.amount,
        currency: budget.currency,
        startMonth: budget.start_date.slice(0, 7),
        startDate: budget.start_date,
        endDate: budget.end_date ?? '',
        rollover: budget.rollover,
        alerts: [...budget.alert_thresholds],
        name: budget.name ?? '',
      });
    }
  };

  const save = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!draft || !editing) return;
    const amount = readAmount(draft.amount);
    const next: Record<string, string> = {};
    if (amount === null) next.amount = t('finance.error.amount');
    if (editing === 'new' && draft.scope === 'category' && !draft.categoryId) next.category = t('finance.budget.pick_category');
    if (draft.period === 'custom' && (!draft.startDate || !draft.endDate || draft.endDate < draft.startDate)) {
      next.dates = t('finance.budget.error_dates');
    }
    setErrors(next);
    if (Object.keys(next).length > 0 || amount === null) return;
    setSaving(true);
    try {
      if (editing === 'new') {
        await fetchOne('/personal/finance/budgets', {
          locale,
          method: 'POST',
          body: {
            period: draft.period,
            amount,
            currency: draft.currency,
            alert_thresholds: draft.alerts,
            ...(draft.name.trim() ? { name: draft.name.trim() } : {}),
            ...(draft.scope === 'category' ? { category_id: draft.categoryId } : {}),
            ...(draft.period === 'monthly'
              ? { start_month: draft.startMonth, rollover: draft.rollover }
              : { start_date: draft.startDate, end_date: draft.endDate }),
          },
        });
      } else {
        await fetchOne(`/personal/finance/budgets/${editing.id}`, {
          locale,
          method: 'PATCH',
          body: {
            amount,
            alert_thresholds: draft.alerts,
            name: draft.name.trim(),
            ...(draft.period === 'monthly'
              ? { rollover: draft.rollover }
              : { start_date: draft.startDate, end_date: draft.endDate }),
          },
        });
      }
      setEditing(null);
      await load();
    } catch (error) {
      if (error instanceof ApiError && error.fields['category_id']?.includes('already_taken')) {
        setErrors({ category: t('finance.budget.error_duplicate') });
      } else if (error instanceof ApiError && (error.fields['end_date'] || error.fields['start_date'])) {
        setErrors({ dates: t('finance.budget.error_dates') });
      } else setErrors({ form: t('finance.error.generic') });
    } finally {
      setSaving(false);
    }
  };

  const archive = async (budget: Budget): Promise<void> => {
    await sendNoContent(`/personal/finance/budgets/${budget.id}`, { locale, method: 'DELETE' });
    await load();
  };
  const restore = async (budget: Budget): Promise<void> => {
    try {
      await sendNoContent(`/personal/finance/budgets/${budget.id}/restore`, { locale, method: 'POST' });
      await load();
    } catch {
      setNotice(t('finance.budget.error_duplicate'));
    }
  };

  const openHistory = async (budget: Budget): Promise<void> => {
    setHistory({ budget, rows: null });
    try {
      const rows = await fetchOne<BudgetPeriod[]>(`/personal/finance/budgets/${budget.id}/history`, { locale });
      setHistory({ budget, rows });
    } catch {
      setHistory(null);
    }
  };

  const budgets = data?.budgets ?? [];
  const running = budgets.filter((b) => !b.archived && b.current !== null);
  const idle = budgets.filter((b) => !b.archived && b.current === null);
  const archived = budgets.filter((b) => b.archived);
  const alerts = running.map((b) => ({ b, text: budgetAlert(b, t) })).filter((a) => a.text !== null);

  const card = (budget: Budget): React.JSX.Element => {
    const c = budget.current;
    return (
      <li key={budget.id} className={`budget-card${budget.archived ? ' is-archived' : ''}`}>
        <div className="budget-card__head">
          <div>
            <h2>{budgetTitle(budget, t)}</h2>
            <small>
              {budget.period === 'monthly'
                ? t('finance.budget.monthly_amount', { amount: money(budget.amount, budget.currency, locale) })
                : t('finance.budget.custom_range', {
                    from: dayLabel(budget.start_date, locale),
                    to: dayLabel(budget.end_date ?? budget.start_date, locale),
                  })}
              {budget.rollover ? ` · ${t('finance.budget.rollover_on')}` : ''}
            </small>
          </div>
          {c ? <span className={`budget-state budget-state--${c.state}`}>{t(`finance.budget.state.${c.state}`)}</span> : null}
        </div>
        {c ? (
          <>
            <BudgetBar period={c} thresholds={budget.alert_thresholds} />
            <div className="budget-card__numbers">
              <span>
                <bdi dir="ltr">{money(c.spent, budget.currency, locale)}</bdi>{' '}
                {t('finance.budget.of')} <bdi dir="ltr">{money(c.limit, budget.currency, locale)}</bdi>
              </span>
              <strong className={c.remaining.startsWith('-') ? 'fin-minus' : 'fin-plus'}>
                {c.remaining.startsWith('-')
                  ? t('finance.budget.overspent', { amount: money(c.remaining.slice(1), budget.currency, locale) })
                  : t('finance.budget.left', { amount: money(c.remaining, budget.currency, locale) })}
              </strong>
            </div>
            {c.carried !== '0.00' ? (
              <small className="budget-card__carried">
                {c.carried.startsWith('-')
                  ? t('finance.budget.carried_minus', { amount: money(c.carried.slice(1), budget.currency, locale) })
                  : t('finance.budget.carried_plus', { amount: money(c.carried, budget.currency, locale) })}
              </small>
            ) : null}
          </>
        ) : budget.archived ? null : (
          <p className="fin-muted">{t('finance.budget.not_running')}</p>
        )}
        <div className="budget-card__actions">
          {budget.archived ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                void restore(budget);
              }}
            >
              {t('finance.account.restore')}
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  open(budget);
                }}
              >
                {t('finance.budget.edit')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  void openHistory(budget);
                }}
              >
                {t('finance.budget.history')}
              </Button>
              <Button
                size="sm"
                variant="destructive-ghost"
                onClick={() => {
                  void archive(budget);
                }}
              >
                {t('finance.account.archive')}
              </Button>
            </>
          )}
        </div>
      </li>
    );
  };

  return (
    <div className="pscreen fin">
      <ExpensesHeader
        locale={locale}
        action={
          <Button
            onClick={() => {
              open('new');
            }}
          >
            + {t('finance.budget.add')}
          </Button>
        }
      />

      {month ? (
        <div className="budget-month">
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('finance.budget.prev_month')}
            onClick={() => {
              setMonth(shiftMonth(month, -1));
            }}
          >
            {locale === 'ar' ? '›' : '‹'}
          </Button>
          <strong>{monthLabel(month, locale)}</strong>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('finance.budget.next_month')}
            onClick={() => {
              setMonth(shiftMonth(month, 1));
            }}
          >
            {locale === 'ar' ? '‹' : '›'}
          </Button>
        </div>
      ) : null}

      {notice ? (
        <p className="fin-form__error" role="alert">
          {notice}
        </p>
      ) : null}
      {alerts.length > 0 ? (
        <ul className="budget-alerts" role="status">
          {alerts.map(({ b, text }) => (
            <li key={b.id} className={`budget-alert budget-alert--${b.current?.state ?? 'ok'}`}>
              {text}
            </li>
          ))}
        </ul>
      ) : null}

      {failed ? (
        <div className="pempty" role="alert">
          <p>{t('finance.error.load')}</p>
          <Button
            variant="secondary"
            onClick={() => {
              void load();
            }}
          >
            {t('finance.retry')}
          </Button>
        </div>
      ) : data === null ? (
        <div className="fin-loading" aria-busy="true" />
      ) : running.length === 0 && idle.length === 0 ? (
        <section className="fin-card budget-empty">
          <h2>{t('finance.budget.empty_title')}</h2>
          <p className="fin-muted">{t('finance.budget.empty_help')}</p>
          <div className="budget-presets">
            <Button
              variant="secondary"
              onClick={() => {
                open('new', { scope: 'overall' });
              }}
            >
              {t('finance.budget.preset_overall')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                open('new', { scope: 'category', key: 'fuel' });
              }}
            >
              {t('finance.budget.preset_fuel')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                open('new', { scope: 'category', key: 'home' });
              }}
            >
              {t('finance.budget.preset_home')}
            </Button>
          </div>
        </section>
      ) : (
        <ul className="budget-cards">
          {running.map(card)}
          {idle.map(card)}
        </ul>
      )}

      <div className="budget-archived-toggle">
        <label>
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => {
              setShowArchived(event.target.checked);
            }}
          />
          {t('finance.budget.show_archived')}
        </label>
      </div>
      {showArchived && archived.length > 0 ? <ul className="budget-cards">{archived.map(card)}</ul> : null}

      <Modal
        open={editing !== null && draft !== null}
        title={editing === 'new' ? t('finance.budget.add') : t('finance.budget.edit')}
        closeLabel={t('finance.close')}
        onClose={() => {
          setEditing(null);
        }}
      >
        {draft ? (
          <form
            className="fin-form"
            noValidate
            onSubmit={(event) => {
              void save(event);
            }}
          >
            {errors.form ? (
              <p className="fin-form__error" role="alert">
                {errors.form}
              </p>
            ) : null}
            {editing === 'new' ? (
              <>
                <div className="fin-types fin-types--two" role="radiogroup" aria-label={t('finance.budget.scope')}>
                  {(['category', 'overall'] as const).map((scope) => (
                    <button
                      key={scope}
                      type="button"
                      role="radio"
                      aria-checked={draft.scope === scope}
                      className="fin-type fin-type--transfer"
                      onClick={() => {
                        setDraft({ ...draft, scope });
                      }}
                    >
                      {t(`finance.budget.scope_${scope}`)}
                    </button>
                  ))}
                </div>
                {draft.scope === 'category' ? (
                  <Field label={t('finance.field.category')} required {...(errors.category ? { error: errors.category } : {})}>
                    <Select
                      value={draft.categoryId}
                      onChange={(event) => {
                        setDraft({ ...draft, categoryId: event.target.value });
                      }}
                    >
                      <option value="">—</option>
                      {expenseOptions.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ) : errors.category ? (
                  <p className="fin-form__error">{errors.category}</p>
                ) : null}
                <div className="fin-types fin-types--two" role="radiogroup" aria-label={t('finance.budget.period')}>
                  {(['monthly', 'custom'] as const).map((period) => (
                    <button
                      key={period}
                      type="button"
                      role="radio"
                      aria-checked={draft.period === period}
                      className="fin-type fin-type--transfer"
                      onClick={() => {
                        setDraft({ ...draft, period });
                      }}
                    >
                      {t(`finance.budget.period_${period}`)}
                    </button>
                  ))}
                </div>
              </>
            ) : null}
            <Field label={t('finance.budget.amount')} required {...(errors.amount ? { error: errors.amount } : {})}>
              <Input
                className="fin-amount"
                inputMode="decimal"
                dir="ltr"
                value={draft.amount}
                placeholder="0.00"
                onChange={(event) => {
                  setDraft({ ...draft, amount: event.target.value });
                }}
              />
            </Field>
            {editing === 'new' ? (
              <Field label={t('finance.account.currency')}>
                <Select
                  value={draft.currency}
                  onChange={(event) => {
                    setDraft({ ...draft, currency: event.target.value });
                  }}
                >
                  {currencies.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            {draft.period === 'monthly' ? (
              <>
                {editing === 'new' ? (
                  <Field label={t('finance.budget.start_month')}>
                    <Input
                      type="month"
                      value={draft.startMonth}
                      onChange={(event) => {
                        setDraft({ ...draft, startMonth: event.target.value });
                      }}
                    />
                  </Field>
                ) : null}
                <label className="budget-toggle">
                  <input
                    type="checkbox"
                    checked={draft.rollover}
                    onChange={(event) => {
                      setDraft({ ...draft, rollover: event.target.checked });
                    }}
                  />
                  <span>
                    <strong>{t('finance.budget.rollover')}</strong>
                    <small>{t('finance.budget.rollover_help')}</small>
                  </span>
                </label>
              </>
            ) : (
              <div className="budget-dates">
                <Field label={t('finance.period.from')} required {...(errors.dates ? { error: errors.dates } : {})}>
                  <Input
                    type="date"
                    value={draft.startDate}
                    onChange={(event) => {
                      setDraft({ ...draft, startDate: event.target.value });
                    }}
                  />
                </Field>
                <Field label={t('finance.period.to')} required>
                  <Input
                    type="date"
                    value={draft.endDate}
                    onChange={(event) => {
                      setDraft({ ...draft, endDate: event.target.value });
                    }}
                  />
                </Field>
              </div>
            )}
            <fieldset className="budget-alert-picker">
              <legend>{t('finance.budget.alerts')}</legend>
              <small>{t('finance.budget.alerts_help')}</small>
              <div>
                {ALERT_CHOICES.map((value) => {
                  const on = draft.alerts.includes(value);
                  return (
                    <button
                      key={value}
                      type="button"
                      className="fin-chip"
                      aria-pressed={on}
                      aria-checked={on}
                      onClick={() => {
                        setDraft({
                          ...draft,
                          alerts: on ? draft.alerts.filter((a) => a !== value) : [...draft.alerts, value].sort((a, b) => a - b),
                        });
                      }}
                    >
                      {value}%
                    </button>
                  );
                })}
              </div>
            </fieldset>
            <Field label={t('finance.budget.name_optional')}>
              <Input
                value={draft.name}
                maxLength={80}
                onChange={(event) => {
                  setDraft({ ...draft, name: event.target.value });
                }}
              />
            </Field>
            <div className="fin-form__actions">
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setEditing(null);
                }}
              >
                {t('finance.cancel')}
              </Button>
              <Button type="submit" loading={saving}>
                {t('finance.save')}
              </Button>
            </div>
          </form>
        ) : null}
      </Modal>

      <Modal
        open={history !== null}
        title={history ? `${t('finance.budget.history')} · ${budgetTitle(history.budget, t)}` : ''}
        closeLabel={t('finance.close')}
        onClose={() => {
          setHistory(null);
        }}
      >
        {history?.rows === null ? (
          <div className="fin-loading" aria-busy="true" />
        ) : (
          <ul className="budget-history">
            {(history?.rows ?? []).map((row) => (
              <li key={row.from}>
                <div className="budget-history__top">
                  <strong>
                    {row.month
                      ? monthLabel(row.month, locale)
                      : `${dayLabel(row.from, locale)} – ${dayLabel(row.to, locale)}`}
                  </strong>
                  <span className={row.remaining.startsWith('-') ? 'fin-minus' : 'fin-plus'}>
                    <bdi dir="ltr">{money(row.spent, history?.budget.currency ?? 'EGP', locale)}</bdi> /{' '}
                    <bdi dir="ltr">{money(row.limit, history?.budget.currency ?? 'EGP', locale)}</bdi>
                  </span>
                </div>
                <BudgetBar period={row} thresholds={history?.budget.alert_thresholds ?? []} />
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </div>
  );
}

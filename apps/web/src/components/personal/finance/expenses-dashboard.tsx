'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { fetchOne } from '../../../lib/api-client';
import { categoryLabel, money, PERIODS, share } from '../../../lib/finance';
import type { Account, Category, Period, Summary, Transaction } from '../../../lib/finance';
import { personalHref } from '../../../lib/personal';
import { Button } from '../../design-system';
import { ExpensesHeader, RING_COLORS, SpendingRing, TransactionRow } from './finance-parts';
import { ReceiptBatch } from './receipt-batch';
import { TransactionDialog } from './transaction-dialog';

/**
 * The Expenses overview: what is available, the period's income, spending
 * and net, spending by category, recent transactions and the accounts —
 * every figure as the API computed it from the stored transactions.
 */
export function ExpensesDashboard({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const [period, setPeriod] = useState<Period>('month');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [categories, setCategories] = useState<readonly Category[]>([]);
  const [timeZone, setTimeZone] = useState('Africa/Cairo');
  const [failed, setFailed] = useState(false);
  const [batch, setBatch] = useState(false);
  const [dialog, setDialog] = useState<{ open: boolean; editing: Transaction | null }>({
    open: false,
    editing: null,
  });

  const load = useCallback(async (): Promise<void> => {
    if (period === 'custom' && (!from || !to)) return;
    try {
      setFailed(false);
      const query: Record<string, string> = { period };
      if (period === 'custom') Object.assign(query, { from, to });
      const [next, cats, settings] = await Promise.all([
        fetchOne<Summary>('/personal/finance/summary', { locale, query }),
        fetchOne<Category[]>('/personal/finance/categories', { locale }),
        fetchOne<{ time_zone: string }>('/personal/finance/settings', { locale }),
      ]);
      setSummary(next);
      setCategories(cats);
      setTimeZone(settings.time_zone);
    } catch {
      setFailed(true);
    }
  }, [locale, period, from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  const accounts: readonly Account[] = summary?.accounts ?? [];
  const totalSpent = summary?.expense ?? '0';
  const top = (summary?.by_category ?? []).slice(0, 7);
  const rest = (summary?.by_category ?? []).slice(7);
  const parts = top.map((c, i) => ({ value: share(c.amount, totalSpent), color: RING_COLORS[i] ?? '#9aa5b8' }));
  if (rest.length > 0) {
    const restShare = rest.reduce((sum, c) => sum + share(c.amount, totalSpent), 0);
    parts.push({ value: restShare, color: RING_COLORS[7] ?? '#9aa5b8' });
  }

  return (
    <div className="pscreen fin">
      <ExpensesHeader
        locale={locale}
        action={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setBatch(true);
              }}
            >
              {t('finance.batch.open')}
            </Button>
            <Button
              onClick={() => {
                setDialog({ open: true, editing: null });
              }}
            >
              + {t('finance.add')}
            </Button>
          </>
        }
      />

      <div className="fin-periods" role="radiogroup" aria-label={t('finance.period.month')}>
        {PERIODS.map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={period === value}
            className="fin-chip"
            onClick={() => {
              setPeriod(value);
            }}
          >
            {t(`finance.period.${value}`)}
          </button>
        ))}
        {period === 'custom' ? (
          <span className="fin-custom">
            <label>
              {t('finance.period.from')}
              <input
                type="date"
                className="input"
                value={from}
                onChange={(event) => {
                  setFrom(event.target.value);
                }}
              />
            </label>
            <label>
              {t('finance.period.to')}
              <input
                type="date"
                className="input"
                value={to}
                onChange={(event) => {
                  setTo(event.target.value);
                }}
              />
            </label>
          </span>
        ) : null}
      </div>

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
      ) : summary === null ? (
        <div className="fin-loading" aria-busy="true" />
      ) : (
        <>
          <section className="fin-kpis" aria-label={t('finance.tabs.overview')}>
            <div className="fin-kpi fin-kpi--hero">
              <span>{t('finance.kpi.available')}</span>
              {summary.available.length === 0 ? (
                <strong dir="ltr">{money('0', summary.currency, locale)}</strong>
              ) : (
                summary.available.map((a) => (
                  <strong key={a.currency} dir="ltr">
                    {money(a.amount, a.currency, locale)}
                  </strong>
                ))
              )}
              {summary.credit_owed.map((o) => (
                <small key={o.currency}>
                  {t('finance.kpi.owed')}: <bdi dir="ltr">{money(o.amount, o.currency, locale)}</bdi>
                </small>
              ))}
            </div>
            <div className="fin-kpi">
              <span>{t('finance.kpi.income')}</span>
              <strong className="fin-plus" dir="ltr">
                {money(summary.income, summary.currency, locale)}
              </strong>
            </div>
            <div className="fin-kpi">
              <span>{t('finance.kpi.expense')}</span>
              <strong className="fin-minus" dir="ltr">
                {money(summary.expense, summary.currency, locale)}
              </strong>
            </div>
            <div className="fin-kpi">
              <span>{t('finance.kpi.net')}</span>
              <strong dir="ltr">{money(summary.net, summary.currency, locale)}</strong>
            </div>
          </section>
          {summary.other_currencies ? <p className="fin-note">{t('finance.other_currencies')}</p> : null}

          <div className="fin-grid">
            <section className="fin-card" aria-labelledby="fin-cat">
              <h2 id="fin-cat">{t('finance.by_category')}</h2>
              {summary.by_category.length === 0 ? (
                <p className="fin-muted">{t('finance.no_spending')}</p>
              ) : (
                <div className="fin-cats">
                  <SpendingRing parts={parts} />
                  <ul>
                    {summary.by_category.map((c, i) => (
                      <li key={c.category_id ?? 'none'}>
                        <span
                          className="fin-swatch"
                          style={{ background: RING_COLORS[Math.min(i, 7)] }}
                          aria-hidden="true"
                        />
                        <span className="fin-cats__name">{categoryLabel(c, t)}</span>
                        <span className="fin-bar" aria-hidden="true">
                          <span style={{ inlineSize: `${String(share(c.amount, totalSpent))}%` }} />
                        </span>
                        <span className="fin-cats__amount" dir="ltr">
                          {money(c.amount, summary.currency, locale)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>

            <section className="fin-card" aria-labelledby="fin-recent">
              <div className="fin-card__head">
                <h2 id="fin-recent">{t('finance.recent')}</h2>
                <Link href={`${personalHref(locale, 'expenses')}/transactions`}>{t('finance.see_all')}</Link>
              </div>
              {summary.recent.length === 0 ? (
                <p className="fin-muted">{t('finance.no_transactions')}</p>
              ) : (
                <div className="fin-rows">
                  {summary.recent.map((tx) => (
                    <TransactionRow
                      key={tx.id}
                      locale={locale}
                      timeZone={timeZone}
                      transaction={tx}
                      onOpen={(item) => {
                        setDialog({ open: true, editing: item });
                      }}
                    />
                  ))}
                </div>
              )}
            </section>

            <section className="fin-card" aria-labelledby="fin-accounts">
              <div className="fin-card__head">
                <h2 id="fin-accounts">{t('finance.your_accounts')}</h2>
                <Link href={`${personalHref(locale, 'expenses')}/accounts`}>{t('finance.manage')}</Link>
              </div>
              <ul className="fin-accounts">
                {accounts
                  .filter((a) => !a.archived)
                  .map((a) => (
                    <li key={a.id}>
                      <span className="fin-accounts__name">
                        {a.name}
                        <small>{t(`finance.account_type.${a.type}`)}</small>
                      </span>
                      <span
                        className={`fin-accounts__balance${a.balance.startsWith('-') ? ' fin-minus' : ''}`}
                        dir="ltr"
                      >
                        {money(a.balance, a.currency, locale)}
                      </span>
                    </li>
                  ))}
              </ul>
            </section>
          </div>
        </>
      )}

      <TransactionDialog
        locale={locale}
        open={dialog.open}
        accounts={accounts}
        categories={categories}
        editing={dialog.editing}
        onClose={() => {
          setDialog({ open: false, editing: null });
        }}
        onSaved={() => {
          void load();
        }}
      />
      <ReceiptBatch
        locale={locale}
        open={batch}
        accounts={accounts}
        categories={categories}
        onClose={() => {
          setBatch(false);
        }}
        onSaved={() => {
          void load();
        }}
      />
    </div>
  );
}

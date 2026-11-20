'use client';

import { useCallback, useEffect, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { fetchMany, fetchOne } from '../../../lib/api-client';
import type { CollectionMeta } from '../../../lib/api-client';
import { categoryLabel } from '../../../lib/finance';
import type { Account, Category, Transaction, TransactionType } from '../../../lib/finance';
import { Button, Select } from '../../design-system';
import { ExpensesHeader, TransactionRow } from './finance-parts';
import { ReceiptBatch } from './receipt-batch';
import { TransactionDialog } from './transaction-dialog';

/** Every transaction, newest first, with filters; open one to edit or delete it. */
export function TransactionsScreen({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const [items, setItems] = useState<readonly Transaction[] | null>(null);
  const [meta, setMeta] = useState<CollectionMeta | null>(null);
  const [accounts, setAccounts] = useState<readonly Account[]>([]);
  const [categories, setCategories] = useState<readonly Category[]>([]);
  const [timeZone, setTimeZone] = useState('Africa/Cairo');
  const [failed, setFailed] = useState(false);
  const [type, setType] = useState<TransactionType | ''>('');
  const [accountId, setAccountId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [batch, setBatch] = useState(false);
  const [dialog, setDialog] = useState<{ open: boolean; editing: Transaction | null }>({
    open: false,
    editing: null,
  });

  const loadLists = useCallback(async (): Promise<void> => {
    const [accs, cats, settings] = await Promise.all([
      fetchOne<Account[]>('/personal/finance/accounts', { locale }),
      fetchOne<Category[]>('/personal/finance/categories', { locale }),
      fetchOne<{ time_zone: string }>('/personal/finance/settings', { locale }),
    ]);
    setAccounts(accs);
    setCategories(cats);
    setTimeZone(settings.time_zone);
  }, [locale]);

  const load = useCallback(async (): Promise<void> => {
    try {
      setFailed(false);
      const query: Record<string, string> = { page: String(page), per_page: '25' };
      if (type) query.type = type;
      if (accountId) query.account_id = accountId;
      if (categoryId) query.category_id = categoryId;
      if (from) query.from = from;
      if (to) query.to = to;
      if (q.trim()) query.q = q.trim();
      const result = await fetchMany<Transaction>('/personal/finance/transactions', { locale, query });
      setItems(result.items);
      setMeta(result.meta);
    } catch {
      setFailed(true);
    }
  }, [locale, page, type, accountId, categoryId, from, to, q]);

  useEffect(() => {
    void loadLists().catch(() => {
      setFailed(true);
    });
  }, [loadLists]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void load();
    }, 200);
    return () => {
      clearTimeout(timer);
    };
  }, [load]);

  const refresh = (): void => {
    void load();
    void loadLists();
  };

  const parents = categories.filter((c) => c.parent_id === null && !c.archived);
  const resetPage = (): void => {
    setPage(1);
  };

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

      <div className="fin-filters">
        <input
          className="input"
          type="search"
          value={q}
          placeholder={t('finance.field.search')}
          aria-label={t('finance.field.search')}
          onChange={(event) => {
            setQ(event.target.value);
            resetPage();
          }}
        />
        <Select
          aria-label={t('finance.field.all_types')}
          value={type}
          onChange={(event) => {
            setType(event.target.value as TransactionType | '');
            resetPage();
          }}
        >
          <option value="">{t('finance.field.all_types')}</option>
          <option value="expense">{t('finance.type.expense')}</option>
          <option value="income">{t('finance.type.income')}</option>
          <option value="transfer">{t('finance.type.transfer')}</option>
        </Select>
        <Select
          aria-label={t('finance.field.all_accounts')}
          value={accountId}
          onChange={(event) => {
            setAccountId(event.target.value);
            resetPage();
          }}
        >
          <option value="">{t('finance.field.all_accounts')}</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
        <Select
          aria-label={t('finance.field.all_categories')}
          value={categoryId}
          onChange={(event) => {
            setCategoryId(event.target.value);
            resetPage();
          }}
        >
          <option value="">{t('finance.field.all_categories')}</option>
          {parents.map((c) => (
            <option key={c.id} value={c.id}>
              {categoryLabel(c, t)}
            </option>
          ))}
        </Select>
        <label className="fin-filters__date">
          {t('finance.period.from')}
          <input
            type="date"
            className="input"
            value={from}
            onChange={(event) => {
              setFrom(event.target.value);
              resetPage();
            }}
          />
        </label>
        <label className="fin-filters__date">
          {t('finance.period.to')}
          <input
            type="date"
            className="input"
            value={to}
            onChange={(event) => {
              setTo(event.target.value);
              resetPage();
            }}
          />
        </label>
      </div>

      {failed ? (
        <div className="pempty" role="alert">
          <p>{t('finance.error.load')}</p>
          <Button variant="secondary" onClick={refresh}>
            {t('finance.retry')}
          </Button>
        </div>
      ) : items === null ? (
        <div className="fin-loading" aria-busy="true" />
      ) : items.length === 0 ? (
        <p className="fin-card fin-muted">{t('finance.no_transactions')}</p>
      ) : (
        <section className="fin-card">
          <div className="fin-rows">
            {items.map((tx) => (
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
          {meta && meta.total_pages > 1 ? (
            <div className="fin-pager">
              <Button
                variant="secondary"
                size="sm"
                disabled={page <= 1}
                onClick={() => {
                  setPage(page - 1);
                }}
              >
                {t('finance.prev')}
              </Button>
              <span>{t('finance.page', { page: String(meta.page), pages: String(meta.total_pages) })}</span>
              <Button
                variant="secondary"
                size="sm"
                disabled={page >= meta.total_pages}
                onClick={() => {
                  setPage(page + 1);
                }}
              >
                {t('finance.next')}
              </Button>
            </div>
          ) : null}
        </section>
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
        onSaved={refresh}
      />
      <ReceiptBatch
        locale={locale}
        open={batch}
        accounts={accounts}
        categories={categories}
        onClose={() => {
          setBatch(false);
        }}
        onSaved={refresh}
      />

    </div>
  );
}

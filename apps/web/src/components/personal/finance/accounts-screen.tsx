'use client';

import { useCallback, useEffect, useState } from 'react';
import { createTranslator, normaliseDigits } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { ApiError, fetchOne, sendNoContent } from '../../../lib/api-client';
import { ACCOUNT_TYPES, CURRENCIES, money } from '../../../lib/finance';
import type { Account, AccountType } from '../../../lib/finance';
import { Button, Field, Input, Modal, Select } from '../../design-system';
import { ExpensesHeader } from './finance-parts';

/** An opening balance or amount owed: zero or more, at most two decimals. */
function readOpening(input: string): string | null {
  const text = normaliseDigits(input.trim()).replace(/[٫,]/g, '.');
  if (text === '') return '0';
  return /^\d{1,13}(\.\d{1,2})?$/.test(text) ? text : null;
}

/** The person's wallets, bank accounts and cards, with live balances. */
export function AccountsScreen({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const [accounts, setAccounts] = useState<readonly Account[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<Account | 'new' | null>(null);
  const [name, setName] = useState('');
  const [type, setType] = useState<AccountType>('bank');
  const [currency, setCurrency] = useState('EGP');
  const [opening, setOpening] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      setFailed(false);
      setAccounts(await fetchOne<Account[]>('/personal/finance/accounts', { locale }));
    } catch {
      setFailed(true);
    }
  }, [locale]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = (account: Account | 'new'): void => {
    setErrors({});
    setEditing(account);
    if (account === 'new') {
      setName('');
      setType('bank');
      setCurrency(accounts?.[0]?.currency ?? 'EGP');
      setOpening('');
    } else {
      setName(account.name);
      setType(account.type);
      setCurrency(account.currency);
      const value = account.opening_balance;
      setOpening(account.type === 'credit_card' && value.startsWith('-') ? value.slice(1) : value);
    }
  };

  const save = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const amount = readOpening(opening);
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = t('finance.account.name');
    if (amount === null) next.opening = t('finance.error.amount');
    setErrors(next);
    if (Object.keys(next).length > 0 || amount === null) return;
    const body = {
      name: name.trim(),
      type,
      currency,
      ...(type === 'credit_card' ? { owed: amount } : { opening_balance: amount }),
    };
    setSaving(true);
    try {
      if (editing === 'new') {
        await fetchOne('/personal/finance/accounts', { locale, method: 'POST', body });
      } else if (editing) {
        await fetchOne(`/personal/finance/accounts/${editing.id}`, { locale, method: 'PATCH', body });
      }
      setEditing(null);
      setNotice(t('finance.saved'));
      await load();
    } catch (error) {
      if (error instanceof ApiError) {
        setErrors({
          ...(error.fields['name'] ? { name: t('finance.error.name') } : {}),
          ...(error.fields['currency'] ? { currency: t('finance.error.currency_locked') } : {}),
          ...(Object.keys(error.fields).length === 0 ? { form: t('finance.error.generic') } : {}),
        });
      } else setErrors({ form: t('finance.error.generic') });
    } finally {
      setSaving(false);
    }
  };

  const archive = async (account: Account): Promise<void> => {
    const result = await fetchOne<{ archived: boolean }>(`/personal/finance/accounts/${account.id}`, {
      locale,
      method: 'DELETE',
    });
    setNotice(result.archived ? t('finance.account.archived_note') : t('finance.account.removed'));
    await load();
  };

  const restore = async (account: Account): Promise<void> => {
    await sendNoContent(`/personal/finance/accounts/${account.id}/restore`, { locale, method: 'POST' });
    await load();
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
            + {t('finance.account.add')}
          </Button>
        }
      />
      {notice ? (
        <p className="fin-note" role="status">
          {notice}
        </p>
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
      ) : accounts === null ? (
        <div className="fin-loading" aria-busy="true" />
      ) : (
        <ul className="fin-account-cards">
          {accounts.map((a) => (
            <li key={a.id} className={`fin-account-card${a.archived ? ' is-archived' : ''}`}>
              <div className="fin-account-card__top">
                <span className={`fin-type-badge fin-type-badge--${a.type}`}>
                  {t(`finance.account_type.${a.type}`)}
                </span>
                {a.archived ? <span className="fin-archived">{t('finance.account.archived')}</span> : null}
              </div>
              <h2>{a.name}</h2>
              <strong className={a.balance.startsWith('-') ? 'fin-minus' : ''} dir="ltr">
                {money(a.balance, a.currency, locale)}
              </strong>
              <small>{t('finance.account.count', { count: String(a.transaction_count) })}</small>
              <div className="fin-account-card__actions">
                {a.archived ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      void restore(a);
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
                        open(a);
                      }}
                    >
                      {t('finance.account.edit')}
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive-ghost"
                      onClick={() => {
                        void archive(a);
                      }}
                    >
                      {a.transaction_count > 0 ? t('finance.account.archive') : t('finance.account.delete')}
                    </Button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={editing !== null}
        title={editing === 'new' ? t('finance.account.add') : t('finance.account.edit')}
        closeLabel={t('finance.close')}
        onClose={() => {
          setEditing(null);
        }}
      >
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
          <Field label={t('finance.account.name')} required {...(errors.name ? { error: errors.name } : {})}>
            <Input
              value={name}
              maxLength={80}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          </Field>
          <Field label={t('finance.account.type')} required>
            <Select
              value={type}
              onChange={(event) => {
                setType(event.target.value as AccountType);
              }}
            >
              {ACCOUNT_TYPES.map((value) => (
                <option key={value} value={value}>
                  {t(`finance.account_type.${value}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label={t('finance.account.currency')}
            required
            {...(errors.currency ? { error: errors.currency } : {})}
          >
            <Select
              value={currency}
              onChange={(event) => {
                setCurrency(event.target.value);
              }}
            >
              {CURRENCIES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label={type === 'credit_card' ? t('finance.account.owed') : t('finance.account.opening')}
            {...(errors.opening ? { error: errors.opening } : {})}
          >
            <Input
              inputMode="decimal"
              dir="ltr"
              value={opening}
              placeholder="0.00"
              onChange={(event) => {
                setOpening(event.target.value);
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
      </Modal>
    </div>
  );
}

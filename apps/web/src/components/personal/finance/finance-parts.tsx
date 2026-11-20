'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createTranslator, formatDateTime } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { categoryLabel, money } from '../../../lib/finance';
import type { Transaction } from '../../../lib/finance';
import { personalHref } from '../../../lib/personal';
import { PersonalIcon } from '../personal-shell';

/** The four Expenses screens, as tabs under the section heading. */
export function ExpensesHeader({
  locale,
  action,
}: {
  readonly locale: Locale;
  readonly action?: React.ReactNode;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const pathname = usePathname();
  const base = personalHref(locale, 'expenses');
  const tabs = [
    { href: base, label: t('finance.tabs.overview') },
    { href: `${base}/transactions`, label: t('finance.tabs.transactions') },
    { href: `${base}/accounts`, label: t('finance.tabs.accounts') },
    { href: `${base}/categories`, label: t('finance.tabs.categories') },
  ];
  return (
    <div className="fin-head">
      <header className="pscreen-head">
        <PersonalIcon entry="expenses" size={64} />
        <div>
          <h1>{t('personal.nav.expenses')}</h1>
          <p>{t('personal.about.expenses')}</p>
        </div>
        {action ? <div className="fin-head__action">{action}</div> : null}
      </header>
      <nav className="fin-tabs" aria-label={t('personal.nav.expenses')}>
        {tabs.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            className="fin-tab"
            aria-current={pathname === tab.href ? 'page' : undefined}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}

/** One transaction as a row: what it was, where, when, and the signed amount. */
export function TransactionRow({
  locale,
  timeZone,
  transaction,
  onOpen,
}: {
  readonly locale: Locale;
  readonly timeZone: string;
  readonly transaction: Transaction;
  readonly onOpen?: ((transaction: Transaction) => void) | undefined;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const tx = transaction;
  const title =
    tx.type === 'transfer'
      ? t('finance.transfer_label', { from: tx.account_name, to: tx.to_account_name ?? '' })
      : categoryLabel({ key: tx.category_key, name: tx.category_name }, t);
  const sign = tx.type === 'income' ? '+' : tx.type === 'expense' ? '−' : '';
  const content = (
    <>
      <span className={`fin-row__dot fin-row__dot--${tx.type}`} aria-hidden="true" />
      <span className="fin-row__main">
        <span className="fin-row__title">{title}</span>
        <span className="fin-row__meta">
          {[tx.merchant, tx.type === 'transfer' ? null : tx.account_name, formatDateTime(new Date(tx.occurred_at), { locale, timeZone })]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </span>
      <span className={`fin-row__amount fin-row__amount--${tx.type}`} dir="ltr">
        {sign}
        {money(tx.amount, tx.currency, locale)}
      </span>
    </>
  );
  return onOpen ? (
    <button
      type="button"
      className="fin-row"
      onClick={() => {
        onOpen(tx);
      }}
    >
      {content}
    </button>
  ) : (
    <div className="fin-row">{content}</div>
  );
}

/** A simple ring of the spending shares (drawn, no chart library). */
export function SpendingRing({
  parts,
}: {
  readonly parts: readonly { readonly value: number; readonly color: string }[];
}): React.JSX.Element {
  const radius = 15.9155;
  let offset = 25;
  return (
    <svg className="fin-ring" viewBox="0 0 42 42" aria-hidden="true">
      <circle cx="21" cy="21" r={radius} fill="none" stroke="var(--fin-track)" strokeWidth="6" />
      {parts.map((part, index) => {
        const circle = (
          <circle
            key={index}
            cx="21"
            cy="21"
            r={radius}
            fill="none"
            stroke={part.color}
            strokeWidth="6"
            strokeDasharray={`${String(part.value)} ${String(100 - part.value)}`}
            strokeDashoffset={offset}
          />
        );
        offset -= part.value;
        return circle;
      })}
    </svg>
  );
}

export const RING_COLORS = [
  '#1e7aff',
  '#0b1e4b',
  '#5aa2ff',
  '#7c8cff',
  '#22b07d',
  '#ffb020',
  '#ff6b6b',
  '#9aa5b8',
];

import { formatMoney, normaliseDigits } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

/** 1to1OS Personal — Expenses: the shapes the API returns, and display helpers. */

export type AccountType = 'cash' | 'bank' | 'debit_card' | 'credit_card' | 'ewallet' | 'savings';
export type TransactionType = 'expense' | 'income' | 'transfer';
export type Period = 'today' | 'week' | 'month' | 'year' | 'custom';

export const ACCOUNT_TYPES: readonly AccountType[] = [
  'cash',
  'bank',
  'debit_card',
  'credit_card',
  'ewallet',
  'savings',
];
export const PERIODS: readonly Period[] = ['today', 'week', 'month', 'year', 'custom'];
export const CURRENCIES = ['EGP', 'USD', 'EUR', 'SAR', 'AED', 'GBP', 'KWD'] as const;

export interface Account {
  readonly id: string;
  readonly name: string;
  readonly type: AccountType;
  readonly currency: string;
  readonly opening_balance: string;
  readonly balance: string;
  readonly archived: boolean;
  readonly transaction_count: number;
}

export interface Category {
  readonly id: string;
  readonly kind: 'expense' | 'income';
  readonly key: string | null;
  readonly name: string | null;
  readonly parent_id: string | null;
  readonly position: number;
  readonly archived: boolean;
}

export interface Transaction {
  readonly id: string;
  readonly type: TransactionType;
  readonly amount: string;
  readonly currency: string;
  readonly account_id: string;
  readonly account_name: string;
  readonly to_account_id: string | null;
  readonly to_account_name: string | null;
  readonly category_id: string | null;
  readonly category_key: string | null;
  readonly category_name: string | null;
  readonly occurred_at: string;
  readonly merchant: string | null;
  readonly notes: string | null;
  readonly receipt_count: number;
  readonly receipts?: readonly {
    readonly id: string;
    readonly original_name: string;
    readonly mime_type: string;
    readonly size_bytes: number;
  }[];
}

export interface Summary {
  readonly currency: string;
  readonly period: { readonly from: string; readonly to: string };
  readonly available: readonly { readonly currency: string; readonly amount: string }[];
  readonly credit_owed: readonly { readonly currency: string; readonly amount: string }[];
  readonly income: string;
  readonly expense: string;
  readonly net: string;
  readonly by_category: readonly {
    readonly category_id: string | null;
    readonly key: string | null;
    readonly name: string | null;
    readonly amount: string;
  }[];
  readonly accounts: readonly Account[];
  readonly recent: readonly Transaction[];
  readonly other_currencies: boolean;
}

/** A user-named category shows its name; a default one its translated label. */
export function categoryLabel(
  category: { readonly key: string | null; readonly name: string | null },
  t: (key: string) => string,
): string {
  if (category.name) return category.name;
  if (category.key) return t(`finance.cat.${category.key}`);
  return t('finance.uncategorized');
}

/** Amounts are carried as strings; decimals shown only when they are not zero. */
export function money(amount: string, currency: string, locale: Locale): string {
  const negative = amount.startsWith('-');
  const unsigned = negative ? amount.slice(1) : amount;
  const showDecimals = !/\.0+$/.test(unsigned) && unsigned.includes('.');
  const text = formatMoney(unsigned, currency, { locale, showDecimals });
  return negative ? `−${text}` : text;
}

/**
 * Reads what a person typed as an amount — Arabic-Indic digits and a comma
 * decimal mark included — into the API's form ("1234.5"), or null.
 */
export function readAmount(input: string): string | null {
  const text = normaliseDigits(input.trim()).replace(/[\s,،](?=\d{3}\b)/g, '').replace(/[٫,]/g, '.');
  if (!/^\d{1,13}(\.\d{1,2})?$/.test(text)) return null;
  if (/^0+(\.0+)?$/.test(text)) return null;
  return text;
}

/** `datetime-local` value for now, in the browser's own clock. */
export function nowLocalInput(date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The share of `part` in `total` as a whole percent (0–100), from decimal strings. */
export function share(part: string, total: string): number {
  const p = Number(part);
  const t = Number(total);
  if (!(t > 0)) return 0;
  return Math.min(100, Math.max(0, (p * 100) / t));
}

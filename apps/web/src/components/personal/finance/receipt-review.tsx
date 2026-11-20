'use client';

import { useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { categoryLabel, money } from '../../../lib/finance';
import type { Category } from '../../../lib/finance';
import type { ReceiptReading } from '../../../lib/receipt-reader';
import { Button } from '../../design-system';

export interface ReviewedValues {
  readonly amount?: string;
  readonly date?: string;
  readonly time?: string | null;
  readonly merchant?: string;
  readonly categoryId?: string;
  readonly taxNote?: string;
}

/**
 * What the receipt reader found, field by field, each with a tick. Nothing is
 * applied until the person presses "Use selected"; a guessed total starts
 * unticked and says so.
 */
export function ReceiptReview({
  locale,
  reading,
  category,
  categorySource,
  accountCurrency,
  onApply,
  onDismiss,
}: {
  readonly locale: Locale;
  readonly reading: ReceiptReading;
  readonly category: Category | null;
  readonly categorySource: 'history' | 'receipt' | null;
  readonly accountCurrency: string | null;
  readonly onApply: (values: ReviewedValues) => void;
  readonly onDismiss: () => void;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const currency = reading.currency ?? accountCurrency ?? 'EGP';
  const rows = [
    reading.total
      ? {
          key: 'amount',
          label: t('finance.field.amount'),
          value: money(reading.total, currency, locale),
          hint: reading.totalConfidence === 'guess' ? t('finance.receipt.total_guess') : null,
          initial: reading.totalConfidence === 'labelled',
        }
      : null,
    reading.date
      ? {
          key: 'date',
          label: t('finance.field.date'),
          value: `${reading.date}${reading.time ? ` ${reading.time}` : ''}`,
          hint: null,
          initial: true,
        }
      : null,
    reading.merchant
      ? { key: 'merchant', label: t('finance.field.merchant'), value: reading.merchant, hint: null, initial: true }
      : null,
    category
      ? {
          key: 'category',
          label: t('finance.field.category'),
          value: categoryLabel(category, t),
          hint: categorySource === 'history' ? t('finance.receipt.from_history') : t('finance.receipt.from_receipt'),
          initial: true,
        }
      : null,
    reading.tax
      ? {
          key: 'tax',
          label: t('finance.receipt.tax'),
          value: money(reading.tax, currency, locale),
          hint: t('finance.receipt.tax_to_notes'),
          initial: true,
        }
      : null,
  ].filter((row): row is NonNullable<typeof row> => row !== null);
  const [picked, setPicked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(rows.map((r) => [r.key, r.initial])),
  );

  if (rows.length === 0) {
    return (
      <div className="receipt-review" role="status">
        <p className="fin-muted">{t('finance.receipt.nothing_found')}</p>
        <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
          {t('finance.close')}
        </Button>
      </div>
    );
  }

  const mismatch = reading.currency !== null && accountCurrency !== null && reading.currency !== accountCurrency;

  return (
    <div className="receipt-review" role="group" aria-label={t('finance.receipt.review')}>
      <h3>{t('finance.receipt.review')}</h3>
      <p className="fin-muted">{t('finance.receipt.review_help')}</p>
      <ul>
        {rows.map((row) => (
          <li key={row.key}>
            <label>
              <input
                type="checkbox"
                checked={picked[row.key] ?? false}
                onChange={(event) => {
                  setPicked({ ...picked, [row.key]: event.target.checked });
                }}
              />
              <span className="receipt-review__label">{row.label}</span>
              <bdi className="receipt-review__value">{row.value}</bdi>
            </label>
            {row.hint ? <small>{row.hint}</small> : null}
          </li>
        ))}
      </ul>
      {mismatch ? (
        <p className="fin-note">{t('finance.receipt.currency_mismatch', { currency: reading.currency ?? '' })}</p>
      ) : null}
      <div className="receipt-review__actions">
        <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
          {t('finance.cancel')}
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => {
            onApply({
              ...(picked.amount && reading.total ? { amount: reading.total } : {}),
              ...(picked.date && reading.date ? { date: reading.date, time: reading.time } : {}),
              ...(picked.merchant && reading.merchant ? { merchant: reading.merchant } : {}),
              ...(picked.category && category ? { categoryId: category.id } : {}),
              ...(picked.tax && reading.tax
                ? { taxNote: `${t('finance.receipt.tax')}: ${money(reading.tax, currency, locale)}` }
                : {}),
            });
          }}
        >
          {t('finance.receipt.apply')}
        </Button>
      </div>
    </div>
  );
}

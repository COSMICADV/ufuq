'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { fetchOne } from '../../../lib/api-client';
import { categoryLabel, readAmount } from '../../../lib/finance';
import type { Account, Category, Transaction } from '../../../lib/finance';
import { releasePage, toPage, uploadReceipt } from '../../../lib/receipts';
import type { Page } from '../../../lib/receipts';
import { CaptureButtons } from '../../capture/capture-buttons';
import { PhotoEditor } from '../../capture/photo-editor';
import { Button, Modal, Select } from '../../design-system';
import { receiptWhen, scanPage } from './receipt-scan';

const MAX_BATCH = 20;

type Status = 'queued' | 'reading' | 'ready' | 'unread' | 'saving' | 'saved' | 'failed';

interface Item {
  readonly page: Page;
  readonly status: Status;
  readonly progress: number;
  readonly amount: string;
  readonly date: string;
  readonly time: string | null;
  readonly merchant: string;
  readonly categoryId: string;
  readonly notes: string;
  readonly include: boolean;
  readonly guessed: boolean;
  readonly suggested: 'history' | 'receipt' | null;
}

function today(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function blank(page: Page): Item {
  return {
    page,
    status: page.pdf ? 'unread' : 'queued',
    progress: 0,
    amount: '',
    date: today(),
    time: null,
    merchant: '',
    categoryId: '',
    notes: '',
    include: true,
    guessed: false,
    suggested: null,
  };
}

/**
 * Scan many receipts at once: each photo is read on this device, becomes a
 * draft expense with a suggested category, and is saved — with its photo
 * attached — only after the person has reviewed it and pressed Save.
 */
export function ReceiptBatch({
  locale,
  open,
  accounts,
  categories,
  onClose,
  onSaved,
}: {
  readonly locale: Locale;
  readonly open: boolean;
  readonly accounts: readonly Account[];
  readonly categories: readonly Category[];
  readonly onClose: () => void;
  readonly onSaved: () => void;
}): React.JSX.Element | null {
  const t = createTranslator(locale);
  const usable = accounts.filter((a) => !a.archived);
  const [accountId, setAccountId] = useState('');
  const [items, setItems] = useState<readonly Item[]>([]);
  const [editor, setEditor] = useState<{ file: File; key: string | null; camera: boolean } | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const savedAny = useRef(false);

  useEffect(() => {
    if (!open) return;
    setAccountId((current) => current || (accounts.find((a) => !a.archived)?.id ?? ''));
  }, [open, accounts]);

  const options = useMemo(() => {
    const own = categories.filter((c) => c.kind === 'expense' && !c.archived);
    return own
      .filter((c) => c.parent_id === null)
      .flatMap((parent) => [
        { id: parent.id, label: categoryLabel(parent, t) },
        ...own.filter((c) => c.parent_id === parent.id).map((c) => ({ id: c.id, label: `— ${categoryLabel(c, t)}` })),
      ]);
  }, [categories, t]);

  const patch = (key: string, change: Partial<Item>): void => {
    setItems((old) => old.map((item) => (item.page.key === key ? { ...item, ...change } : item)));
  };

  // Read one queued photo at a time (OCR is heavy on a phone).
  useEffect(() => {
    if (busy.current) return;
    const next = items.find((i) => i.status === 'queued');
    if (!next) return;
    busy.current = true;
    const key = next.page.key;
    patch(key, { status: 'reading', progress: 0 });
    void scanPage(locale, next.page, categories, (fraction) => {
      patch(key, { progress: fraction });
    })
      .then(({ reading, category, categorySource }) => {
        patch(key, {
          status: reading.total ? 'ready' : 'unread',
          amount: reading.total ?? '',
          date: reading.date ?? today(),
          time: reading.time,
          merchant: reading.merchant ?? '',
          categoryId: category?.id ?? '',
          suggested: categorySource,
          guessed: reading.totalConfidence === 'guess',
          notes: reading.tax ? `${t('finance.receipt.tax')}: ${reading.tax}` : '',
        });
      })
      .catch(() => {
        patch(key, { status: 'unread' });
      })
      .finally(() => {
        busy.current = false;
        setItems((old) => [...old]);
      });
  }, [items, locale, categories, t]);

  const add = async (files: readonly File[]): Promise<void> => {
    setError('');
    const room = MAX_BATCH - items.length;
    const pages: Page[] = [];
    for (const file of files.slice(0, Math.max(0, room))) {
      try {
        pages.push(await toPage(file));
      } catch (failure) {
        setError(failure instanceof Error && failure.message === 'too_large' ? t('capture.error_size') : t('capture.error_type'));
      }
    }
    if (files.length > room) setError(t('finance.batch.limit', { max: String(MAX_BATCH) }));
    setItems((old) => [...old, ...pages.map(blank)]);
  };

  const close = (): void => {
    if (saving) return;
    items.forEach((i) => {
      releasePage(i.page);
    });
    setItems([]);
    setEditor(null);
    setError('');
    if (savedAny.current) onSaved();
    savedAny.current = false;
    onClose();
  };

  const pending = items.filter((i) => i.include && i.status !== 'saved');
  const invalid = pending.filter((i) => readAmount(i.amount) === null || !i.date);
  const reading = items.some((i) => i.status === 'queued' || i.status === 'reading');

  const saveAll = async (): Promise<void> => {
    if (!accountId || invalid.length > 0 || pending.length === 0) return;
    setSaving(true);
    setError('');
    let failures = 0;
    for (const item of pending) {
      const key = item.page.key;
      patch(key, { status: 'saving' });
      try {
        const saved = await fetchOne<Transaction>('/personal/finance/transactions', {
          locale,
          method: 'POST',
          body: {
            type: 'expense',
            amount: readAmount(item.amount),
            account_id: accountId,
            occurred_at: new Date(receiptWhen(item.date, item.time)).toISOString(),
            merchant: item.merchant,
            notes: item.notes,
            ...(item.categoryId ? { category_id: item.categoryId } : {}),
          },
        });
        savedAny.current = true;
        try {
          await uploadReceipt(locale, saved.id, item.page);
        } catch {
          failures += 1;
        }
        patch(key, { status: 'saved' });
      } catch {
        failures += 1;
        patch(key, { status: 'failed' });
      }
    }
    setSaving(false);
    if (failures > 0) setError(t('finance.batch.some_failed'));
  };

  if (editor) {
    return (
      <Modal
        open={open}
        title={t('capture.edit_title')}
        closeLabel={t('finance.close')}
        onClose={() => {
          setEditor(null);
        }}
      >
        <PhotoEditor
          locale={locale}
          file={editor.file}
          onCancel={() => {
            setEditor(null);
          }}
          {...(editor.camera
            ? {
                onRetake: () => {
                  setEditor(null);
                  setTimeout(() => {
                    document.querySelector<HTMLInputElement>('.receipt-batch input[capture]')?.click();
                  }, 60);
                },
              }
            : {})}
          onUse={(result) => {
            void toPage(editor.file, result).then((page) => {
              if (editor.key === null) {
                setItems((old) => [...old, blank(page)]);
              } else {
                const key = editor.key;
                setItems((old) =>
                  old.map((i) => {
                    if (i.page.key !== key) return i;
                    releasePage(i.page);
                    return { ...blank(page), include: i.include };
                  }),
                );
              }
              setEditor(null);
            });
          }}
        />
      </Modal>
    );
  }

  const done = items.length > 0 && items.every((i) => i.status === 'saved' || !i.include);

  return (
    <Modal open={open} title={t('finance.batch.title')} closeLabel={t('finance.close')} onClose={close}>
      <div className="receipt-batch">
        <p className="fin-muted">{t('finance.batch.help')}</p>
        <label className="receipt-batch__account">
          <span>{t('finance.batch.paid_from')}</span>
          <Select
            value={accountId}
            onChange={(event) => {
              setAccountId(event.target.value);
            }}
          >
            {usable.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · {a.currency}
              </option>
            ))}
          </Select>
        </label>
        {items.length < MAX_BATCH && !saving ? (
          <CaptureButtons
            locale={locale}
            onCamera={(file) => {
              setEditor({ file, key: null, camera: true });
            }}
            onFiles={(files) => {
              void add(files);
            }}
          />
        ) : null}
        {error ? (
          <p className="fin-form__error" role="alert">
            {error}
          </p>
        ) : null}

        <ul className="receipt-batch__list">
          {items.map((item, index) => {
            const key = item.page.key;
            const locked = item.status === 'saving' || item.status === 'saved';
            return (
              <li key={key} className={`receipt-card is-${item.status}`}>
                <button
                  type="button"
                  className="receipt-card__thumb"
                  disabled={locked || item.page.pdf}
                  onClick={() => {
                    setEditor({ file: item.page.original, key, camera: false });
                  }}
                  aria-label={t('capture.edit')}
                >
                  {item.page.url ? <img src={item.page.url} alt="" /> : <span>PDF</span>}
                </button>
                <div className="receipt-card__body">
                  <div className="receipt-card__top">
                    <label className="receipt-card__include">
                      <input
                        type="checkbox"
                        checked={item.include}
                        disabled={locked}
                        onChange={(event) => {
                          patch(key, { include: event.target.checked });
                        }}
                      />
                      {t('finance.batch.receipt_n', { n: String(index + 1) })}
                    </label>
                    <span className={`receipt-card__status receipt-card__status--${item.status}`}>
                      {t(`finance.batch.status.${item.status}`)}
                    </span>
                  </div>
                  {item.status === 'reading' || item.status === 'queued' ? (
                    <span className="fin-bar" aria-hidden="true">
                      <span style={{ inlineSize: `${String(item.progress * 100)}%` }} />
                    </span>
                  ) : (
                    <div className="receipt-card__fields">
                      <label>
                        <span>{t('finance.field.amount')}</span>
                        <input
                          className="input"
                          inputMode="decimal"
                          dir="ltr"
                          value={item.amount}
                          disabled={locked}
                          aria-invalid={item.include && readAmount(item.amount) === null ? true : undefined}
                          onChange={(event) => {
                            patch(key, { amount: event.target.value, guessed: false });
                          }}
                        />
                      </label>
                      <label>
                        <span>{t('finance.batch.date')}</span>
                        <input
                          className="input"
                          type="date"
                          value={item.date}
                          disabled={locked}
                          onChange={(event) => {
                            patch(key, { date: event.target.value });
                          }}
                        />
                      </label>
                      <label className="receipt-card__wide">
                        <span>{t('finance.field.merchant')}</span>
                        <input
                          className="input"
                          value={item.merchant}
                          maxLength={160}
                          disabled={locked}
                          onChange={(event) => {
                            patch(key, { merchant: event.target.value });
                          }}
                        />
                      </label>
                      <label className="receipt-card__wide">
                        <span>
                          {t('finance.field.category')}
                          {item.suggested ? (
                            <small>
                              {' · '}
                              {item.suggested === 'history'
                                ? t('finance.receipt.from_history')
                                : t('finance.receipt.from_receipt')}
                            </small>
                          ) : null}
                        </span>
                        <select
                          className="input"
                          value={item.categoryId}
                          disabled={locked}
                          onChange={(event) => {
                            patch(key, { categoryId: event.target.value, suggested: null });
                          }}
                        >
                          <option value="">{t('finance.field.no_category')}</option>
                          {options.map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      {item.guessed ? <p className="fin-note receipt-card__wide">{t('finance.receipt.total_guess')}</p> : null}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>

        <div className="fin-form__actions">
          <Button type="button" variant="secondary" onClick={close} disabled={saving}>
            {done ? t('finance.close') : t('finance.cancel')}
          </Button>
          {done ? null : (
            <Button
              type="button"
              loading={saving}
              disabled={reading || pending.length === 0 || invalid.length > 0 || !accountId}
              onClick={() => {
                void saveAll();
              }}
            >
              {t('finance.batch.save', { count: String(pending.length) })}
            </Button>
          )}
        </div>
        {invalid.length > 0 && !reading ? <p className="fin-muted">{t('finance.batch.fix_amounts')}</p> : null}
      </div>
    </Modal>
  );
}

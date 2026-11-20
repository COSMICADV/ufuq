'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { ApiError, fetchOne, sendNoContent } from '../../../lib/api-client';
import { categoryLabel, nowLocalInput, readAmount } from '../../../lib/finance';
import type { Account, Category, Transaction, TransactionType } from '../../../lib/finance';
import { MAX_RECEIPTS, releasePage, toPage, uploadReceipt } from '../../../lib/receipts';
import type { Page, Receipt } from '../../../lib/receipts';
import { CaptureButtons } from '../../capture/capture-buttons';
import { PhotoEditor } from '../../capture/photo-editor';
import { PendingReceipt, StoredReceipt } from '../../capture/receipt-thumbs';
import { Button, Field, Input, Modal, Select, Textarea } from '../../design-system';
import { ReceiptReview } from './receipt-review';
import type { ReviewedValues } from './receipt-review';
import { receiptWhen, scanPage } from './receipt-scan';
import type { ScanResult } from './receipt-scan';

const TYPES: readonly TransactionType[] = ['expense', 'income', 'transfer'];

function localInput(iso: string): string {
  return nowLocalInput(new Date(iso));
}

/**
 * Add or edit one transaction: an expense, income, or a transfer between two
 * of the person's own accounts. The type is chosen once; an existing
 * transaction keeps its type. The server checks everything again.
 */
export function TransactionDialog({
  locale,
  open,
  accounts,
  categories,
  editing,
  initialType = 'expense',
  onClose,
  onSaved,
}: {
  readonly locale: Locale;
  readonly open: boolean;
  readonly accounts: readonly Account[];
  readonly categories: readonly Category[];
  readonly editing?: Transaction | null | undefined;
  readonly initialType?: TransactionType | undefined;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}): React.JSX.Element | null {
  const t = createTranslator(locale);
  const usable = accounts.filter((a) => !a.archived || a.id === editing?.account_id || a.id === editing?.to_account_id);
  const [type, setType] = useState<TransactionType>(initialType);
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  const [toAccountId, setToAccountId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [when, setWhen] = useState(nowLocalInput());
  const [merchant, setMerchant] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pages, setPages] = useState<readonly Page[]>([]);
  const [stored, setStored] = useState<readonly Receipt[]>([]);
  const [editor, setEditor] = useState<{ file: File; replace: string | null; camera: boolean } | null>(null);
  const [scan, setScan] = useState<ScanResult | 'reading' | null>(null);
  const [scanProgress, setScanProgress] = useState(0);
  const [receiptError, setReceiptError] = useState('');
  const savedId = useRef<string | null>(null);
  const retake = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setFormError('');
    setConfirmDelete(false);
    setPages((old) => {
      old.forEach(releasePage);
      return [];
    });
    setStored([]);
    setEditor(null);
    setScan(null);
    setReceiptError('');
    savedId.current = null;
    if (editing && editing.type !== 'transfer') {
      void fetchOne<Transaction>(`/personal/finance/transactions/${editing.id}`, { locale })
        .then((full) => {
          setStored(full.receipts ?? []);
        })
        .catch(() => undefined);
    }
    if (editing) {
      setType(editing.type);
      setAmount(editing.amount);
      setAccountId(editing.account_id);
      setToAccountId(editing.to_account_id ?? '');
      setCategoryId(editing.category_id ?? '');
      setWhen(localInput(editing.occurred_at));
      setMerchant(editing.merchant ?? '');
      setNotes(editing.notes ?? '');
    } else {
      setType(initialType);
      setAmount('');
      setAccountId(accounts.find((a) => !a.archived)?.id ?? '');
      setToAccountId('');
      setCategoryId('');
      setWhen(nowLocalInput());
      setMerchant('');
      setNotes('');
    }
  }, [open, editing, initialType]);

  const kindCategories = useMemo(() => {
    if (type === 'transfer') return [];
    const own = categories.filter((c) => c.kind === type && (!c.archived || c.id === editing?.category_id));
    const parents = own.filter((c) => c.parent_id === null);
    return parents.flatMap((parent) => [
      { id: parent.id, label: categoryLabel(parent, t), sub: false },
      ...own
        .filter((c) => c.parent_id === parent.id)
        .map((c) => ({ id: c.id, label: categoryLabel(c, t), sub: true })),
    ]);
  }, [categories, type, editing, t]);

  const account = usable.find((a) => a.id === accountId);
  const destinations = usable.filter((a) => a.id !== accountId && a.currency === account?.currency);

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const value = readAmount(amount);
    const next: Record<string, string> = {};
    if (value === null) next.amount = t('finance.error.amount');
    if (!accountId) next.account_id = t('finance.error.account');
    if (type === 'transfer' && !toAccountId) next.to_account_id = t('finance.error.to_account');
    setErrors(next);
    setFormError('');
    if (Object.keys(next).length > 0 || value === null) return;
    const body = {
      amount: value,
      account_id: accountId,
      occurred_at: new Date(when).toISOString(),
      merchant,
      notes,
      ...(type === 'transfer' ? { to_account_id: toAccountId } : {}),
      ...(type !== 'transfer' && categoryId ? { category_id: categoryId } : {}),
      ...(type !== 'transfer' && !categoryId && editing ? { category_id: null } : {}),
    };
    setSaving(true);
    try {
      const id = editing?.id ?? savedId.current;
      const saved = id
        ? await fetchOne<Transaction>(`/personal/finance/transactions/${id}`, { locale, method: 'PATCH', body })
        : await fetchOne<Transaction>('/personal/finance/transactions', {
            locale,
            method: 'POST',
            body: { type, ...body },
          });
      savedId.current = saved.id;
      // Receipts go up one by one after the transaction exists; a page that
      // fails stays here so pressing Save again retries only what is left.
      let left = pages;
      if (type !== 'transfer') {
        for (const page of pages) {
          try {
            await uploadReceipt(locale, saved.id, page);
            releasePage(page);
            left = left.filter((p) => p.key !== page.key);
          } catch {
            // kept for retry
          }
        }
      }
      setPages(left);
      if (left.length > 0) {
        setReceiptError(t('finance.receipt.upload_failed'));
        onSaved();
        return;
      }
      onSaved();
      onClose();
    } catch (error) {
      if (error instanceof ApiError && Object.keys(error.fields).length > 0) {
        const fields = error.fields;
        setErrors({
          ...(fields['amount'] ? { amount: t('finance.error.amount') } : {}),
          ...(fields['account_id'] ? { account_id: t('finance.error.account') } : {}),
          ...(fields['to_account_id'] ? { to_account_id: t('finance.error.to_account') } : {}),
          ...(fields['category_id'] ? { category_id: t('finance.error.category') } : {}),
        });
      } else setFormError(t('finance.error.generic'));
    } finally {
      setSaving(false);
    }
  };

  const room = MAX_RECEIPTS - stored.length - pages.length;

  const addFiles = async (files: readonly File[]): Promise<void> => {
    setReceiptError('');
    const added: Page[] = [];
    for (const file of files.slice(0, Math.max(0, room))) {
      try {
        added.push(await toPage(file));
      } catch (error) {
        setReceiptError(
          error instanceof Error && error.message === 'too_large'
            ? t('capture.error_size')
            : t('capture.error_type'),
        );
      }
    }
    if (files.length > room) setReceiptError(t('finance.receipt.limit', { max: String(MAX_RECEIPTS) }));
    setPages((old) => [...old, ...added]);
  };

  const useEdited = async (file: File, result: { blob: Blob; canvas: HTMLCanvasElement }, replace: string | null): Promise<void> => {
    const page = await toPage(file, result);
    setPages((old) => {
      if (replace === null) return [...old, page];
      return old.map((p) => {
        if (p.key !== replace) return p;
        releasePage(p);
        return page;
      });
    });
    setEditor(null);
  };

  const read = async (): Promise<void> => {
    const page = pages.find((p) => !p.pdf);
    if (!page) return;
    setScan('reading');
    setScanProgress(0);
    try {
      setScan(await scanPage(locale, page, categories, setScanProgress));
    } catch {
      setScan(null);
      setReceiptError(t('finance.receipt.read_failed'));
    }
  };

  const apply = (values: ReviewedValues): void => {
    if (values.amount) setAmount(values.amount);
    if (values.date) setWhen(receiptWhen(values.date, values.time));
    if (values.merchant) setMerchant(values.merchant);
    if (values.categoryId) setCategoryId(values.categoryId);
    if (values.taxNote) setNotes((n) => (n ? `${n}\n${values.taxNote ?? ''}` : (values.taxNote ?? '')));
    setScan(null);
  };

  const removeStored = async (receipt: Receipt): Promise<void> => {
    try {
      await sendNoContent(`/attachments/${receipt.id}`, { locale, method: 'DELETE' });
      setStored((old) => old.filter((r) => r.id !== receipt.id));
      onSaved();
    } catch {
      setReceiptError(t('finance.error.generic'));
    }
  };

  if (editor) {
    return (
      <Modal
        open={open}
        title={t('capture.edit_title')}
        onClose={() => {
          setEditor(null);
        }}
        closeLabel={t('finance.close')}
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
                    retake.current?.();
                  }, 60);
                },
              }
            : {})}
          onUse={(result) => {
            void useEdited(editor.file, result, editor.replace);
          }}
        />
      </Modal>
    );
  }

  const remove = async (): Promise<void> => {
    if (!editing) return;
    setSaving(true);
    try {
      await sendNoContent(`/personal/finance/transactions/${editing.id}`, { locale, method: 'DELETE' });
      onSaved();
      onClose();
    } catch {
      setFormError(t('finance.error.generic'));
      setConfirmDelete(false);
    } finally {
      setSaving(false);
    }
  };

  if (confirmDelete) {
    return (
      <Modal
        open={open}
        title={t('finance.delete')}
        onClose={() => {
          setConfirmDelete(false);
        }}
        closeLabel={t('finance.close')}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setConfirmDelete(false);
              }}
            >
              {t('finance.cancel')}
            </Button>
            <Button
              variant="destructive"
              loading={saving}
              onClick={() => {
                void remove();
              }}
            >
              {t('finance.delete')}
            </Button>
          </>
        }
      >
        <p>{t('finance.confirm_delete')}</p>
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      title={editing ? t('finance.edit') : t('finance.add')}
      onClose={onClose}
      closeLabel={t('finance.close')}
    >
      <form
        className="fin-form"
        noValidate
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        {formError ? (
          <p className="fin-form__error" role="alert">
            {formError}
          </p>
        ) : null}
        {editing ? null : (
          <div className="fin-types" role="radiogroup" aria-label={t('finance.add')}>
            {TYPES.map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={type === value}
                className={`fin-type fin-type--${value}`}
                onClick={() => {
                  setType(value);
                  setCategoryId('');
                }}
              >
                {t(`finance.type.${value}`)}
              </button>
            ))}
          </div>
        )}
        <Field label={t('finance.field.amount')} required {...(errors.amount ? { error: errors.amount } : {})}>
          <Input
            className="fin-amount"
            inputMode="decimal"
            autoComplete="off"
            dir="ltr"
            value={amount}
            placeholder="0.00"
            aria-invalid={errors.amount ? true : undefined}
            onChange={(event) => {
              setAmount(event.target.value);
            }}
          />
        </Field>
        <Field
          label={type === 'transfer' ? t('finance.field.from_account') : t('finance.field.account')}
          required
          {...(errors.account_id ? { error: errors.account_id } : {})}
        >
          <Select
            value={accountId}
            onChange={(event) => {
              setAccountId(event.target.value);
              setToAccountId('');
            }}
          >
            {usable.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · {a.currency}
              </option>
            ))}
          </Select>
        </Field>
        {type === 'transfer' ? (
          <Field
            label={t('finance.field.to_account')}
            required
            {...(errors.to_account_id ? { error: errors.to_account_id } : {})}
          >
            <Select
              value={toAccountId}
              onChange={(event) => {
                setToAccountId(event.target.value);
              }}
            >
              <option value="">—</option>
              {destinations.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.currency}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field
            label={t('finance.field.category')}
            {...(errors.category_id ? { error: errors.category_id } : {})}
          >
            <Select
              value={categoryId}
              onChange={(event) => {
                setCategoryId(event.target.value);
              }}
            >
              <option value="">{t('finance.field.no_category')}</option>
              {kindCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.sub ? `— ${c.label}` : c.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label={t('finance.field.date')} required>
          <Input
            type="datetime-local"
            value={when}
            onChange={(event) => {
              setWhen(event.target.value);
            }}
          />
        </Field>
        {type === 'transfer' ? null : (
          <Field label={type === 'income' ? t('finance.field.source') : t('finance.field.merchant')}>
            <Input
              value={merchant}
              maxLength={160}
              onChange={(event) => {
                setMerchant(event.target.value);
              }}
            />
          </Field>
        )}
        <Field label={t('finance.field.notes')}>
          <Textarea
            value={notes}
            maxLength={1000}
            rows={2}
            onChange={(event) => {
              setNotes(event.target.value);
            }}
          />
        </Field>
        {type === 'transfer' ? null : (
          <section className="fin-receipts" aria-label={t('finance.receipt.title')}>
            <div className="fin-receipts__head">
              <h3>{t('finance.receipt.title')}</h3>
              <small>
                {stored.length + pages.length}/{MAX_RECEIPTS}
              </small>
            </div>
            {stored.length + pages.length > 0 ? (
              <div className="fin-receipts__list">
                {stored.map((r) => (
                  <StoredReceipt
                    key={r.id}
                    locale={locale}
                    receipt={r}
                    onRemove={() => {
                      void removeStored(r);
                    }}
                  />
                ))}
                {pages.map((p) => (
                  <PendingReceipt
                    key={p.key}
                    locale={locale}
                    page={p}
                    onEdit={() => {
                      setEditor({ file: p.original, replace: p.key, camera: false });
                    }}
                    onRemove={() => {
                      releasePage(p);
                      setPages((old) => old.filter((x) => x.key !== p.key));
                      setScan(null);
                    }}
                  />
                ))}
              </div>
            ) : (
              <p className="fin-muted">{t('finance.receipt.empty')}</p>
            )}
            {room > 0 ? (
              <CaptureButtons
                locale={locale}
                onCamera={(file) => {
                  retake.current = () => {
                    document.querySelector<HTMLInputElement>('.fin-receipts input[capture]')?.click();
                  };
                  setEditor({ file, replace: null, camera: true });
                }}
                onFiles={(files) => {
                  void addFiles(files);
                }}
              />
            ) : null}
            {pages.some((p) => !p.pdf) && scan === null ? (
              <Button
                type="button"
                variant="ghost"
                className="fin-receipts__read"
                onClick={() => {
                  void read();
                }}
              >
                {t('finance.receipt.read')}
              </Button>
            ) : null}
            {scan === 'reading' ? (
              <div className="receipt-reading" role="status">
                <span>{t('finance.receipt.reading')}</span>
                <span className="fin-bar" aria-hidden="true">
                  <span style={{ inlineSize: `${String(scanProgress * 100)}%` }} />
                </span>
              </div>
            ) : null}
            {scan !== null && scan !== 'reading' ? (
              <ReceiptReview
                locale={locale}
                reading={scan.reading}
                category={type === 'expense' ? scan.category : null}
                categorySource={scan.categorySource}
                accountCurrency={account?.currency ?? null}
                onApply={apply}
                onDismiss={() => {
                  setScan(null);
                }}
              />
            ) : null}
            {receiptError ? (
              <p className="fin-form__error" role="alert">
                {receiptError}
              </p>
            ) : null}
          </section>
        )}
        <div className="fin-form__actions">
          {editing ? (
            <Button
              type="button"
              variant="destructive-ghost"
              className="fin-form__delete"
              onClick={() => {
                setConfirmDelete(true);
              }}
            >
              {t('finance.delete')}
            </Button>
          ) : null}
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('finance.cancel')}
          </Button>
          <Button type="submit" loading={saving}>
            {saving ? t('finance.saving') : t('finance.save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { receiptBlob } from '../../lib/receipts';
import type { Page, Receipt } from '../../lib/receipts';

/** Opens a blob in a new tab (images and PDFs preview there; nothing is public). */
function openBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank');
  if (!win) {
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
  }
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 60_000);
}

/** A receipt already saved with the transaction: fetched through the API, privately. */
export function StoredReceipt({
  locale,
  receipt,
  onRemove,
}: {
  readonly locale: Locale;
  readonly receipt: Receipt;
  readonly onRemove?: (() => void) | undefined;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const [url, setUrl] = useState<string | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const image = receipt.mime_type.startsWith('image/');

  useEffect(() => {
    let made: string | null = null;
    let cancelled = false;
    void receiptBlob(locale, receipt.id)
      .then((b) => {
        if (cancelled) return;
        setBlob(b);
        if (image) {
          made = URL.createObjectURL(b);
          setUrl(made);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [locale, receipt.id, image]);

  return (
    <div className="receipt-thumb">
      <button
        type="button"
        className="receipt-thumb__view"
        disabled={!blob}
        onClick={() => {
          if (blob) openBlob(blob, receipt.original_name);
        }}
        aria-label={`${t('capture.view')} ${receipt.original_name}`}
      >
        {url ? <img src={url} alt="" /> : <span className="receipt-thumb__pdf">{image ? '…' : 'PDF'}</span>}
      </button>
      {onRemove ? (
        <button type="button" className="receipt-thumb__remove" onClick={onRemove} aria-label={t('capture.remove')}>
          ×
        </button>
      ) : null}
    </div>
  );
}

/** A page picked on this device, not uploaded yet. */
export function PendingReceipt({
  locale,
  page,
  onEdit,
  onRemove,
}: {
  readonly locale: Locale;
  readonly page: Page;
  readonly onEdit?: (() => void) | undefined;
  readonly onRemove: () => void;
}): React.JSX.Element {
  const t = createTranslator(locale);
  return (
    <div className="receipt-thumb is-pending">
      <button
        type="button"
        className="receipt-thumb__view"
        onClick={() => {
          if (onEdit && !page.pdf) onEdit();
          else openBlob(page.blob, page.name);
        }}
        aria-label={page.pdf ? `${t('capture.view')} ${page.name}` : t('capture.edit')}
      >
        {page.url ? <img src={page.url} alt="" /> : <span className="receipt-thumb__pdf">PDF</span>}
      </button>
      <button type="button" className="receipt-thumb__remove" onClick={onRemove} aria-label={t('capture.remove')}>
        ×
      </button>
    </div>
  );
}

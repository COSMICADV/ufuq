import type { Locale } from '@ufuq/i18n';

import { fetchMany, sendRaw, uploadForm } from './api-client';
import type { Transaction } from './finance';
import { isImage, preparePhoto } from './image-prep';

/** The largest file the attachment store accepts (10 MB). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_RECEIPTS = 10;

export interface Receipt {
  readonly id: string;
  readonly original_name: string;
  readonly mime_type: string;
  readonly size_bytes: number;
}

/** A receipt page chosen on this device and not uploaded yet. */
export interface Page {
  readonly key: string;
  /** What the person picked or photographed — kept so the photo can be re-edited. */
  readonly original: File;
  readonly blob: Blob;
  readonly canvas: HTMLCanvasElement | null;
  readonly url: string | null;
  readonly pdf: boolean;
  readonly name: string;
}

let counter = 0;
const nextKey = (): string => {
  counter += 1;
  return `page-${String(Date.now())}-${String(counter)}`;
};

function baseName(file: File): string {
  const stem = file.name.replace(/\.[^.]+$/, '').slice(0, 80) || 'receipt';
  return stem;
}

/** A picked file as a page: photos prepared (oriented, scaled, JPEG); PDFs kept. */
export async function toPage(
  file: File,
  prepared?: { blob: Blob; canvas: HTMLCanvasElement },
): Promise<Page> {
  if (file.type === 'application/pdf') {
    if (file.size > MAX_FILE_BYTES) throw new Error('too_large');
    return { key: nextKey(), original: file, blob: file, canvas: null, url: null, pdf: true, name: file.name };
  }
  if (!isImage(file)) throw new Error('unsupported');
  const ready = prepared ?? (await preparePhoto(file));
  if (ready.blob.size > MAX_FILE_BYTES) throw new Error('too_large');
  return {
    key: nextKey(),
    original: file,
    blob: ready.blob,
    canvas: ready.canvas,
    url: URL.createObjectURL(ready.blob),
    pdf: false,
    name: `${baseName(file)}.jpg`,
  };
}

export function releasePage(page: Page): void {
  if (page.url) URL.revokeObjectURL(page.url);
}

/** Upload one page as a private attachment of a record (a receipt, a medical document page…). */
export async function uploadPage(
  locale: Locale,
  relatedType: 'finance_transaction' | 'health_document' | 'odometer_reading',
  relatedId: string,
  page: Page,
  name: string = page.name,
): Promise<Receipt> {
  const form = new FormData();
  form.append('related_type', relatedType);
  form.append('related_id', relatedId);
  form.append('file', page.blob, name);
  return uploadForm<Receipt>('/attachments', form, { locale });
}

/** Upload one page as a receipt of a transaction. */
export async function uploadReceipt(locale: Locale, transactionId: string, page: Page): Promise<Receipt> {
  return uploadPage(locale, 'finance_transaction', transactionId, page);
}

/** A stored receipt's bytes, for a preview or a download — never a public URL. */
export async function receiptBlob(locale: Locale, id: string): Promise<Blob> {
  const response = await sendRaw(`/attachments/${id}`, { locale });
  return response.blob();
}

/**
 * The category the person chose last time for this merchant, if any — their
 * own history is a better guess than any keyword list.
 */
export async function historyCategory(locale: Locale, merchant: string): Promise<string | null> {
  const full = merchant.trim().slice(0, 40);
  const first = full.split(/\s+/)[0] ?? '';
  const tries = [...new Set([full, first])].filter((q) => q.length >= 3);
  for (const q of tries) {
    try {
      const result = await fetchMany<Transaction>('/personal/finance/transactions', {
        locale,
        query: { q, type: 'expense', per_page: '5' },
      });
      const found = result.items.find((tx) => tx.category_id !== null)?.category_id;
      if (found) return found;
    } catch {
      return null;
    }
  }
  return null;
}

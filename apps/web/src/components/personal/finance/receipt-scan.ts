import type { Locale } from '@ufuq/i18n';

import type { Category } from '../../../lib/finance';
import { recognise } from '../../../lib/ocr';
import { readReceipt } from '../../../lib/receipt-reader';
import type { ReceiptReading } from '../../../lib/receipt-reader';
import { historyCategory } from '../../../lib/receipts';
import type { Page } from '../../../lib/receipts';

export interface ScanResult {
  readonly reading: ReceiptReading;
  readonly category: Category | null;
  readonly categorySource: 'history' | 'receipt' | null;
}

/**
 * Reads one receipt photo on this device and suggests a category: the one the
 * person used before for the same merchant, else one from the receipt's words.
 */
export async function scanPage(
  locale: Locale,
  page: Page,
  categories: readonly Category[],
  onProgress?: (fraction: number) => void,
): Promise<ScanResult> {
  const text = await recognise(page.canvas ?? page.blob, onProgress);
  const reading = readReceipt(text);
  const usable = categories.filter((c) => c.kind === 'expense' && !c.archived);
  if (reading.merchant) {
    const fromHistory = await historyCategory(locale, reading.merchant);
    const found = usable.find((c) => c.id === fromHistory);
    if (found) return { reading, category: found, categorySource: 'history' };
  }
  if (reading.categoryKey) {
    const found = usable.find((c) => c.key === reading.categoryKey);
    if (found) return { reading, category: found, categorySource: 'receipt' };
  }
  return { reading, category: null, categorySource: null };
}

/** `datetime-local` value for a receipt's date and time (noon when no time is printed). */
export function receiptWhen(date: string, time: string | null | undefined): string {
  return `${date}T${time ?? '12:00'}`;
}

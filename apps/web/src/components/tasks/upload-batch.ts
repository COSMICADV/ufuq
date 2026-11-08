/**
 * Upload several files to one record, one after another. Sequential on
 * purpose: each upload is checked and stored before the next starts, a
 * failure (too large, wrong type, rate limit) costs only that file, and the
 * caller can show "2 of 5".
 */

import type { Locale } from '@ufuq/i18n';

import { ApiError, uploadForm } from '../../lib/api-client';
import {
  fileProblem,
  MAX_UPLOADS_PER_BATCH,
  uploadErrorKey,
  uploadName,
  uploadType,
} from '../../lib/attachments';
import type { Attachment } from '../../lib/attachments';

export interface BatchResult {
  readonly uploaded: readonly Attachment[];
  /** Each refused file and the translation key for why. */
  readonly failed: readonly { readonly name: string; readonly reason: string }[];
}

export async function uploadBatch(
  files: readonly File[],
  target: { readonly relatedType: string; readonly relatedId: string },
  locale: Locale,
  onProgress?: (done: number, total: number) => void,
): Promise<BatchResult> {
  const sendable = files.filter((f) => fileProblem(f) === null).slice(0, MAX_UPLOADS_PER_BATCH);
  const uploaded: Attachment[] = [];
  const failed: { name: string; reason: string }[] = [];
  for (const [index, file] of sendable.entries()) {
    onProgress?.(index, sendable.length);
    const form = new FormData();
    form.append('related_type', target.relatedType);
    form.append('related_id', target.relatedId);
    // Re-wrap so the declared type is right even when the browser gave none.
    const blob = file.type === '' ? new Blob([file], { type: uploadType(file) }) : file;
    form.append('file', blob, uploadName(file));
    try {
      uploaded.push(await uploadForm<Attachment>('/attachments', form, { locale }));
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 0;
      const issue = error instanceof ApiError ? (error.fields['file']?.[0] ?? null) : null;
      failed.push({ name: uploadName(file), reason: uploadErrorKey(status, issue) });
      // Past the hourly allowance every further attempt is refused too.
      if (status === 429) break;
    }
  }
  onProgress?.(sendable.length, sendable.length);
  return { uploaded, failed };
}

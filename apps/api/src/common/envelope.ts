/**
 * The response envelope defined in DOCUMENT 08 §2.
 *
 * Every endpoint answers in one of these two shapes. Nothing constructs a
 * response literal of its own, so the contract cannot drift endpoint by
 * endpoint.
 */

import type { Locale } from '@ufuq/i18n';

export interface ResponseMeta {
  readonly locale: Locale;
}

export interface SingleResponse<TData> {
  readonly data: TData;
  readonly meta: ResponseMeta;
}

/**
 * DOCUMENT 08 §2, "Success (collection)". The pagination block is part of the
 * contract for *every* collection, so it is built here rather than assembled
 * per endpoint — a list that quietly returns its first page with no `total`
 * is indistinguishable, to a client, from a list that is genuinely that short.
 */
export interface CollectionMeta extends ResponseMeta {
  readonly page: number;
  readonly per_page: number;
  readonly total: number;
  readonly total_pages: number;
}

export interface CollectionResponse<TItem> {
  readonly data: readonly TItem[];
  readonly meta: CollectionMeta;
}

export interface ErrorBody {
  readonly code: string;
  readonly message_ar: string;
  readonly message_en: string;
  readonly fields?: Readonly<Record<string, readonly string[]>>;
}

export interface ErrorResponse {
  readonly error: ErrorBody;
}

export function single<TData>(data: TData, meta: ResponseMeta): SingleResponse<TData> {
  return { data, meta };
}

export interface Page {
  readonly page: number;
  readonly perPage: number;
}

export function collection<TItem>(
  data: readonly TItem[],
  total: number,
  page: Page,
  meta: ResponseMeta,
): CollectionResponse<TItem> {
  return {
    data,
    meta: {
      ...meta,
      page: page.page,
      per_page: page.perPage,
      total,
      // A page count of zero would make "page 1 of 0" the normal empty
      // response; one empty page is the honest shape.
      total_pages: Math.max(1, Math.ceil(total / page.perPage)),
    },
  };
}

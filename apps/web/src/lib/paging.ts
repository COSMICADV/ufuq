/**
 * Pagination, kept in the URL — DOCUMENT 11 §6 and DOCUMENT 26 §9:
 * "pagination, filters, and sorting persist in the URL". A page number held
 * only in component state disappears on refresh and cannot be linked to.
 *
 * The schedules screen shows two independent collections, so the parameter
 * name is per list rather than a single global `page`.
 */

export const DEFAULT_PER_PAGE = 20;

/**
 * Read a page number from a query string. Anything that is not a positive
 * integer — absent, empty, `abc`, `0`, `-3` — is page 1; a hand-edited URL
 * should land somewhere sensible rather than on an error.
 */
export function pageFromParams(params: URLSearchParams, key: string): number {
  const raw = params.get(key);
  if (raw === null || !/^\d+$/.test(raw)) {
    return 1;
  }
  const parsed = Number(raw);
  return parsed >= 1 ? parsed : 1;
}

/**
 * The query string for a page change. Page 1 drops the parameter entirely, so
 * the canonical first page has one address rather than two.
 */
export function withPage(params: URLSearchParams, key: string, page: number): string {
  const next = new URLSearchParams(params);
  if (page <= 1) {
    next.delete(key);
  } else {
    next.set(key, String(page));
  }
  const query = next.toString();
  return query === '' ? '' : `?${query}`;
}

export interface PageWindow {
  readonly page: number;
  readonly totalPages: number;
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
}

export function pageWindow(page: number, totalPages: number): PageWindow {
  const safeTotal = Math.max(1, totalPages);
  return {
    page,
    totalPages: safeTotal,
    hasPrevious: page > 1,
    hasNext: page < safeTotal,
  };
}

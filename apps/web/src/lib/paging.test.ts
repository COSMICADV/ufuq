/**
 * Pagination in the URL — DOCUMENT 11 §6, DOCUMENT 26 §9.
 *
 * The cases worth pinning down are the ones a hand-edited or stale URL
 * produces: a page that is not a number, a page of zero, a page beyond the
 * end. None of them should be an error screen.
 */

import { describe, expect, it } from 'vitest';

import { pageFromParams, pageWindow, withPage } from './paging';

function params(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

describe('pageFromParams', () => {
  it('reads a page number', () => {
    expect(pageFromParams(params('page=3'), 'page')).toBe(3);
  });

  it('defaults to the first page when absent', () => {
    expect(pageFromParams(params(''), 'page')).toBe(1);
  });

  it.each(['page=abc', 'page=', 'page=0', 'page=-2', 'page=1.5', 'page=٣'])(
    'falls back to the first page for %s',
    (query) => {
      expect(pageFromParams(params(query), 'page')).toBe(1);
    },
  );

  it('reads independent keys for two lists on one screen', () => {
    const query = params('schedules_page=2&holidays_page=5');
    expect(pageFromParams(query, 'schedules_page')).toBe(2);
    expect(pageFromParams(query, 'holidays_page')).toBe(5);
  });
});

describe('withPage', () => {
  it('sets the page', () => {
    expect(withPage(params(''), 'page', 4)).toBe('?page=4');
  });

  it('drops the parameter on page one, so the first page has one address', () => {
    expect(withPage(params('page=4'), 'page', 1)).toBe('');
  });

  it('leaves other parameters untouched', () => {
    const result = withPage(params('holidays_page=2'), 'schedules_page', 3);
    expect(new URLSearchParams(result.slice(1)).get('holidays_page')).toBe('2');
    expect(new URLSearchParams(result.slice(1)).get('schedules_page')).toBe('3');
  });

  it('does not mutate the parameters it was given', () => {
    const original = params('page=2');
    withPage(original, 'page', 7);
    expect(original.get('page')).toBe('2');
  });
});

describe('pageWindow', () => {
  it('knows there is nowhere to go from a single page', () => {
    expect(pageWindow(1, 1)).toMatchObject({ hasPrevious: false, hasNext: false });
  });

  it('knows both directions are open in the middle', () => {
    expect(pageWindow(3, 8)).toMatchObject({ hasPrevious: true, hasNext: true });
  });

  it('closes the forward direction on the last page', () => {
    expect(pageWindow(8, 8)).toMatchObject({ hasPrevious: true, hasNext: false });
  });

  it('treats an empty collection as one empty page, not zero pages', () => {
    expect(pageWindow(1, 0)).toMatchObject({ totalPages: 1, hasNext: false });
  });
});

/** Pagination meta builders + over-fetch helpers — spec §5.1.4, §5.2.2; E-A9. */
import { withApiRuntime } from '../testing/with-api-runtime';
import {
  buildOffsetPaginationMeta,
  buildPaginationMeta,
  fetchLimit,
  toCursorPage,
  toOffsetPage,
} from './build-meta';
import { decodeCursor } from './cursor';

describe('buildPaginationMeta', () => {
  it('emits nextCursor only when hasMore — a cursor on the last page is a wasted round-trip', () => {
    expect(buildPaginationMeta({ items: [1], hasMore: true, nextCursor: 'c' }, 20)).toEqual({ hasMore: true, limit: 20, nextCursor: 'c' });
    expect(buildPaginationMeta({ items: [1], hasMore: false, nextCursor: 'c' }, 20)).toEqual({ hasMore: false, limit: 20 });
  });
  it('passes prevCursor through when supplied, omits it otherwise (never null)', () => {
    expect(buildPaginationMeta({ items: [], hasMore: false, prevCursor: 'p' }, 5)).toEqual({ hasMore: false, limit: 5, prevCursor: 'p' });
    expect('prevCursor' in buildPaginationMeta({ items: [], hasMore: false }, 5)).toBe(false);
    expect('nextCursor' in buildPaginationMeta({ items: [], hasMore: false }, 5)).toBe(false);
  });
});

describe('toCursorPage / fetchLimit — the limit+1 over-fetch', () => {
  it('fetchLimit adds the sentinel row', () => {
    expect(fetchLimit(20)).toBe(21);
  });
  it.each([0, -1, 1.5, Number.NaN])('rejects a nonsensical limit (%p)', (bad) => {
    expect(() => fetchLimit(bad)).toThrow(RangeError);
    expect(() => toCursorPage([], bad, () => ({}))).toThrow(RangeError);
  });

  it('limit+1 rows ⇒ hasMore, the sentinel is trimmed, and nextCursor is built from the LAST RETURNED item (not the sentinel)', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const page = toCursorPage(rows, 2, (last) => ({ id: last.id }));
    expect(page.items).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(page.hasMore).toBe(true);
    expect(decodeCursor(page.nextCursor as string)).toEqual({ id: 'b' });
  });

  it('exactly `limit` rows ⇒ no more, no cursor', () => {
    const page = toCursorPage([{ id: 'a' }, { id: 'b' }], 2, (l) => ({ id: l.id }));
    expect(page).toEqual({ items: [{ id: 'a' }, { id: 'b' }], hasMore: false });
  });

  it('empty result ⇒ empty page, no cursor, cursorOf never called', () => {
    const cursorOf = jest.fn();
    expect(toCursorPage([], 10, cursorOf)).toEqual({ items: [], hasMore: false });
    expect(cursorOf).not.toHaveBeenCalled();
  });

  it('does not mutate its input', () => {
    const rows = Object.freeze([1, 2, 3]);
    expect(() => toCursorPage(rows, 2, (n) => ({ n }))).not.toThrow();
  });

  it('end-to-end through a SIGNED codec: the cursor a client is handed decodes on the next request', () => {
    withApiRuntime({ cursorSigningKeys: ['k'.repeat(32)] }, () => {
      const page = toCursorPage([{ id: 1 }, { id: 2 }], 1, (l) => ({ id: l.id }));
      expect(decodeCursor(page.nextCursor as string)).toEqual({ id: 1 });
    });
  });
});

describe('offset meta', () => {
  it('without a total: page/limit/hasMore only', () => {
    expect(buildOffsetPaginationMeta({ items: [], page: 2, limit: 10, hasMore: true })).toEqual({ page: 2, limit: 10, hasMore: true });
  });
  it('with a total: total + ceil(total/limit) totalPages', () => {
    expect(buildOffsetPaginationMeta({ items: [], page: 1, limit: 10, hasMore: true, total: 95 })).toEqual({ page: 1, limit: 10, hasMore: true, total: 95, totalPages: 10 });
    expect(buildOffsetPaginationMeta({ items: [], page: 1, limit: 10, hasMore: false, total: 0 })).toEqual({ page: 1, limit: 10, hasMore: false, total: 0, totalPages: 0 });
  });

  describe('toOffsetPage', () => {
    it('without total, hasMore comes from the over-fetch', () => {
      expect(toOffsetPage([1, 2, 3], { page: 1, limit: 2 })).toEqual({ items: [1, 2], page: 1, limit: 2, hasMore: true });
      expect(toOffsetPage([1, 2], { page: 1, limit: 2 })).toEqual({ items: [1, 2], page: 1, limit: 2, hasMore: false });
    });
    it('with total, hasMore is exact arithmetic', () => {
      expect(toOffsetPage([1, 2], { page: 2, limit: 2 }, 5)).toMatchObject({ hasMore: true, total: 5 });
      expect(toOffsetPage([5], { page: 3, limit: 2 }, 5)).toMatchObject({ hasMore: false, total: 5 });
    });
  });
});

/**
 * Pagination meta builders — API Infrastructure spec §5.1.4, §5.2.2, plus the two helpers that
 * remove the most common way a domain gets pagination subtly wrong (E-A9): forgetting the
 * "fetch limit + 1" over-fetch that makes `hasMore` exact without a `COUNT(*)`.
 */
import { encodeCursor } from './cursor';
import type {
  CursorPage,
  OffsetPage,
  OffsetPaginationMeta,
  PaginationMeta,
} from './pagination.port';

const assertLimit = (limit: number): void => {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`limit must be a positive integer, got ${String(limit)}`);
  }
};

/**
 * Shapes the cursor `meta.pagination` object. `nextCursor` is only ever emitted when `hasMore` is
 * true — a repository that hands back a cursor on the last page would otherwise send clients on
 * a pointless extra round-trip that returns an empty page.
 */
export function buildPaginationMeta<T>(
  page: CursorPage<T>,
  limit: number,
): PaginationMeta {
  const meta: PaginationMeta = { hasMore: page.hasMore, limit };
  if (page.hasMore && page.nextCursor !== undefined) meta.nextCursor = page.nextCursor;
  if (page.prevCursor !== undefined) meta.prevCursor = page.prevCursor;
  return meta;
}

/** Shapes the offset `meta.pagination` object (§5.2.2). `total`/`totalPages` only when `total` is known. */
export function buildOffsetPaginationMeta<T>(
  page: OffsetPage<T>,
): OffsetPaginationMeta {
  const meta: OffsetPaginationMeta = {
    page: page.page,
    limit: page.limit,
    hasMore: page.hasMore,
  };
  if (page.total !== undefined) {
    meta.total = page.total;
    meta.totalPages = Math.ceil(page.total / page.limit);
  }
  return meta;
}

/** How many rows a repository should fetch for a page of `limit` — one extra decides `hasMore`. */
export const fetchLimit = (limit: number): number => {
  assertLimit(limit);
  return limit + 1;
};

/**
 * Turns the `limit + 1` rows a repository fetched into a `CursorPage`: trims the sentinel row,
 * derives `hasMore`, and encodes `nextCursor` from the LAST RETURNED item (never the sentinel).
 */
export function toCursorPage<T>(
  rows: readonly T[],
  limit: number,
  cursorOf: (lastItem: T) => Record<string, unknown>,
): CursorPage<T> {
  assertLimit(limit);
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : [...rows];
  const page: CursorPage<T> = { items, hasMore };
  if (hasMore && items.length > 0) {
    page.nextCursor = encodeCursor(cursorOf(items[items.length - 1] as T));
  }
  return page;
}

/**
 * Offset equivalent of `toCursorPage`. With `total` known (`includeTotal=true`) `hasMore` is exact
 * from arithmetic; without it, from the `limit + 1` over-fetch.
 */
export function toOffsetPage<T>(
  rows: readonly T[],
  request: { page: number; limit: number },
  total?: number,
): OffsetPage<T> {
  assertLimit(request.limit);
  const overFetched = rows.length > request.limit;
  const items = overFetched ? rows.slice(0, request.limit) : [...rows];
  const hasMore =
    total !== undefined ? request.page * request.limit < total : overFetched;
  const page: OffsetPage<T> = {
    items,
    page: request.page,
    limit: request.limit,
    hasMore,
  };
  if (total !== undefined) page.total = total;
  return page;
}

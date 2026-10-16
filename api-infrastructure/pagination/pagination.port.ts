/**
 * Pagination wire shapes — API Infrastructure spec §5.1.2, §5.2.2. One `meta.pagination` field
 * on the wire regardless of mechanism; a client tells them apart by `nextCursor`/`prevCursor`
 * (cursor) versus `page`/`total` (offset).
 */
export interface PaginationMeta {
  /** Present only when more items exist past this page. */
  nextCursor?: string;
  /** Present only when the endpoint supports backward traversal. */
  prevCursor?: string;
  /** Whether another page exists. */
  hasMore: boolean;
  /** Echo of the effective, already-validated limit. */
  limit: number;
}

export interface OffsetPaginationMeta {
  page: number;
  limit: number;
  hasMore: boolean;
  /** Present only when the request asked for `includeTotal=true`. */
  total?: number;
  /** Present only alongside `total`. */
  totalPages?: number;
}

/** What a domain repository hands back for a cursor-paginated read (§5.1.4). */
export interface CursorPage<T> {
  items: T[];
  nextCursor?: string;
  prevCursor?: string;
  hasMore: boolean;
}

/** What a domain repository hands back for an offset-paginated read (§5.2). */
export interface OffsetPage<T> {
  items: T[];
  page: number;
  limit: number;
  hasMore: boolean;
  total?: number;
}

/** The resolved request side of cursor pagination (`@CursorParams()`, §5.1.1). */
export interface CursorPageRequest {
  /** The effective, validated page size (default applied, bounds enforced). */
  readonly limit: number;
  /** The DECODED cursor payload; `undefined` means "first page". */
  readonly after?: Readonly<Record<string, unknown>>;
  /** `true` when a cursor was supplied but could not be decoded (lenient mode served page 1). */
  readonly cursorRejected: boolean;
}

/** The resolved request side of offset pagination (`@OffsetParams()`, §5.2.1). */
export interface OffsetPageRequest {
  readonly page: number;
  readonly limit: number;
  /** `(page - 1) * limit` — the value a repository passes to `skip`/`OFFSET`. */
  readonly offset: number;
  readonly includeTotal: boolean;
}

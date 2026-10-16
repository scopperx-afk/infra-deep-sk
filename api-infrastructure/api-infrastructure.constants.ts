/**
 * Hard, NON-configurable bounds — API Infrastructure spec §5, §6, §7 ("bound everything
 * untrusted"; governing principle #18). Every value here exists to cap the CPU or memory one
 * hostile query string can cost, independent of what any `api.*` Config key says. Config can
 * only tighten within these ceilings (`config/api.schema.ts` rejects a value above them at
 * boot) — it can never lift them, because a "just let ops raise it under load" knob on a
 * request-parsing bound is exactly how a query string becomes a denial-of-service lever.
 */

/** Absolute ceiling for `api.pagination.maxLimit`. A page of more than this is a bulk export, not a page. */
export const API_HARD_MAX_LIMIT = 1_000;

/** Absolute ceiling for `api.pagination.maxPage` (offset mode — internal/admin only, spec §5.2). */
export const API_HARD_MAX_PAGE = 100_000;

/** An encoded cursor longer than this is never decoded (and `encodeCursor` refuses to produce one — §5.1.3 hardening). */
export const MAX_CURSOR_LENGTH = 2_048;

/** Query keys examined per request by the filter parser; the rest are ignored. */
export const MAX_QUERY_KEYS_SCANNED = 200;

/** Parsed filters returned per request; the rest are ignored. */
export const MAX_FILTERS_PER_REQUEST = 25;

/** Values accepted by one `...In=a,b,c` filter. */
export const MAX_IN_VALUES = 100;

/** Longest single filter value (after trimming), in characters. */
export const MAX_FILTER_VALUE_LENGTH = 256;

/** Sort fields honoured per request. */
export const MAX_SORT_FIELDS = 5;

/** Longest raw `?sort=` value considered; anything longer yields no sorts at all. */
export const MAX_SORT_PARAM_LENGTH = 512;

/** Truncated HMAC-SHA256 length used when cursor signing is enabled (128 bits — ample for an integrity tag). */
export const CURSOR_SIGNATURE_BYTES = 16;

/** Minimum length of a configured cursor signing key. */
export const MIN_CURSOR_KEY_LENGTH = 32;

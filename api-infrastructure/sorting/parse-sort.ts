/**
 * `parseSorts()` — API Infrastructure spec §7.1, §7.3.
 *
 * `?sort=createdAt:desc,email:asc` — comma-separated `field[:direction]`, direction case-sensitive
 * (`:DESC` drops the WHOLE segment, §7.1). Same posture as `parseFilters()`: NEVER throws on any
 * query input; unknown fields and malformed segments are dropped; a request that supplies only
 * invalid sorts falls back to the repository's own default ordering.
 *
 * Bounds (E-A14): the raw parameter is capped (`MAX_SORT_PARAM_LENGTH`, anything longer yields no
 * sorts at all rather than a truncated, differently-meaning one), at most `MAX_SORT_FIELDS` fields
 * are honoured, and a field repeated in one request keeps its FIRST direction (a later
 * `createdAt:asc` after `createdAt:desc` is ambiguous and ignored, not an error).
 */
import { MAX_SORT_FIELDS, MAX_SORT_PARAM_LENGTH } from '../api-infrastructure.constants';
import type { ParsedSort, SortDirection } from './sort.port';

export function parseSorts(
  query: unknown,
  allowlist: readonly string[] | ReadonlySet<string>,
): ParsedSort[] {
  if (typeof query !== 'object' || query === null) return [];
  const allowed: ReadonlySet<string> =
    allowlist instanceof Set ? allowlist : new Set(allowlist as readonly string[]);
  if (allowed.size === 0) return []; // §7.2: no declaration → no sortable fields

  if (!Object.hasOwn(query, 'sort')) return [];
  const raw = (query as Record<string, unknown>).sort;
  const pieces: string[] = [];
  let totalLength = 0;
  const take = (value: unknown): boolean => {
    if (typeof value !== 'string') return false;
    totalLength += value.length;
    if (totalLength > MAX_SORT_PARAM_LENGTH) return false;
    pieces.push(value);
    return true;
  };
  if (Array.isArray(raw)) {
    for (const element of raw) if (!take(element)) return [];
  } else if (!take(raw)) {
    return [];
  }

  const out: ParsedSort[] = [];
  const seen = new Set<string>();
  for (const piece of pieces) {
    for (const segment of piece.split(',')) {
      const parts = segment.split(':');
      if (parts.length > 2) continue;
      const field = parts[0] as string;
      const direction: string = parts.length === 2 ? (parts[1] as string) : 'asc';
      if (direction !== 'asc' && direction !== 'desc') continue;
      if (!allowed.has(field) || seen.has(field)) continue;
      seen.add(field);
      out.push({ field, direction: direction as SortDirection });
      if (out.length >= MAX_SORT_FIELDS) return out;
    }
  }
  return out;
}

/**
 * Appends a stable tiebreaker (default `id`) when the sorts do not already end in one — §7.4's
 * requirement made a one-liner (E-A9). Without it, cursor pagination silently skips or repeats
 * rows at page boundaries whenever the primary sort key has ties. The tiebreaker inherits the last
 * sort's direction so the composite key stays monotonic; it is appended even when the caller
 * supplied no sorts at all (`[]` → `[{ id asc }]`).
 */
export function withTiebreaker(
  sorts: readonly ParsedSort[],
  field = 'id',
  direction?: SortDirection,
): ParsedSort[] {
  if (sorts.some((s) => s.field === field)) return [...sorts];
  const last = sorts[sorts.length - 1];
  return [...sorts, { field, direction: direction ?? last?.direction ?? 'asc' }];
}

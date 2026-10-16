/**
 * `parseFilters()` — API Infrastructure spec §6.3. Given a raw query object and an allowlist,
 * extracts typed filters. NEVER throws on any query input: unknown fields are ignored, malformed
 * values are dropped (the allowlist is the contract; this parser is a convenience, not a
 * validation boundary — a domain that wants strictness validates through Validation's Pipe).
 *
 * Bounds (E-A14): at most `MAX_QUERY_KEYS_SCANNED` keys are examined and at most
 * `MAX_FILTERS_PER_REQUEST` filters returned, so a request with thousands of junk parameters costs
 * a bounded amount of CPU. Iteration uses `for…in` + `Object.hasOwn` so a huge query object is
 * abandoned early rather than copied into a key array first.
 */
import {
  MAX_FILTERS_PER_REQUEST,
  MAX_QUERY_KEYS_SCANNED,
} from '../api-infrastructure.constants';
import { coerceFilterValue } from './coerce';
import {
  compileFilterAllowlist,
  isCompiledFilterAllowlist,
  type CompiledFilterAllowlist,
} from './filter-allowlist';
import type { FilterableField, ParsedFilter } from './filter.port';

export function parseFilters(
  query: unknown,
  allowlist: readonly (string | FilterableField)[] | CompiledFilterAllowlist,
): ParsedFilter[] {
  const compiled = isCompiledFilterAllowlist(allowlist)
    ? allowlist
    : compileFilterAllowlist(allowlist);
  if (typeof query !== 'object' || query === null || compiled.keys.size === 0) return [];

  const out: ParsedFilter[] = [];
  let scanned = 0;
  for (const key in query) {
    if (!Object.hasOwn(query, key)) continue;
    if (++scanned > MAX_QUERY_KEYS_SCANNED) break;
    const entry = compiled.keys.get(key);
    if (entry === undefined) continue;
    const value = coerceFilterValue(
      entry.field.type,
      entry.operator,
      (query as Record<string, unknown>)[key],
    );
    if (value === undefined) continue;
    out.push({ field: entry.field.name, operator: entry.operator, value });
    if (out.length >= MAX_FILTERS_PER_REQUEST) break;
  }
  return out;
}

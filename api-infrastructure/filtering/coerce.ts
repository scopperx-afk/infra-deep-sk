/**
 * Strict, total (never throwing) coercion of ONE raw query value to a filter's declared type —
 * API Infrastructure spec §6.3 ("a value that fails coercion is dropped"), tightened (E-A14).
 *
 * Every rule below exists because JavaScript's own lenient parsers would otherwise let
 * several spellings alias one value or let surprising input through:
 *   • numbers are plain decimals — not `0x10`, `1e3`, `Infinity`, `' 5 '`, or `007`;
 *   • booleans are exactly `true`/`false`;
 *   • dates are ISO-8601 with an EXPLICIT zone whenever a time is present (`2024-01-01T10:00:00`
 *     would otherwise silently mean "10:00 in the SERVER's timezone"), and the calendar date must
 *     really exist (V8's `new Date('2024-02-30')` rolls over to March 1st — we do not);
 *   • strings are bounded and contain no control characters.
 */
import { MAX_FILTER_VALUE_LENGTH, MAX_IN_VALUES } from '../api-infrastructure.constants';
import type { FilterFieldType, FilterOperator } from './filter.port';

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d{1,15})?$/;
const ISO_DATE =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-](\d{2}):(\d{2})))?$/;

function coerceString(raw: string): string | undefined {
  if (raw.length === 0 || raw.length > MAX_FILTER_VALUE_LENGTH) return undefined;
  return CONTROL_CHARS.test(raw) ? undefined : raw;
}

function coerceNumber(raw: string): number | undefined {
  if (raw.length > 24 || !NUMBER.test(raw)) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  if (!raw.includes('.') && !Number.isSafeInteger(n)) return undefined;
  return n === 0 ? 0 : n; // normalise -0
}

function coerceBoolean(raw: string): boolean | undefined {
  return raw === 'true' ? true : raw === 'false' ? false : undefined;
}

export function coerceDate(raw: string): Date | undefined {
  if (raw.length > 40) return undefined;
  const m = ISO_DATE.exec(raw);
  if (m === null) return undefined;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  probe.setUTCFullYear(year); // years 0–99 would otherwise map to 1900–1999
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return undefined;
  if (m[4] !== undefined) {
    if (Number(m[4]) > 23 || Number(m[5]) > 59) return undefined;
    if (m[6] !== undefined && Number(m[6]) > 59) return undefined;
    if (m[8] !== undefined && (Number(m[8]) > 23 || Number(m[9]) > 59)) return undefined;
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function coerceScalar(type: FilterFieldType, raw: string): unknown {
  switch (type) {
    case 'string':
      return coerceString(raw);
    case 'number':
      return coerceNumber(raw);
    case 'boolean':
      return coerceBoolean(raw);
    case 'date':
      return coerceDate(raw);
  }
}

function coerceList(type: FilterFieldType, raw: unknown): unknown[] | undefined {
  const parts: string[] = [];
  const take = (value: unknown): boolean => {
    if (typeof value !== 'string') return false;
    for (const piece of value.split(',')) parts.push(piece.trim());
    return parts.length <= MAX_IN_VALUES;
  };
  if (Array.isArray(raw)) {
    for (const element of raw) if (!take(element)) return undefined;
  } else if (!take(raw)) {
    return undefined;
  }
  if (parts.length === 0 || parts.length > MAX_IN_VALUES) return undefined;
  const out: unknown[] = [];
  const seen = new Set<unknown>();
  for (const part of parts) {
    const value = coerceScalar(type, part);
    if (value === undefined) return undefined; // one bad element invalidates the whole filter
    const identity = value instanceof Date ? value.getTime() : value;
    if (!seen.has(identity)) {
      seen.add(identity);
      out.push(value);
    }
  }
  return out;
}

/** Coerces the raw value for `operator` on a `type` field; `undefined` means "drop this filter". */
export function coerceFilterValue(
  type: FilterFieldType,
  operator: FilterOperator,
  raw: unknown,
): unknown {
  if (operator === 'in') return coerceList(type, raw);
  // Repeated keys (`?status=a&status=b`) and nested objects are ambiguous: drop, never guess.
  if (typeof raw !== 'string') return undefined;
  return coerceScalar(type, raw);
}

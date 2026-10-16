/**
 * Filter allowlist compilation — API Infrastructure spec §6.1, §6.2.
 *
 * `@Filterable()` and `parseFilters()` both go through `compileFilterAllowlist()`, which turns the
 * declared fields into ONE precomputed `Map<queryKey, {field, operator}>`. Two payoffs:
 *
 *  1. Speed on the hot path — parsing a request is a `Map.get` per query key, never a per-key
 *     suffix search (this runs on every list request of a platform with millions of users).
 *  2. Ambiguity is resolved ONCE, at declaration time, instead of by whichever branch a parser
 *     happens to try first: a field `age` (op `gt` → key `ageGt`) and a second field literally
 *     named `ageGt` would both claim the key `ageGt`; that is a programming error and throws at
 *     boot (decorators evaluate when the class is loaded), never a silent per-request guess.
 *
 * Declaration mistakes throw `TypeError` — they are programmer errors found at startup. The
 * request-time functions (`parseFilters`, `parseSorts`) never throw on any QUERY input.
 */
import type {
  FilterFieldType,
  FilterOperator,
  FilterableField,
} from './filter.port';

const OPERATOR_SUFFIX: Readonly<Record<FilterOperator, string>> = {
  eq: '',
  ne: 'Ne',
  gt: 'Gt',
  gte: 'Gte',
  lt: 'Lt',
  lte: 'Lte',
  in: 'In',
  like: 'Like',
};

/** Which operators are meaningful for each field type — `ageLike` or `activeGt` are never valid. */
const APPLICABLE: Readonly<Record<FilterFieldType, readonly FilterOperator[]>> = {
  string: ['eq', 'ne', 'in', 'like'],
  number: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in'],
  boolean: ['eq', 'ne'],
  date: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'],
};

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_FIELD_NAME_LENGTH = 64;

export interface NormalizedFilterField {
  readonly name: string;
  readonly type: FilterFieldType;
  readonly operators: readonly FilterOperator[];
}

export interface CompiledFilterAllowlist {
  readonly fields: readonly NormalizedFilterField[];
  readonly keys: ReadonlyMap<
    string,
    { readonly field: NormalizedFilterField; readonly operator: FilterOperator }
  >;
}

export const isValidFieldName = (name: unknown): name is string =>
  typeof name === 'string' &&
  name.length <= MAX_FIELD_NAME_LENGTH &&
  FIELD_NAME.test(name) &&
  !name.split('.').some((segment) => FORBIDDEN_SEGMENTS.has(segment));

function normalize(input: string | FilterableField): NormalizedFilterField {
  const def: FilterableField = typeof input === 'string' ? { name: input } : input;
  if (!isValidFieldName(def.name)) {
    throw new TypeError(`@Filterable: invalid field name ${JSON.stringify(def.name)}`);
  }
  const type: FilterFieldType = def.type ?? 'string';
  const applicable = APPLICABLE[type];
  if (applicable === undefined) {
    throw new TypeError(`@Filterable: field "${def.name}" has unknown type ${JSON.stringify(type)}`);
  }
  let operators: readonly FilterOperator[] = applicable;
  if (def.allowedOperators !== undefined) {
    for (const op of def.allowedOperators) {
      if (!(op in OPERATOR_SUFFIX)) {
        throw new TypeError(`@Filterable: field "${def.name}" lists unknown operator ${JSON.stringify(op)}`);
      }
      if (!applicable.includes(op)) {
        throw new TypeError(
          `@Filterable: operator "${op}" is not applicable to ${type} field "${def.name}" (allowed for ${type}: ${applicable.join(', ')})`,
        );
      }
    }
    // Keep the type's canonical order; the caller's list is a restriction, not a re-ordering.
    operators = applicable.filter((op) => def.allowedOperators!.includes(op));
  }
  if (operators.length === 0) {
    throw new TypeError(`@Filterable: field "${def.name}" allows no operators`);
  }
  return Object.freeze({ name: def.name, type, operators: Object.freeze([...operators]) });
}

const cache = new WeakMap<readonly unknown[], CompiledFilterAllowlist>();

export function isCompiledFilterAllowlist(v: unknown): v is CompiledFilterAllowlist {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as CompiledFilterAllowlist).keys instanceof Map &&
    Array.isArray((v as CompiledFilterAllowlist).fields)
  );
}

export function compileFilterAllowlist(
  fields: readonly (string | FilterableField)[],
): CompiledFilterAllowlist {
  const cached = cache.get(fields);
  if (cached !== undefined) return cached;

  const normalized: NormalizedFilterField[] = [];
  const names = new Set<string>();
  const keys = new Map<
    string,
    { field: NormalizedFilterField; operator: FilterOperator }
  >();
  for (const input of fields) {
    const field = normalize(input);
    if (names.has(field.name)) {
      throw new TypeError(`@Filterable: field "${field.name}" is declared twice`);
    }
    names.add(field.name);
    normalized.push(field);
    for (const operator of field.operators) {
      const key = field.name + OPERATOR_SUFFIX[operator];
      const existing = keys.get(key);
      if (existing !== undefined) {
        throw new TypeError(
          `@Filterable: query key "${key}" is ambiguous — claimed by "${existing.field.name}" (${existing.operator}) and "${field.name}" (${operator})`,
        );
      }
      keys.set(key, { field, operator });
    }
  }
  const compiled: CompiledFilterAllowlist = Object.freeze({
    fields: Object.freeze(normalized),
    keys,
  });
  cache.set(fields, compiled);
  return compiled;
}

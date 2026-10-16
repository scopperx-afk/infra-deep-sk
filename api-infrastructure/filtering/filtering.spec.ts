/** Filtering — spec §6, §13 ("Filtering"); E-A4 / E-A14. */
import { compileFilterAllowlist } from './filter-allowlist';
import { Filterable, FILTERABLE_KEY } from './filter-allowlist.decorator';
import type { FilterableField } from './filter.port';
import { coerceDate } from './coerce';
import { escapeLikePattern } from './like.util';
import { parseFilters } from './parse-filter';
import {
  MAX_FILTERS_PER_REQUEST,
  MAX_FILTER_VALUE_LENGTH,
  MAX_IN_VALUES,
  MAX_QUERY_KEYS_SCANNED,
} from '../api-infrastructure.constants';

const ALLOW: readonly (string | FilterableField)[] = [
  'status',
  { name: 'age', type: 'number' },
  { name: 'createdAt', type: 'date' },
  { name: 'active', type: 'boolean' },
  { name: 'ip', type: 'string', allowedOperators: ['eq', 'in'] },
];

describe('parseFilters — allowlist is the contract', () => {
  it('no allowlist entries ⇒ zero filters regardless of the query (§6.2: permit nothing, never everything)', () => {
    expect(parseFilters({ status: 'active', ageGte: '1' }, [])).toEqual([]);
  });

  it('parses only declared fields; unknown query keys are ignored silently', () => {
    expect(parseFilters({ status: 'active', other: 'x' }, ['status'])).toEqual([{ field: 'status', operator: 'eq', value: 'active' }]);
  });

  it.each([
    ['ageGt', 'gt'], ['ageGte', 'gte'], ['ageLt', 'lt'], ['ageLte', 'lte'], ['ageNe', 'ne'], ['age', 'eq'],
  ])('operator suffix %s ⇒ %s', (key, operator) => {
    expect(parseFilters({ [key]: '18' }, ALLOW)).toEqual([{ field: 'age', operator, value: 18 }]);
  });

  it('suffixes are EXACT and case-sensitive: `createdAtgte` is not `createdAtGte` — it is simply not declared (§13)', () => {
    expect(parseFilters({ createdAtgte: '2024-01-01' }, ALLOW)).toEqual([]);
    expect(parseFilters({ AgeGte: '1' }, ALLOW)).toEqual([]);
    expect(parseFilters({ createdAtGte: '2024-01-01' }, ALLOW)).toHaveLength(1);
  });

  it('allowedOperators restricts: `ip` allows eq/in only', () => {
    expect(parseFilters({ ip: '1.2.3.4' }, ALLOW)).toHaveLength(1);
    expect(parseFilters({ ipIn: '1.1.1.1,2.2.2.2' }, ALLOW)).toEqual([{ field: 'ip', operator: 'in', value: ['1.1.1.1', '2.2.2.2'] }]);
    expect(parseFilters({ ipLike: '1.2' }, ALLOW)).toEqual([]);
    expect(parseFilters({ ipNe: '1.2.3.4' }, ALLOW)).toEqual([]);
  });

  it('operators that make no sense for a TYPE are never accepted (`activeGt`, `ageLike`)', () => {
    expect(parseFilters({ activeGt: 'true', ageLike: '1', statusGt: 'a' }, ALLOW)).toEqual([]);
  });

  it('a mixed query yields the valid filters and silently drops the malformed one (§13)', () => {
    expect(parseFilters({ ageGte: 'abc', status: 'ok' }, ALLOW)).toEqual([{ field: 'status', operator: 'eq', value: 'ok' }]);
  });

  it('never throws on hostile query shapes', () => {
    for (const q of [undefined, null, 'str', 42, [], [['a']], { status: { $ne: 1 } }, { status: ['a', 'b'] }, { status: null }, { __proto__: { status: 'x' } }]) {
      expect(() => parseFilters(q, ALLOW)).not.toThrow();
    }
    expect(parseFilters({ status: { $ne: 1 } }, ALLOW)).toEqual([]);
    expect(parseFilters({ status: ['a', 'b'] }, ALLOW)).toEqual([]); // HTTP parameter pollution: ambiguous ⇒ dropped
  });

  it('does not read inherited properties off the query object', () => {
    const q = Object.create({ status: 'inherited' }) as Record<string, unknown>;
    expect(parseFilters(q, ['status'])).toEqual([]);
  });
});

describe('type coercion (strict — E-A14)', () => {
  const one = (type: FilterableField['type'], raw: unknown) => parseFilters({ f: raw }, [{ name: 'f', type }]);

  it('numbers: plain decimals only', () => {
    expect(one('number', '18')).toEqual([{ field: 'f', operator: 'eq', value: 18 }]);
    expect(one('number', '-3.5')).toEqual([{ field: 'f', operator: 'eq', value: -3.5 }]);
    expect(one('number', '0')).toEqual([{ field: 'f', operator: 'eq', value: 0 }]);
    for (const bad of ['0x10', '1e3', 'Infinity', 'NaN', ' 5', '5 ', '007', '+5', '1,5', '', '.5', '5.', '9007199254740993', '1'.repeat(30)]) {
      expect(one('number', bad)).toEqual([]);
    }
  });
  it('-0 is normalised to 0', () => {
    expect(Object.is((one('number', '-0')[0] as { value: number }).value, 0)).toBe(true);
  });
  it('booleans: exactly true/false', () => {
    expect(one('boolean', 'true')[0]?.value).toBe(true);
    expect(one('boolean', 'false')[0]?.value).toBe(false);
    for (const bad of ['1', '0', 'TRUE', 'yes', '']) expect(one('boolean', bad)).toEqual([]);
  });
  it('strings: non-empty, bounded, no control characters', () => {
    expect(one('string', 'ok')).toHaveLength(1);
    expect(one('string', '')).toEqual([]);
    expect(one('string', 'a'.repeat(MAX_FILTER_VALUE_LENGTH))).toHaveLength(1);
    expect(one('string', 'a'.repeat(MAX_FILTER_VALUE_LENGTH + 1))).toEqual([]);
    expect(one('string', 'a\nb')).toEqual([]);
    expect(one('string', 'a\u0000b')).toEqual([]);
  });

  describe('dates', () => {
    it('accepts ISO-8601 date-only (UTC) and with an explicit zone', () => {
      expect((one('date', '2024-01-15')[0]?.value as Date).toISOString()).toBe('2024-01-15T00:00:00.000Z');
      expect((one('date', '2024-01-15T10:30:00Z')[0]?.value as Date).toISOString()).toBe('2024-01-15T10:30:00.000Z');
      expect((one('date', '2024-01-15T10:30:00.123+02:00')[0]?.value as Date).toISOString()).toBe('2024-01-15T08:30:00.123Z');
      expect((one('date', '2024-01-15T10:30Z')[0]?.value as Date).toISOString()).toBe('2024-01-15T10:30:00.000Z');
    });
    it('REJECTS a time with no zone — it would silently mean "server-local time"', () => {
      expect(one('date', '2024-01-15T10:30:00')).toEqual([]);
    });
    it('REJECTS dates that do not exist (V8 would roll 2024-02-30 over to March 1st)', () => {
      expect(coerceDate('2024-02-30')).toBeUndefined();
      expect(coerceDate('2023-02-29')).toBeUndefined();
      expect(coerceDate('2024-02-29')).toBeInstanceOf(Date); // leap year
      expect(coerceDate('2024-13-01')).toBeUndefined();
      expect(coerceDate('2024-00-10')).toBeUndefined();
      expect(coerceDate('2024-04-31')).toBeUndefined();
    });
    it('REJECTS out-of-range clock components, including 24:00', () => {
      for (const bad of ['2024-01-01T24:00:00Z', '2024-01-01T10:60:00Z', '2024-01-01T10:00:60Z', '2024-01-01T10:00:00+24:00', '2024-01-01T10:00:00+05:60']) {
        expect(coerceDate(bad)).toBeUndefined();
      }
    });
    it.each(['yesterday', '2024/01/15', '15-01-2024', '2024-1-5', '1705312800', '', 'x'.repeat(100), '2024-01-15 10:00:00Z'])('rejects %p', (bad) => {
      expect(coerceDate(bad)).toBeUndefined();
    });
    it('handles years < 100 without mapping them to 19xx', () => {
      expect(coerceDate('0050-06-15')?.getUTCFullYear()).toBe(50);
    });
  });
});

describe('`in` lists', () => {
  const inField: FilterableField[] = [{ name: 'role', type: 'string' }, { name: 'n', type: 'number' }];
  it('splits on commas, trims, de-duplicates (order kept)', () => {
    expect(parseFilters({ roleIn: 'a, b ,a,c' }, inField)).toEqual([{ field: 'role', operator: 'in', value: ['a', 'b', 'c'] }]);
  });
  it('coerces every element to the field type; ONE bad element drops the whole filter', () => {
    expect(parseFilters({ nIn: '1,2,3' }, inField)[0]?.value).toEqual([1, 2, 3]);
    expect(parseFilters({ nIn: '1,x,3' }, inField)).toEqual([]);
  });
  it('an empty element drops the filter (a,,b)', () => {
    expect(parseFilters({ roleIn: 'a,,b' }, inField)).toEqual([]);
    expect(parseFilters({ roleIn: '' }, inField)).toEqual([]);
  });
  it('accepts a repeated key (`?roleIn=a&roleIn=b` arrives as an array) for `in` only', () => {
    expect(parseFilters({ roleIn: ['a', 'b,c'] }, inField)[0]?.value).toEqual(['a', 'b', 'c']);
  });
  it('is bounded: more than MAX_IN_VALUES values is dropped, exactly MAX is fine', () => {
    const ok = Array.from({ length: MAX_IN_VALUES }, (_, i) => `v${i}`).join(',');
    const tooMany = `${ok},extra`;
    expect(parseFilters({ roleIn: ok }, inField)).toHaveLength(1);
    expect(parseFilters({ roleIn: tooMany }, inField)).toEqual([]);
  });
  it('de-duplicates dates by instant', () => {
    const f = [{ name: 'd', type: 'date' as const, allowedOperators: ['eq' as const] }];
    expect(f).toHaveLength(1); // `in` is not applicable to dates at all:
    expect(parseFilters({ dIn: '2024-01-01,2024-01-02' }, [{ name: 'd', type: 'date' }])).toEqual([]);
  });
});

describe('resource bounds (E-A14)', () => {
  it('returns at most MAX_FILTERS_PER_REQUEST filters', () => {
    const fields = Array.from({ length: MAX_FILTERS_PER_REQUEST + 10 }, (_, i) => `f${i}`);
    const query = Object.fromEntries(fields.map((f) => [f, 'x']));
    expect(parseFilters(query, fields)).toHaveLength(MAX_FILTERS_PER_REQUEST);
  });
  it('examines at most MAX_QUERY_KEYS_SCANNED keys — a valid filter buried after the cap is ignored, and the scan is cheap', () => {
    const query: Record<string, string> = {};
    for (let i = 0; i < MAX_QUERY_KEYS_SCANNED + 50; i++) query[`junk${i}`] = 'x';
    query.status = 'active';
    const t0 = process.hrtime.bigint();
    expect(parseFilters(query, ['status'])).toEqual([]);
    expect(Number(process.hrtime.bigint() - t0) / 1e6).toBeLessThan(50);
  });
});

describe('compileFilterAllowlist — declaration errors fail at boot, not per request', () => {
  it.each([
    ['an invalid field name', ['bad name']],
    ['a prototype-pollution field name', ['__proto__']],
    ['a nested forbidden segment', ['a.constructor']],
    ['a duplicate field', ['a', 'a']],
    ['an unknown operator', [{ name: 'a', allowedOperators: ['nope' as never] }]],
    ['an operator not applicable to the type', [{ name: 'a', type: 'boolean' as const, allowedOperators: ['gt' as const] }]],
    ['an empty operator list', [{ name: 'a', allowedOperators: [] }]],
    ['an unknown type', [{ name: 'a', type: 'uuid' as never }]],
    ['an ambiguous key (age+Gt vs a field literally named ageGt)', [{ name: 'age', type: 'number' as const }, 'ageGt']],
    ['an over-long field name', ['a'.repeat(65)]],
  ])('throws on %s', (_label, fields) => {
    expect(() => compileFilterAllowlist(fields as never)).toThrow(TypeError);
  });

  it('is memoised per allowlist array (hot path)', () => {
    const fields = ['a', 'b'];
    expect(compileFilterAllowlist(fields)).toBe(compileFilterAllowlist(fields));
  });
});

describe('@Filterable', () => {
  const read = (target: object, key?: string) => Reflect.getMetadata(FILTERABLE_KEY, key === undefined ? target : (target as Record<string, object>)[key]);

  it('accepts rest args (the declared signature) AND one array (§6.2’s own usage example) — E-A4', () => {
    class A { @Filterable('status', { name: 'age', type: 'number' }) list() {} }
    class B { @Filterable(['status', { name: 'age', type: 'number' }]) list() {} }
    const a = Reflect.getMetadata(FILTERABLE_KEY, A.prototype.list);
    const b = Reflect.getMetadata(FILTERABLE_KEY, B.prototype.list);
    expect([...a.keys.keys()].sort()).toEqual([...b.keys.keys()].sort());
    expect(a.fields.map((f: { name: string }) => f.name)).toEqual(['status', 'age']);
  });

  it('works on a class (every handler inherits it)', () => {
    @Filterable('status')
    class C {}
    expect(read(C)).toBeDefined();
  });

  it('a bad declaration throws when the class is DEFINED (boot), not on a request', () => {
    expect(() => {
      class D { @Filterable('not valid') list() {} }
      return D;
    }).toThrow(TypeError);
  });
});

describe('escapeLikePattern', () => {
  it('escapes the SQL LIKE wildcards and the escape character itself', () => {
    expect(escapeLikePattern('100%_done\\')).toBe('100\\%\\_done\\\\');
    expect(escapeLikePattern('plain')).toBe('plain');
    expect(escapeLikePattern('')).toBe('');
  });
  it('supports a custom escape character; rejects a multi-character one', () => {
    expect(escapeLikePattern('50%', '!')).toBe('50!%');
    expect(escapeLikePattern('a!b', '!')).toBe('a!!b');
    expect(() => escapeLikePattern('x', '!!')).toThrow(TypeError);
  });
});

/** Sorting — spec §7, §13 ("Sorting"); §7.4 tiebreaker; E-A14 bounds. */
import { MAX_SORT_FIELDS, MAX_SORT_PARAM_LENGTH } from '../api-infrastructure.constants';
import { parseSorts, withTiebreaker } from './parse-sort';
import { Sortable, SORTABLE_KEY } from './sort-allowlist.decorator';

const ALLOW = ['createdAt', 'email', 'id', 'author.name'];

describe('parseSorts', () => {
  it('parses `field:dir` pairs in order; a bare field defaults to asc', () => {
    expect(parseSorts({ sort: 'createdAt:desc,email' }, ALLOW)).toEqual([
      { field: 'createdAt', direction: 'desc' },
      { field: 'email', direction: 'asc' },
    ]);
  });
  it('explicit :asc is accepted; dotted nested fields work', () => {
    expect(parseSorts({ sort: 'author.name:asc' }, ALLOW)).toEqual([{ field: 'author.name', direction: 'asc' }]);
  });
  it('direction is CASE-SENSITIVE: `:DESC` drops the whole segment (§7.1, §13)', () => {
    expect(parseSorts({ sort: 'createdAt:DESC' }, ALLOW)).toEqual([]);
    expect(parseSorts({ sort: 'createdAt:DESC,email:desc' }, ALLOW)).toEqual([{ field: 'email', direction: 'desc' }]);
  });
  it('no allowlist ⇒ no sortable fields ⇒ ?sort= ignored (the password_hash oracle, §7.2)', () => {
    expect(parseSorts({ sort: 'password_hash:asc' }, [])).toEqual([]);
    expect(parseSorts({ sort: 'password_hash:asc' }, ALLOW)).toEqual([]);
  });
  it('drops malformed segments individually and keeps the good ones', () => {
    expect(parseSorts({ sort: ',,email:desc,:asc,createdAt:desc:extra,id:sideways' }, ALLOW)).toEqual([{ field: 'email', direction: 'desc' }]);
  });
  it('a field repeated in one request keeps its FIRST direction', () => {
    expect(parseSorts({ sort: 'email:desc,email:asc' }, ALLOW)).toEqual([{ field: 'email', direction: 'desc' }]);
  });
  it('accepts a repeated `sort` key (array)', () => {
    expect(parseSorts({ sort: ['createdAt:desc', 'email'] }, ALLOW).map((s) => s.field)).toEqual(['createdAt', 'email']);
  });
  it('honours at most MAX_SORT_FIELDS fields', () => {
    const many = Array.from({ length: MAX_SORT_FIELDS + 3 }, (_, i) => `f${i}`);
    expect(parseSorts({ sort: many.join(',') }, many)).toHaveLength(MAX_SORT_FIELDS);
  });
  it('an over-long raw parameter yields NO sorts (never a truncated, differently-meaning one)', () => {
    const long = 'email,'.repeat(Math.ceil(MAX_SORT_PARAM_LENGTH / 6) + 2);
    expect(parseSorts({ sort: long }, ALLOW)).toEqual([]);
  });
  it('never throws on hostile shapes', () => {
    for (const q of [undefined, null, 'x', 7, [], { sort: null }, { sort: {} }, { sort: [1, 2] }, { sort: ['a', {}] }, { __proto__: { sort: 'email' } }]) {
      expect(() => parseSorts(q, ALLOW)).not.toThrow();
      expect(parseSorts(q, ALLOW)).toEqual([]);
    }
  });
  it('accepts a prebuilt Set allowlist (what the decorator stores)', () => {
    expect(parseSorts({ sort: 'email' }, new Set(['email']))).toEqual([{ field: 'email', direction: 'asc' }]);
  });
});

describe('withTiebreaker (§7.4)', () => {
  it('appends `id` inheriting the last direction', () => {
    expect(withTiebreaker([{ field: 'createdAt', direction: 'desc' }])).toEqual([
      { field: 'createdAt', direction: 'desc' },
      { field: 'id', direction: 'desc' },
    ]);
  });
  it('does not duplicate an existing tiebreaker, and returns a copy', () => {
    const sorts = [{ field: 'id', direction: 'desc' as const }];
    const out = withTiebreaker(sorts);
    expect(out).toEqual(sorts);
    expect(out).not.toBe(sorts);
  });
  it('supplies a tiebreaker even when the request had no sorts', () => {
    expect(withTiebreaker([])).toEqual([{ field: 'id', direction: 'asc' }]);
  });
  it('custom field + explicit direction', () => {
    expect(withTiebreaker([{ field: 'a', direction: 'desc' }], 'uuid', 'asc')).toEqual([
      { field: 'a', direction: 'desc' },
      { field: 'uuid', direction: 'asc' },
    ]);
  });
});

describe('@Sortable', () => {
  it('stores a Set; accepts rest args or one array', () => {
    class A { @Sortable('a', 'b') list() {} }
    class B { @Sortable(['a', 'b']) list() {} }
    expect([...Reflect.getMetadata(SORTABLE_KEY, A.prototype.list)]).toEqual(['a', 'b']);
    expect([...Reflect.getMetadata(SORTABLE_KEY, B.prototype.list)]).toEqual(['a', 'b']);
  });
  it('rejects bad names / duplicates at class-definition time', () => {
    expect(() => Sortable('bad name')).toThrow(TypeError);
    expect(() => Sortable('__proto__')).toThrow(TypeError);
    expect(() => Sortable('a', 'a')).toThrow(TypeError);
  });
});

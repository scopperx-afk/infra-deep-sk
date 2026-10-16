import { resetSecurityRuntime, configureSecurityRuntime, SECURE_RUNTIME_DEFAULTS } from '../runtime/security-runtime';
import { checkJsonDepth } from './json-depth.util';
import { isPrototypeSafe, safeMerge, sanitizeObjectKeys } from './prototype-pollution.util';
import { hasDangerousStructure, isRegexSafe, safeRegex } from './redos.util';

afterEach(() => resetSecurityRuntime());

const nested = (depth: number): unknown => {
  let o: unknown = 1;
  for (let i = 0; i < depth; i++) o = { a: o };
  return o;
};

describe('prototype pollution (§14)', () => {
  const evil = JSON.parse('{"a":1,"__proto__":{"isAdmin":true},"n":{"constructor":{"prototype":{"x":1}}}}');

  it('detects dangerous own keys at any depth, including a parsed __proto__', () => {
    expect(isPrototypeSafe(evil)).toBe(false);
    expect(isPrototypeSafe({ n: { constructor: 1 } })).toBe(false);
    expect(isPrototypeSafe({ a: [{ b: 1 }], c: 'x' })).toBe(true);
    expect(isPrototypeSafe(null)).toBe(true);
    expect(isPrototypeSafe('str')).toBe(true);
  });

  it('a __proto__ payload merged through safeMerge never touches Object.prototype', () => {
    const target: Record<string, unknown> = { keep: 1 };
    safeMerge(target, evil, JSON.parse('{"n":{"deep":{"__proto__":{"y":1},"ok":1}}}'));
    expect(({} as Record<string, unknown>)['isAdmin']).toBeUndefined();
    expect(({} as Record<string, unknown>)['x']).toBeUndefined();
    expect(({} as Record<string, unknown>)['y']).toBeUndefined();
    expect(target['a']).toBe(1);
    expect(target['keep']).toBe(1);
    expect(isPrototypeSafe(target)).toBe(true);
  });

  it('deep-merges plain objects and sanitises arrays of objects', () => {
    const t: Record<string, any> = {};
    safeMerge(t, JSON.parse('{"a":{"b":1}}'), JSON.parse('{"a":{"c":2},"list":[{"__proto__":{"z":1},"ok":1}]}'));
    expect(t['a']).toEqual({ b: 1, c: 2 });
    expect(t['list'][0]['ok']).toBe(1);
    expect(isPrototypeSafe(t)).toBe(true);
  });

  it('sanitizeObjectKeys strips by default (stripPrototypeKeys=true) without mutating the input', () => {
    const cleaned = sanitizeObjectKeys(evil) as Record<string, unknown>;
    expect(isPrototypeSafe(cleaned)).toBe(true);
    expect(cleaned['a']).toBe(1);
    expect(isPrototypeSafe(evil)).toBe(false);
  });

  it('rejects with 400 instead when stripPrototypeKeys=false (option or configured default)', () => {
    expect(() => sanitizeObjectKeys(evil, { strip: false })).toThrow('forbidden key');
    expect(sanitizeObjectKeys({ a: 1 }, { strip: false })).toEqual({ a: 1 });
    configureSecurityRuntime({ ...SECURE_RUNTIME_DEFAULTS, injection: { ...SECURE_RUNTIME_DEFAULTS.injection, stripPrototypeKeys: false } });
    expect(() => sanitizeObjectKeys(evil)).toThrow('forbidden key');
  });

  it('a 5000-level payload cannot overflow the stack (iterative traversal) and is rejected', () => {
    const deep = nested(5000);
    expect(isPrototypeSafe(deep)).toBe(false);
    expect(() => safeMerge({}, deep as object)).toThrow('maximum depth');
  });
});

describe('checkJsonDepth (§14)', () => {
  it('accepts up to the default 20 levels and rejects a 30-level-deep payload', () => {
    expect(() => checkJsonDepth(nested(20))).not.toThrow();
    expect(() => checkJsonDepth(nested(21))).toThrow('maximum depth of 20');
    expect(() => checkJsonDepth(nested(30))).toThrow('maximum depth');
  });
  it('is stack-safe on hostile depth and terminates on cycles', () => {
    expect(() => checkJsonDepth(nested(100_000))).toThrow('maximum depth');
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => checkJsonDepth(cyclic)).toThrow('maximum depth');
  });
  it('honours an explicit maximum and the configured default; counts arrays', () => {
    expect(() => checkJsonDepth(nested(3), 3)).not.toThrow();
    expect(() => checkJsonDepth(nested(4), 3)).toThrow();
    expect(() => checkJsonDepth([[[1]]], 3)).not.toThrow();
    expect(() => checkJsonDepth([[[[1]]]], 3)).toThrow();
    configureSecurityRuntime({ ...SECURE_RUNTIME_DEFAULTS, injection: { ...SECURE_RUNTIME_DEFAULTS.injection, maxJsonDepth: 2 } });
    expect(() => checkJsonDepth(nested(3))).toThrow('maximum depth of 2');
  });
  it('scalars and null are always fine; a bad maximum is a programming error', () => {
    expect(() => { checkJsonDepth(5); checkJsonDepth(null); checkJsonDepth('s'); }).not.toThrow();
    expect(() => checkJsonDepth({}, 0)).toThrow(RangeError);
  });
});

describe('ReDoS (§14)', () => {
  it('a catastrophic-backtracking pattern is rejected by isRegexSafe within its timeout', () => {
    const started = Date.now();
    expect(isRegexSafe(/(a+)+$/, 100)).toBe(false);
    expect(isRegexSafe(/^(a|aa)+$/, 100)).toBe(false);
    expect(isRegexSafe(/(x+x+)+y/, 100)).toBe(false); // caught by the dynamic probe, not the static scan
    expect(Date.now() - started).toBeLessThan(5000);
  });
  it('the static scan flags the classic exponential shapes and spares ordinary patterns', () => {
    for (const p of ['(a+)+$', '(a*)*b', '(\\w+\\s?)*$', '(a|a)*$', '(a|ab)+c', '(.*a){10,}', '^(([a-z])+.)+[A-Z]([a-z])+$']) {
      expect(hasDangerousStructure(p)).toBe(true);
    }
    for (const p of ['^[a-z0-9_]{3,16}$', '^\\d{3}-\\d{4}$', '^(foo|bar)+$', '(?:ab)+c', '^[^@\\s]+@[^@\\s]+\\.[a-z]{2,}$', 'hello (world|there)', '^(\\d+)\\.(\\d+)$']) {
      expect(hasDangerousStructure(p)).toBe(false);
    }
  });
  it('accepts safe patterns', () => {
    expect(isRegexSafe(/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i, 100)).toBe(true);
    expect(isRegexSafe(/^[a-z0-9_]{3,16}$/, 100)).toBe(true);
  });
  it('safeRegex compiles good patterns (with flags) and rejects evil, invalid, empty and oversized ones', () => {
    expect(safeRegex('^abc$', 'i').test('ABC')).toBe(true);
    expect(() => safeRegex('(a+)+$')).toThrow('catastrophic');
    expect(() => safeRegex('(unclosed')).toThrow();
    expect(() => safeRegex('')).toThrow();
    expect(() => safeRegex('a'.repeat(2000))).toThrow();
    expect(isRegexSafe('x' as never)).toBe(false);
  });
});

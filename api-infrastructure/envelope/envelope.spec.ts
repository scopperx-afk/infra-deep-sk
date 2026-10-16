/** Builders, drafts and wrapInEnvelope — spec §4.1, §4.4, §4.6; E-A1, E-A5, E-A16. */
import { buildCursorPage, buildEmpty, buildOffsetPage, buildPartialSuccess, buildSuccess } from './builders';
import { isEnvelopeDraft, makeDraft } from './envelope-draft';
import { wrapInEnvelope } from './wrap-envelope';

const BASE = { timestamp: '2026-01-01T00:00:00.000Z', apiVersion: 'v1', correlationId: 'c1' };

describe('wrapInEnvelope — plain values are `data` (E-A1)', () => {
  it.each([
    ['an object', { id: 1 }, { id: 1 }],
    ['an array', [1, 2], [1, 2]],
    ['a string', 'hi', 'hi'],
    ['a number', 0, 0],
    ['false', false, false],
    ['an empty string', '', ''],
    ['null', null, null],
    ['undefined (a void handler) — "data is present on every successful response, even when null" (§4.1)', undefined, null],
  ])('%s', (_label, input, expected) => {
    expect(wrapInEnvelope(input, BASE)).toEqual({ data: expected, meta: BASE });
  });

  it('NEVER misreads a payload that merely LOOKS like an envelope (the structural-detection bug E-A1 fixes)', () => {
    const payload = { data: [1, 2, 3], total: 3, meta: { x: 1 }, errors: ['e'] };
    expect(wrapInEnvelope(payload, BASE)).toEqual({ data: payload, meta: BASE });
  });

  it('does not mutate the input nor alias the base meta object into later calls', () => {
    const input = Object.freeze({ a: 1 });
    const out1 = wrapInEnvelope(input, BASE);
    const out2 = wrapInEnvelope(input, BASE);
    expect(out1.data).toBe(input);
    expect(out1).not.toBe(out2);
  });

  it('omits `errors` entirely for ordinary success (never `errors: []`, never null — §4.1)', () => {
    expect('errors' in wrapInEnvelope({ a: 1 }, BASE)).toBe(false);
  });
});

describe('builders → drafts', () => {
  it('buildSuccess carries data + extra meta; the brand is invisible on the wire', () => {
    const draft = buildSuccess({ id: 1 }, { requestedBy: 'u-1' });
    expect(isEnvelopeDraft(draft)).toBe(true);
    expect(JSON.parse(JSON.stringify(draft))).toEqual({ data: { id: 1 }, meta: { requestedBy: 'u-1' } });
    expect(Object.keys(draft)).toEqual(['data', 'meta']); // the brand is non-enumerable
    expect(Object.getOwnPropertySymbols(draft)).toHaveLength(1); // …but present, for isEnvelopeDraft
    // The brand is deliberately NOT copied by a spread: a copy is plain data, never silently re-recognised.
    expect(isEnvelopeDraft({ ...draft })).toBe(false);
  });

  it('a hand-forged lookalike is NOT a draft', () => {
    expect(isEnvelopeDraft({ data: 1, meta: {} })).toBe(false);
    expect(isEnvelopeDraft(null)).toBe(false);
    expect(isEnvelopeDraft('x')).toBe(false);
    expect(isEnvelopeDraft(undefined)).toBe(false);
  });

  it('drafts are immutable (a later mutation cannot corrupt a response already handed to the interceptor)', () => {
    const draft = buildSuccess({ a: 1 }, { k: 1 });
    expect(Object.isFrozen(draft)).toBe(true);
    expect(Object.isFrozen(draft.meta)).toBe(true);
    expect(() => {
      (draft as unknown as { data: unknown }).data = 2;
    }).toThrow(TypeError);
  });

  it('buildEmpty ⇒ data null', () => {
    expect(wrapInEnvelope(buildEmpty(), BASE)).toEqual({ data: null, meta: BASE });
  });

  it('buildPartialSuccess carries errors; an EMPTY errors list yields no `errors` key', () => {
    const out = wrapInEnvelope(buildPartialSuccess([1], [{ index: 1, code: 'E', message: 'bad' }]), BASE);
    expect(out.errors).toEqual([{ index: 1, code: 'E', message: 'bad' }]);
    expect('errors' in wrapInEnvelope(buildPartialSuccess([1], []), BASE)).toBe(false);
  });

  it('buildCursorPage ⇒ data is the items, meta.pagination is the cursor meta', () => {
    const out = wrapInEnvelope(buildCursorPage({ items: [{ id: 1 }], hasMore: true, nextCursor: 'n' }, 20), BASE);
    expect(out).toEqual({ data: [{ id: 1 }], meta: { ...BASE, pagination: { hasMore: true, limit: 20, nextCursor: 'n' } } });
  });

  it('buildOffsetPage ⇒ offset meta with total/totalPages when known', () => {
    const out = wrapInEnvelope(buildOffsetPage({ items: ['a'], page: 2, limit: 10, hasMore: false, total: 11 }), BASE);
    expect(out.meta.pagination).toEqual({ page: 2, limit: 10, hasMore: false, total: 11, totalPages: 2 });
  });

  it('makeDraft(undefined) ⇒ data null', () => {
    expect(wrapInEnvelope(makeDraft(undefined, undefined), BASE).data).toBeNull();
  });
});

describe('meta merge — reserved keys belong to the interceptor (E-A5)', () => {
  it('the domain cannot override timestamp / apiVersion / correlationId', () => {
    const out = wrapInEnvelope(buildSuccess(1, { timestamp: 'FORGED', apiVersion: 'v99', correlationId: 'FORGED', note: 'kept' }), BASE);
    expect(out.meta).toEqual({ ...BASE, note: 'kept' });
  });

  it('a draft’s meta never injects a correlationId when the interceptor had none (header and body must agree)', () => {
    const out = wrapInEnvelope(buildSuccess(1, { correlationId: 'FORGED' }), { apiVersion: 'v1' });
    expect(out.meta).toEqual({ apiVersion: 'v1' });
  });

  it('prototype-shaped keys are never copied', () => {
    const evil = JSON.parse('{"__proto__":{"polluted":true},"constructor":1,"prototype":2,"ok":1}') as Record<string, unknown>;
    const out = wrapInEnvelope(buildSuccess(1, evil), BASE);
    expect(out.meta.ok).toBe(1);
    expect(Object.keys(out.meta)).not.toContain('constructor');
    expect(Object.keys(out.meta)).not.toContain('prototype');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(out.meta)).toBe(Object.prototype);
  });

  it('timestamp/apiVersion are optional in the type AND absent in the output when the interceptor omitted them (E-A16)', () => {
    expect(wrapInEnvelope({ a: 1 }, {})).toEqual({ data: { a: 1 }, meta: {} });
  });
});

/** Pagination request schemas — spec §5.3, §13; E-A2 (Config-driven bounds). */
import { z, ZodError } from 'zod';
import { withApiRuntime } from '../testing/with-api-runtime';
import { CursorPaginationSchema, OffsetPaginationSchema } from './schemas';

const issuesOf = (fn: () => unknown): { path: string; message: string }[] => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ZodError) return e.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw e;
  }
  throw new Error('expected a ZodError');
};

describe('CursorPaginationSchema', () => {
  it('applies the configured default when limit is omitted', () => {
    expect(CursorPaginationSchema.parse({})).toEqual({ limit: 20 });
    withApiRuntime({ pagination: { defaultLimit: 50 } }, () => expect(CursorPaginationSchema.parse({}).limit).toBe(50));
  });

  it('coerces a decimal-digit string and accepts a number', () => {
    expect(CursorPaginationSchema.parse({ limit: '15' }).limit).toBe(15);
    expect(CursorPaginationSchema.parse({ limit: 15 }).limit).toBe(15);
  });

  it('keeps the cursor string untouched (decoding is decodeCursor()’s job, never a 400 here — §5.1.3)', () => {
    expect(CursorPaginationSchema.parse({ cursor: 'garbage!!' }).cursor).toBe('garbage!!');
  });

  it('REJECTS (never clamps) a limit above api.pagination.maxLimit — §5.3', () => {
    expect(issuesOf(() => CursorPaginationSchema.parse({ limit: '200' }))).toEqual([
      { path: 'limit', message: 'limit must be between 1 and 100' },
    ]);
    withApiRuntime({ pagination: { maxLimit: 500 } }, () => expect(CursorPaginationSchema.parse({ limit: '200' }).limit).toBe(200));
  });

  it('the maximum itself is accepted, one over is not (boundary)', () => {
    expect(CursorPaginationSchema.parse({ limit: '100' }).limit).toBe(100);
    expect(() => CursorPaginationSchema.parse({ limit: '101' })).toThrow(ZodError);
  });

  it.each([['0'], ['-1'], [0], [-5]])('rejects a non-positive limit (%p)', (limit) => {
    expect(() => CursorPaginationSchema.parse({ limit })).toThrow(ZodError);
  });

  it.each([['1.5'], [1.5], ['abc'], [''], ['1e2'], ['0x10'], [' 5'], ['5 '], ['+5'], ['007x'], ['１２'], [Number.NaN], [Infinity], ['9999999999'], [null], [true], [{}], [['1', '2']]])(
    'rejects a non-integer / oddly-spelled limit (%p) with a clean message — no JavaScript lenient-number aliasing',
    (limit) => {
      const issues = issuesOf(() => CursorPaginationSchema.parse({ limit }));
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({ path: 'limit', message: 'limit must be a positive integer' });
    },
  );

  it('is .extend()-able (§5.3’s own example) and keeps the config-driven limit', () => {
    const ListSessionsSchema = CursorPaginationSchema.extend({
      unreadOnly: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
    });
    expect(ListSessionsSchema.parse({ unreadOnly: 'true' })).toEqual({ limit: 20, unreadOnly: true });
    expect(() => ListSessionsSchema.parse({ limit: '1000' })).toThrow(ZodError);
  });
});

describe('OffsetPaginationSchema', () => {
  it('defaults: page 1, default limit, includeTotal false', () => {
    expect(OffsetPaginationSchema.parse({})).toEqual({ page: 1, limit: 20, includeTotal: false });
  });

  it('includeTotal: only the literal strings "true"/"false" — and "false" is FALSE (Validation spec §6 coerce.boolean footgun)', () => {
    expect(OffsetPaginationSchema.parse({ includeTotal: 'false' }).includeTotal).toBe(false);
    expect(OffsetPaginationSchema.parse({ includeTotal: 'true' }).includeTotal).toBe(true);
    for (const bad of ['1', 'yes', 'TRUE', true, 1]) {
      expect(() => OffsetPaginationSchema.parse({ includeTotal: bad })).toThrow(ZodError);
    }
  });

  it.each([['0'], ['-1'], [0], ['abc'], ['1.5']])('rejects page %p', (page) => {
    expect(issuesOf(() => OffsetPaginationSchema.parse({ page }))[0]).toMatchObject({ path: 'page' });
  });

  it('caps page at api.pagination.maxPage (deep-offset DoS guard)', () => {
    expect(OffsetPaginationSchema.parse({ page: '1000' }).page).toBe(1000);
    expect(issuesOf(() => OffsetPaginationSchema.parse({ page: '1001' }))).toEqual([
      { path: 'page', message: 'page must be between 1 and 1000' },
    ]);
    withApiRuntime({ pagination: { maxPage: 5 } }, () => expect(() => OffsetPaginationSchema.parse({ page: '6' })).toThrow(ZodError));
  });

  it('reports BOTH page and limit violations at once (every error, not one at a time)', () => {
    const issues = issuesOf(() => OffsetPaginationSchema.parse({ page: '0', limit: '9999' }));
    expect(issues.map((i) => i.path).sort()).toEqual(['limit', 'page']);
  });
});

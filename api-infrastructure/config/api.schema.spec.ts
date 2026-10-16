/** `api.*` Config namespace — spec §11, Config §13.20; E-A2/E-A13 additions. */
import { apiConfigSchema } from './api.schema';

describe('apiConfigSchema', () => {
  it('defaults equal Config §13.20 exactly (and the two additions)', () => {
    expect(apiConfigSchema.parse({})).toEqual({
      version: 'v1',
      pagination: { defaultLimit: 20, maxLimit: 100, maxPage: 1000 },
      envelope: { enabled: true, includeTimestamp: true, includeApiVersion: true, includeCorrelationId: true },
      cursor: {},
    });
  });

  it('accepts env-style strings (everything arrives as a string) and boolean words', () => {
    const cfg = apiConfigSchema.parse({
      version: 'v2',
      pagination: { defaultLimit: '10', maxLimit: '50', maxPage: '20' },
      envelope: { enabled: 'false', includeTimestamp: 'false' },
    });
    expect(cfg.version).toBe('v2');
    expect(cfg.pagination).toEqual({ defaultLimit: 10, maxLimit: 50, maxPage: 20 });
    expect(cfg.envelope.enabled).toBe(false);
    expect(cfg.envelope.includeTimestamp).toBe(false);
    expect(cfg.envelope.includeApiVersion).toBe(true);
  });

  it.each([['V1'], ['1'], ['v'], ['version1'], ['v1.0']])('rejects api.version %p', (version) => {
    expect(apiConfigSchema.safeParse({ version }).success).toBe(false);
  });

  describe('pagination bounds', () => {
    it('defaultLimit must not exceed maxLimit — otherwise omitting ?limit= would itself be rejected', () => {
      const r = apiConfigSchema.safeParse({ pagination: { defaultLimit: '60', maxLimit: '50' } });
      expect(r.success).toBe(false);
      expect(r.error?.issues[0]).toMatchObject({ path: ['pagination', 'defaultLimit'] });
    });
    it('a lowered maxLimit with the DEFAULT defaultLimit (20) is validated too', () => {
      expect(apiConfigSchema.safeParse({ pagination: { maxLimit: '10' } }).success).toBe(false);
      expect(apiConfigSchema.safeParse({ pagination: { maxLimit: '20' } }).success).toBe(true);
    });
    it('maxLimit has a HARD ceiling Config can never lift (1000)', () => {
      expect(apiConfigSchema.safeParse({ pagination: { maxLimit: '1000' } }).success).toBe(true);
      expect(apiConfigSchema.safeParse({ pagination: { maxLimit: '1001' } }).success).toBe(false);
      expect(apiConfigSchema.safeParse({ pagination: { maxLimit: '100000' } }).success).toBe(false);
    });
    it.each([['0'], ['-5'], ['1.5'], ['abc']])('rejects limit value %p', (v) => {
      expect(apiConfigSchema.safeParse({ pagination: { defaultLimit: v } }).success).toBe(false);
      expect(apiConfigSchema.safeParse({ pagination: { maxLimit: v } }).success).toBe(false);
    });
    it('maxPage is bounded to [1, 100000]', () => {
      expect(apiConfigSchema.safeParse({ pagination: { maxPage: '100000' } }).success).toBe(true);
      expect(apiConfigSchema.safeParse({ pagination: { maxPage: '100001' } }).success).toBe(false);
      expect(apiConfigSchema.safeParse({ pagination: { maxPage: '0' } }).success).toBe(false);
    });
  });

  describe('cursor.signingKeys', () => {
    const k = (n: number, c = 'x') => c.repeat(n);
    it('is optional; a CSV of keys (newest first) parses to an array', () => {
      expect(apiConfigSchema.parse({ cursor: { signingKeys: `${k(32)}, ${k(40, 'y')}` } }).cursor.signingKeys).toEqual([k(32), k(40, 'y')]);
    });
    it('every key must be at least 32 characters', () => {
      const r = apiConfigSchema.safeParse({ cursor: { signingKeys: `${k(32)},short` } });
      expect(r.success).toBe(false);
      expect(r.error?.issues[0]?.message).toMatch(/at least 32/);
    });
  });
});

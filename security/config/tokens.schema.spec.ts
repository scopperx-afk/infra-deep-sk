import { tokensConfigSchema } from './tokens.schema';

const S = (c: string): string => c.repeat(40);
const profile = (over: Record<string, unknown> = {}) => ({
  name: 'default', secretRef: S('a'), refreshSecretRef: S('b'), issuer: 'api', audience: 'app', accessTtl: '900s', refreshTtl: '30d', ...over,
});
const parse = (profiles: unknown) => tokensConfigSchema.safeParse({ profiles: typeof profiles === 'string' ? profiles : JSON.stringify(profiles) });

describe('tokensConfigSchema (§5.1, Config §13.7)', () => {
  it('parses the TOKENS__PROFILES JSON blob; TTLs become seconds', () => {
    const r = parse([profile(), profile({ name: 'admin', secretRef: S('c'), refreshSecretRef: S('d'), refreshTtl: '7d' })]);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.profiles).toHaveLength(2);
    expect(r.data.profiles[0]).toMatchObject({ name: 'default', accessTtl: 900, refreshTtl: 2_592_000, issuer: 'api', audience: 'app' });
    expect(r.data.profiles[1]?.refreshTtl).toBe(604_800);
  });

  it('refresh secret, issuer, audience and TTLs are optional', () => {
    expect(parse([{ name: 'minimal', secretRef: S('a') }]).success).toBe(true);
  });

  it('requires at least one profile', () => {
    expect(parse([]).success).toBe(false);
    expect(parse('').success).toBe(false);
    expect(tokensConfigSchema.safeParse({}).success).toBe(false);
  });

  it('rejects duplicate profile names', () => {
    const r = parse([profile(), profile({ secretRef: S('c'), refreshSecretRef: S('d') })]);
    expect(r.success).toBe(false);
  });

  it('rejects a short HS256 secret and an invalid profile name', () => {
    expect(parse([profile({ secretRef: 'short' })]).success).toBe(false);
    expect(parse([profile({ name: '1bad' })]).success).toBe(false);
    expect(parse([profile({ name: 'has space' })]).success).toBe(false);
  });

  it('every secret across all profiles must be pairwise distinct (a refresh token must never verify as an access token)', () => {
    expect(parse([profile({ refreshSecretRef: S('a') })]).success).toBe(false); // refresh == own access
    expect(parse([profile(), profile({ name: 'admin', secretRef: S('a'), refreshSecretRef: S('d') })]).success).toBe(false); // reuse across profiles
    expect(parse([profile(), profile({ name: 'admin', secretRef: S('c'), refreshSecretRef: S('b') })]).success).toBe(false); // refresh reused across profiles
  });

  it('malformed JSON fails WITHOUT echoing its content (it may be a secret)', () => {
    const r = parse(`[{"name":"x","secretRef":"LEAKME-${S('z')}"`);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).not.toContain('LEAKME');
  });

  it('rejects a non-array JSON value and malformed durations', () => {
    expect(parse('{"name":"x"}').success).toBe(false);
    expect(parse([profile({ accessTtl: 'soon' })]).success).toBe(false);
    expect(parse([profile({ accessTtl: 900 })]).success).toBe(false); // durations are strings like "900s"
  });
});

import { randomToken } from '../crypto/random.util';
import { CSRF_TOKEN_RE, CsrfTokenMiddleware } from '../csrf/csrf-token.middleware';
import { configureSecurityRuntime, resetSecurityRuntime, SECURE_RUNTIME_DEFAULTS } from '../runtime/security-runtime';
import { defaultSecurityConfig, fakeConfigService, fakeResponse } from '../testing/security-test-utils';
import { parseCookieHeader, readCookie } from './cookie-reader.util';
import { clearSecureCookie, setHostCookie, setSecureCookie, setSecurePrefixedCookie } from './secure-cookie.util';

afterEach(() => resetSecurityRuntime());

describe('setSecureCookie (§11)', () => {
  it('in production carries Secure / HttpOnly / SameSite and Path=/', () => {
    const res = fakeResponse();
    setSecureCookie(res as never, 'sid', 'v');
    expect(res.cookies[0]).toEqual({ name: 'sid', value: 'v', options: { httpOnly: true, secure: true, sameSite: 'lax', path: '/' } });
  });

  it('defaults come from Config via the runtime holder; explicit options win', () => {
    configureSecurityRuntime({ ...SECURE_RUNTIME_DEFAULTS, cookies: { defaultSameSite: 'strict', defaultSecure: false } });
    const res = fakeResponse();
    setSecureCookie(res as never, 'a', '1');
    setSecureCookie(res as never, 'b', '2', { secure: true, sameSite: 'none', httpOnly: false });
    expect(res.cookies[0]?.options).toMatchObject({ secure: false, sameSite: 'strict', httpOnly: true });
    expect(res.cookies[1]?.options).toMatchObject({ secure: true, sameSite: 'none', httpOnly: false });
  });

  it('maxAge is SECONDS (converted for Express) and capped at 400 days', () => {
    const res = fakeResponse();
    setSecureCookie(res as never, 'a', '1', { maxAge: 60 });
    expect(res.cookies[0]?.options['maxAge']).toBe(60_000);
    expect(() => setSecureCookie(res as never, 'a', '1', { maxAge: 34_560_001 })).toThrow(RangeError);
    expect(() => setSecureCookie(res as never, 'a', '1', { maxAge: -1 })).toThrow(RangeError);
  });

  it('rejects invalid names/paths/domains and SameSite=None without Secure', () => {
    const res = fakeResponse();
    expect(() => setSecureCookie(res as never, 'bad name', '1')).toThrow(TypeError);
    expect(() => setSecureCookie(res as never, 'a;b', '1')).toThrow(TypeError);
    expect(() => setSecureCookie(res as never, 'a', '1', { path: '/x; Domain=evil.com' })).toThrow(TypeError);
    expect(() => setSecureCookie(res as never, 'a', '1', { domain: 'a.com; Secure' })).toThrow(TypeError);
    expect(() => setSecureCookie(res as never, 'a', '1', { sameSite: 'none', secure: false })).toThrow('requires Secure');
  });

  it('enforces name-prefix constraints even on the generic entry point', () => {
    const res = fakeResponse();
    expect(() => setSecureCookie(res as never, '__Host-sid', '1', { secure: false })).toThrow('Secure');
    expect(() => setSecureCookie(res as never, '__Host-sid', '1', { domain: 'a.com' })).toThrow('Domain');
    expect(() => setSecureCookie(res as never, '__Host-sid', '1', { path: '/app' })).toThrow('Path=/');
    expect(() => setSecureCookie(res as never, '__Secure-sid', '1', { secure: false })).toThrow('Secure');
  });
});

describe('setHostCookie / setSecurePrefixedCookie (§11)', () => {
  it('setHostCookie adds __Host-, forces Secure, Path=/, no Domain', () => {
    const res = fakeResponse();
    setHostCookie(res as never, 'sid', 'v');
    expect(res.cookies[0]?.name).toBe('__Host-sid');
    expect(res.cookies[0]?.options).toMatchObject({ secure: true, path: '/' });
    expect(res.cookies[0]?.options['domain']).toBeUndefined();
    setHostCookie(res as never, '__Host-already', 'v');
    expect(res.cookies[1]?.name).toBe('__Host-already');
  });
  it('setHostCookie with a Domain attribute THROWS (as does a non-root path or secure:false)', () => {
    const res = fakeResponse();
    expect(() => setHostCookie(res as never, 'sid', 'v', { domain: 'example.com' })).toThrow('Domain');
    expect(() => setHostCookie(res as never, 'sid', 'v', { path: '/x' })).toThrow('Path=/');
    expect(() => setHostCookie(res as never, 'sid', 'v', { secure: false })).toThrow('Secure');
  });
  it('setSecurePrefixedCookie adds __Secure- and forces Secure', () => {
    const res = fakeResponse();
    setSecurePrefixedCookie(res as never, 'sid', 'v', { domain: 'example.com' });
    expect(res.cookies[0]).toMatchObject({ name: '__Secure-sid', options: { secure: true, domain: 'example.com' } });
    expect(() => setSecurePrefixedCookie(res as never, 'sid', 'v', { secure: false })).toThrow('Secure');
  });
});

describe('clearSecureCookie', () => {
  it('clears with the matching path/domain; prefixed names are cleared with Secure', () => {
    const res = fakeResponse();
    clearSecureCookie(res as never, 'sid', { path: '/app', domain: 'example.com' });
    clearSecureCookie(res as never, '__Host-sid');
    expect(res.cleared[0]).toEqual({ name: 'sid', options: { path: '/app', domain: 'example.com' } });
    expect(res.cleared[1]).toEqual({ name: '__Host-sid', options: { path: '/', secure: true } });
    expect(() => clearSecureCookie(res as never, '__Host-sid', { domain: 'a.com' })).toThrow(TypeError);
  });
});

describe('cookie reader (no cookie-parser in the pipeline)', () => {
  it('parses a Cookie header: first wins, percent-decoding, quotes, bounded, prototype-safe', () => {
    const jar = parseCookieHeader('a=1; b=hello%20world; a=2; c="q"; __proto__=x; bad name=y; =z; noval');
    expect(jar.get('a')).toBe('1');
    expect(jar.get('b')).toBe('hello world');
    expect(jar.get('c')).toBe('q');
    expect(jar.get('__proto__')).toBe('x'); // just a key in a Map
    expect(({} as Record<string, unknown>)['x']).toBeUndefined();
    expect(jar.has('bad name')).toBe(false);
    expect(parseCookieHeader('a=%E0%A4%A')).toEqual(new Map([['a', '%E0%A4%A']])); // malformed escape kept raw
    expect(parseCookieHeader(undefined).size).toBe(0);
    expect(parseCookieHeader('a=1'.padEnd(9000, 'x')).size).toBe(0);
    expect(parseCookieHeader(Array.from({ length: 300 }, (_, i) => `c${i}=v`).join('; ')).size).toBe(100);
  });
  it('readCookie prefers req.cookies (own property) and falls back to the header', () => {
    expect(readCookie({ headers: {}, cookies: { a: 'parsed' } }, 'a')).toBe('parsed');
    expect(readCookie({ headers: { cookie: 'a=hdr' }, cookies: {} }, 'a')).toBe('hdr');
    expect(readCookie({ headers: { cookie: 'a=hdr' } }, 'a')).toBe('hdr');
    expect(readCookie({ headers: {}, cookies: Object.create({ a: 'inherited' }) }, 'a')).toBeUndefined();
    expect(readCookie({ headers: {} }, 'a')).toBeUndefined();
  });
});

describe('CsrfTokenMiddleware (§12.2) — issuance', () => {
  const mw = (csrf: Record<string, unknown> = {}) =>
    new CsrfTokenMiddleware(fakeConfigService({ security: defaultSecurityConfig({ csrf: { enabled: true, cookieName: 'csrf-token', headerName: 'x-csrf-token', ...csrf } }) }, 'production'));
  const run = (m: CsrfTokenMiddleware, req: unknown) => {
    const res = fakeResponse();
    let nexted = false;
    m.use(req as never, res as never, () => { nexted = true; });
    return { res, nexted };
  };

  it('issues a readable (httpOnly:false), SameSite=Strict token cookie when none exists, then calls next()', () => {
    const { res, nexted } = run(mw(), { headers: {} });
    expect(nexted).toBe(true);
    expect(res.cookies).toHaveLength(1);
    expect(res.cookies[0]?.name).toBe('csrf-token');
    expect(res.cookies[0]?.value).toMatch(CSRF_TOKEN_RE);
    expect(res.cookies[0]?.options).toMatchObject({ httpOnly: false, sameSite: 'strict', secure: true });
  });
  it('reuses a well-formed existing token; replaces a malformed one', () => {
    const existing = randomToken(32);
    expect(run(mw(), { headers: { cookie: `csrf-token=${existing}` } }).res.cookies).toHaveLength(0);
    expect(run(mw(), { headers: { cookie: 'csrf-token=attacker' } }).res.cookies).toHaveLength(1);
  });
  it('a __Host- cookie name forces Secure even if the default is off', () => {
    configureSecurityRuntime({ ...SECURE_RUNTIME_DEFAULTS, cookies: { defaultSameSite: 'lax', defaultSecure: false } });
    const { res } = run(mw({ cookieName: '__Host-csrf' }), { headers: {} });
    expect(res.cookies[0]).toMatchObject({ name: '__Host-csrf', options: { secure: true } });
  });
});

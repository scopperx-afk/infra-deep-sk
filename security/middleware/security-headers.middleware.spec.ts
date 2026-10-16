import { getCspNonce } from '../headers/csp-nonce.util';
import { buildCspHeader } from '../headers/csp.builder';
import { defaultSecurityConfig, fakeConfigService, fakeResponse } from '../testing/security-test-utils';
import { SecurityHeadersMiddleware, buildHstsValue } from './security-headers.middleware';

type Csp = Record<string, unknown>;
const build = (overrides: { hsts?: Record<string, unknown>; headers?: Record<string, unknown>; csp?: Csp } = {}) => {
  const base = defaultSecurityConfig() as { hsts: object; headers: { csp: object } };
  const security = defaultSecurityConfig({
    hsts: { ...base.hsts, ...overrides.hsts },
    headers: { ...base.headers, ...overrides.headers, csp: { ...base.headers.csp, ...overrides.csp } },
  });
  return new SecurityHeadersMiddleware(fakeConfigService({ security }, 'production'));
};
const run = (mw: SecurityHeadersMiddleware) => {
  const res = fakeResponse();
  let nonceInNext: string | undefined;
  let nexted = false;
  mw.use({} as never, res as never, () => { nexted = true; nonceInNext = getCspNonce(); });
  return { res, nexted, nonceInNext };
};

describe('SecurityHeadersMiddleware (§9.1, §8.1)', () => {
  it('sets every header from §9.1 and calls next()', () => {
    const { res, nexted } = run(build());
    expect(nexted).toBe(true);
    expect(res.headers).toMatchObject({
      'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
      'Content-Security-Policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
  });

  it('adds the hardening headers beyond §9.1 and strips X-Powered-By', () => {
    const { res } = run(build());
    expect(res.headers['X-Permitted-Cross-Domain-Policies']).toBe('none');
    expect(res.headers['X-DNS-Prefetch-Control']).toBe('off');
    expect(res.headers['X-XSS-Protection']).toBe('0');
    expect(res.removed).toContain('X-Powered-By');
  });

  it('is configuration-driven: frame options, HSTS preload, report-only CSP with report-uri', () => {
    const { res } = run(build({
      hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
      headers: { frameOptions: 'SAMEORIGIN' },
      csp: { reportOnly: true, reportUri: 'https://r.example.com/csp', scriptSrc: ["'self'"] },
    }));
    expect(res.headers['Strict-Transport-Security']).toBe('max-age=31536000; includeSubDomains; preload');
    expect(res.headers['X-Frame-Options']).toBe('SAMEORIGIN');
    expect(res.headers['Content-Security-Policy']).toBeUndefined();
    expect(res.headers['Content-Security-Policy-Report-Only']).toContain("script-src 'self'");
    expect(res.headers['Content-Security-Policy-Report-Only']).toContain('report-uri https://r.example.com/csp');
  });

  it('omits CSP entirely when disabled', () => {
    const { res } = run(build({ csp: { enabled: false } }));
    expect(Object.keys(res.headers).some((h) => h.startsWith('Content-Security-Policy'))).toBe(false);
  });

  it('CSP nonce is UNIQUE per request, matches getCspNonce() inside the request, and is exposed on res.locals', () => {
    const mw = build({ csp: { useNonce: true, scriptSrc: ["'self'"], styleSrc: ["'self'"] } });
    const a = run(mw);
    const b = run(mw);
    expect(a.nonceInNext).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(a.nonceInNext).not.toBe(b.nonceInNext);
    expect(a.res.locals['cspNonce']).toBe(a.nonceInNext);
    const csp = a.res.headers['Content-Security-Policy'] as string;
    expect(csp).toContain(`script-src 'self' 'nonce-${a.nonceInNext}'`);
    expect(csp).toContain(`style-src 'self' 'nonce-${a.nonceInNext}'`);
    expect(csp).not.toContain(b.nonceInNext as string);
    expect(getCspNonce()).toBeUndefined(); // no leakage outside the request
  });

  it('does not generate a nonce when useNonce is off (getCspNonce() is undefined)', () => {
    expect(run(build({ csp: { scriptSrc: ["'self'"] } })).nonceInNext).toBeUndefined();
  });
});

describe('buildCspHeader', () => {
  const csp = (o: Csp) => ((defaultSecurityConfig({ headers: { ...(defaultSecurityConfig().headers as object), csp: { ...((defaultSecurityConfig().headers as { csp: object }).csp), ...o } } }).headers as { csp: never }).csp);
  it('renders only non-empty directives, in a stable order, plus upgrade-insecure-requests', () => {
    const h = buildCspHeader(csp({ imgSrc: ["'self'", 'data:'], upgradeInsecureRequests: true }));
    expect(h?.build()).toBe("default-src 'none'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests");
  });
  it('does not claim to use a nonce when there is no script-src/style-src to attach it to', () => {
    expect(buildCspHeader(csp({ useNonce: true }))?.usesNonce).toBe(false);
  });
});

describe('buildHstsValue', () => {
  it('formats max-age and flags', () => {
    expect(buildHstsValue({ maxAge: 10, includeSubDomains: false, preload: false })).toBe('max-age=10');
    expect(buildHstsValue({ maxAge: 10, includeSubDomains: true, preload: true })).toBe('max-age=10; includeSubDomains; preload');
  });
});

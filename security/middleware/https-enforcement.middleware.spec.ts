import { defaultSecurityConfig, fakeConfigService, fakeResponse } from '../testing/security-test-utils';
import { HttpsEnforcementMiddleware } from './https-enforcement.middleware';

const build = (env: 'development' | 'staging' | 'production' | 'test', httpsEnforcement: Record<string, unknown> = {}) =>
  new HttpsEnforcementMiddleware(
    fakeConfigService({ security: defaultSecurityConfig({ httpsEnforcement: { enabled: true, redirectStatus: 308, ...httpsEnforcement } }) }, env),
  );
const req = (over: Record<string, unknown> = {}) => ({
  secure: false,
  originalUrl: '/api/items?x=1',
  headers: { host: 'api.example.com' } as Record<string, string>,
  ...over,
});
const run = (mw: HttpsEnforcementMiddleware, r: unknown) => {
  const res = fakeResponse();
  let nexted = false;
  mw.use(r as never, res as never, () => { nexted = true; });
  return { res, nexted };
};

describe('HttpsEnforcementMiddleware (§8.2)', () => {
  it('redirects plain HTTP in production with 308 to the same host and path', () => {
    const { res, nexted } = run(build('production'), req());
    expect(nexted).toBe(false);
    expect(res.redirected).toEqual({ status: 308, url: 'https://api.example.com/api/items?x=1' });
  });

  it('passes through in development and test', () => {
    for (const env of ['development', 'test'] as const) expect(run(build(env), req()).nexted).toBe(true);
  });

  it('also enforces in staging (internet-reachable)', () => {
    expect(run(build('staging'), req()).res.redirected?.status).toBe(308);
  });

  it('passes through when the request is already secure (req.secure or X-Forwarded-Proto)', () => {
    expect(run(build('production'), req({ secure: true })).nexted).toBe(true);
    expect(run(build('production'), req({ headers: { host: 'a.com', 'x-forwarded-proto': 'https' } })).nexted).toBe(true);
    expect(run(build('production'), req({ headers: { host: 'a.com', 'x-forwarded-proto': 'HTTPS, http' } })).nexted).toBe(true);
    expect(run(build('production'), req({ headers: { host: 'a.com', 'x-forwarded-proto': 'http' } })).nexted).toBe(false);
  });

  it('honours the configured redirect status and the enabled switch', () => {
    expect(run(build('production', { redirectStatus: 301 }), req()).res.redirected?.status).toBe(301);
    expect(run(build('production', { enabled: false }), req()).nexted).toBe(true);
  });

  it('is not an open redirect: a Host that is not a plain host[:port] is a 400, never a redirect', () => {
    for (const host of ['evil.com/@x', 'a.com\r\nX: 1', 'a b.com', 'a.com#@evil.com', '']) {
      const { res, nexted } = run(build('production'), req({ headers: { host } }));
      expect(nexted).toBe(false);
      expect(res.redirected).toBeUndefined();
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ code: 'INVALID_HOST', message: expect.any(String) });
    }
    expect(run(build('production'), req({ headers: {} })).res.statusCode).toBe(400);
  });

  it('accepts host:port and bracketed IPv6 hosts', () => {
    expect(run(build('production'), req({ headers: { host: 'api.example.com:8443' } })).res.redirected?.url).toBe('https://api.example.com:8443/api/items?x=1');
    expect(run(build('production'), req({ headers: { host: '[::1]:3000' } })).res.redirected?.url).toBe('https://[::1]:3000/api/items?x=1');
  });

  it('exempts the orchestrator health probes (no forwarded-proto on an in-cluster probe)', () => {
    expect(run(build('production'), req({ originalUrl: '/health/live' })).nexted).toBe(true);
    expect(run(build('production'), req({ originalUrl: '/api/v1/health/ready?x=1' })).nexted).toBe(true);
    expect(run(build('production'), req({ originalUrl: '/health/other' })).nexted).toBe(false);
  });
});

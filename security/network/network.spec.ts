import { getClientIp, normalizeIp } from '../ip/ip.utils';
import { defaultSecurityConfig, fakeConfigService, fakeResponse } from '../testing/security-test-utils';
import { HostValidationMiddleware, compileHostMatcher } from './host-validation.middleware';
import { createIpFilterMiddleware, hasIpPolicy, isIpAllowed } from './ip-filter.util';
import { isPublicIp } from './ip-ranges';
import { RequestSmugglingGuardMiddleware, hasAmbiguousBodyFraming } from './request-smuggling-guard.middleware';
import { configureTrustProxy, isValidIpOrCidr, isValidTrustProxyEntry } from './trusted-proxy.util';

const runMw = (mw: { use(req: never, res: never, next: () => void): void }, req: unknown) => {
  const res = fakeResponse();
  let nexted = false;
  mw.use(req as never, res as never, () => { nexted = true; });
  return { res, nexted };
};

describe('HostValidationMiddleware (§16.3)', () => {
  const mw = (allowedHosts: string[]) => new HostValidationMiddleware(fakeConfigService({ security: defaultSecurityConfig({ allowedHosts }) }));

  it('an empty allowedHosts is a deliberate opt-out', () => {
    expect(runMw(mw([]), { headers: { host: 'anything.example' } }).nexted).toBe(true);
    expect(runMw(mw([]), { headers: {} }).nexted).toBe(true);
  });

  it('a non-allowlisted Host header gets 400 INVALID_HOST', () => {
    const { res, nexted } = runMw(mw(['api.example.com']), { headers: { host: 'evil.com' } });
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ code: 'INVALID_HOST', message: expect.any(String) });
    expect(runMw(mw(['api.example.com']), { headers: {} }).res.statusCode).toBe(400);
  });

  it('matches case-insensitively; an entry without a port matches any port; an entry with a port is exact', () => {
    expect(runMw(mw(['api.example.com']), { headers: { host: 'API.Example.COM' } }).nexted).toBe(true);
    expect(runMw(mw(['api.example.com']), { headers: { host: 'api.example.com:8443' } }).nexted).toBe(true);
    expect(runMw(mw(['api.example.com:8443']), { headers: { host: 'api.example.com:8443' } }).nexted).toBe(true);
    expect(runMw(mw(['api.example.com:8443']), { headers: { host: 'api.example.com:9' } }).nexted).toBe(false);
    expect(runMw(mw(['api.example.com:8443']), { headers: { host: 'api.example.com' } }).nexted).toBe(false);
  });

  it('wildcards match subdomains but never the apex or a look-alike suffix', () => {
    const m = compileHostMatcher(['*.example.com'])!;
    expect(m('a.example.com')).toBe(true);
    expect(m('a.b.example.com')).toBe(true);
    expect(m('example.com')).toBe(false);
    expect(m('evilexample.com')).toBe(false);
    expect(m('example.com.evil.com')).toBe(false);
  });

  it('rejects structurally hostile Host values before comparing', () => {
    const m = compileHostMatcher(['api.example.com'])!;
    for (const h of ['api.example.com/x', 'api.example.com@evil.com', 'api.example.com evil.com', 'api.example.com\r\nX: 1', '', undefined, ['api.example.com']]) {
      expect(m(h)).toBe(false);
    }
  });

  it('supports bracketed IPv6 entries', () => {
    expect(compileHostMatcher(['[::1]'])!('[::1]:3000')).toBe(true);
  });
});

describe('RequestSmugglingGuardMiddleware (§16.4)', () => {
  const mw = new RequestSmugglingGuardMiddleware();

  it('conflicting Content-Length and Transfer-Encoding gets 400 AMBIGUOUS_BODY_FRAMING', () => {
    const { res, nexted } = runMw(mw, { headers: { 'content-length': '5', 'transfer-encoding': 'chunked' } });
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ code: 'AMBIGUOUS_BODY_FRAMING', message: expect.any(String) });
  });

  it('passes normal framing', () => {
    expect(runMw(mw, { headers: { 'content-length': '12' } }).nexted).toBe(true);
    expect(runMw(mw, { headers: { 'transfer-encoding': 'chunked' } }).nexted).toBe(true);
    expect(runMw(mw, { headers: { 'transfer-encoding': 'Chunked' } }).nexted).toBe(true);
    expect(runMw(mw, { headers: {} }).nexted).toBe(true);
    expect(runMw(mw, { headers: { 'content-length': '0' } }).nexted).toBe(true);
  });

  it('rejects malformed Content-Length and obfuscated Transfer-Encoding values', () => {
    for (const headers of [
      { 'content-length': '5, 6' }, { 'content-length': '+5' }, { 'content-length': '0x5' }, { 'content-length': '-1' }, { 'content-length': ['5', '5'] },
      { 'transfer-encoding': 'xchunked' }, { 'transfer-encoding': ' chunked' }, { 'transfer-encoding': 'chunked, identity' }, { 'transfer-encoding': 'identity' },
    ]) {
      expect(hasAmbiguousBodyFraming(headers as never)).toBe(true);
    }
  });
});

describe('IP primitives (§16.1) and filter (§16.2)', () => {
  it('getClientIp reflects what the platform resolved (trust proxy), not a raw header', () => {
    expect(getClientIp({ ip: '203.0.113.9' })).toBe('203.0.113.9');
    expect(getClientIp({ ip: '::ffff:1.2.3.4' })).toBe('1.2.3.4');
    expect(getClientIp({ socket: { remoteAddress: '5.6.7.8' } })).toBe('5.6.7.8');
    // a spoofed header on the request object is simply never read
    expect(getClientIp({ ip: '10.0.0.1', headers: { 'x-forwarded-for': '6.6.6.6' } } as never)).toBe('10.0.0.1');
    expect(getClientIp({ ip: 'evil\r\nheader' })).toBe('unknown');
    expect(getClientIp({})).toBe('unknown');
  });

  it('normalizeIp unwraps IPv4-mapped IPv6 in every spelling', () => {
    expect(normalizeIp('::ffff:10.0.0.1')).toBe('10.0.0.1');
    expect(normalizeIp('::ffff:a00:1')).toBe('10.0.0.1');
    expect(normalizeIp('0:0:0:0:0:ffff:a00:1')).toBe('10.0.0.1');
    expect(normalizeIp('2001:DB8::1')).toBe('2001:db8::1');
  });

  const policy = { allowlist: ['10.0.0.0/8', '2001:db8::/32'], blocklist: ['10.9.0.0/16', '10.1.1.1'] };
  it('allowlist requires a match; blocklist always wins; mapped IPv6 cannot dodge an IPv4 rule', () => {
    expect(isIpAllowed('10.2.3.4', policy)).toBe(true);
    expect(isIpAllowed('2001:db8::5', policy)).toBe(true);
    expect(isIpAllowed('::ffff:10.2.3.4', policy)).toBe(true);
    expect(isIpAllowed('8.8.8.8', policy)).toBe(false);
    expect(isIpAllowed('10.9.1.1', policy)).toBe(false);
    expect(isIpAllowed('10.1.1.1', policy)).toBe(false);
    expect(isIpAllowed('::ffff:10.9.1.1', policy)).toBe(false);
  });
  it('empty lists impose nothing; an undeterminable address is denied', () => {
    expect(isIpAllowed('8.8.8.8', {})).toBe(true);
    expect(isIpAllowed('8.8.8.8', { allowlist: [], blocklist: [] })).toBe(true);
    expect(isIpAllowed('unknown', {})).toBe(false);
    expect(isIpAllowed('not-an-ip', {})).toBe(false);
    expect(hasIpPolicy({})).toBe(false);
    expect(hasIpPolicy({ blocklist: ['1.1.1.1'] })).toBe(true);
  });
  it('malformed policy entries fail at compile time, not on a request', () => {
    expect(() => isIpAllowed('1.1.1.1', { allowlist: ['not-an-ip'] })).toThrow('Invalid allowlist entry');
    expect(() => isIpAllowed('1.1.1.1', { blocklist: ['10.0.0.0/33'] })).toThrow('prefix length');
    expect(() => createIpFilterMiddleware({ blocklist: ['x'] })).toThrow();
  });
  it('the filter middleware answers 403 IP_NOT_ALLOWED or calls next()', () => {
    const mw = createIpFilterMiddleware({ allowlist: ['10.0.0.0/8'] });
    const denied = runMw(mw as never, { ip: '8.8.8.8' });
    expect(denied.nexted).toBe(false);
    expect(denied.res.statusCode).toBe(403);
    expect(denied.res.body).toEqual({ code: 'IP_NOT_ALLOWED', message: expect.any(String) });
    expect(runMw(mw as never, { ip: '10.1.1.1' }).nexted).toBe(true);
  });
});

describe('non-public address space (SSRF building block)', () => {
  it('flags private, loopback, link-local/metadata, CGNAT, multicast and transition-wrapped addresses', () => {
    for (const ip of ['10.0.0.1', '172.16.5.5', '192.168.1.1', '127.0.0.1', '169.254.169.254', '100.64.0.1', '224.0.0.1', '0.0.0.0',
      '::1', '::', 'fe80::1', 'fd00:ec2::254', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::7f00:1', '2002:7f00:1::', 'not-an-ip']) {
      expect(isPublicIp(ip)).toBe(false);
    }
  });
  it('accepts genuinely public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111']) expect(isPublicIp(ip)).toBe(true);
  });
});

describe('trusted proxy (§8.3)', () => {
  it('validates presets, IPs and CIDRs', () => {
    for (const ok of ['loopback', 'linklocal', 'uniquelocal', '10.0.0.0/8', '::1', '2001:db8::/32', '1.2.3.4']) expect(isValidTrustProxyEntry(ok)).toBe(true);
    for (const bad of ['evil', '10.0.0.0/33', '1.1.1.1/8/9', '', 'true']) expect(isValidTrustProxyEntry(bad)).toBe(false);
    expect(isValidIpOrCidr('loopback')).toBe(false);
    expect(isValidIpOrCidr('10.0.0.0/8')).toBe(true);
  });
  it('configureTrustProxy hands security.trustProxy to the platform', () => {
    const calls: Array<[string, unknown]> = [];
    const app = { getHttpAdapter: () => ({ getInstance: () => ({ set: (k: string, v: unknown) => calls.push([k, v]) }) }) };
    configureTrustProxy(app, fakeConfigService({ security: { trustProxy: 1 } }));
    expect(calls).toEqual([['trust proxy', 1]]);
  });
});

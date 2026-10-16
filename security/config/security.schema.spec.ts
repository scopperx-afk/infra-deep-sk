import { securityConfigSchema } from './security.schema';

const HEX_KEY = 'a'.repeat(64);
const OTHER_HEX_KEY = 'b'.repeat(64);
const parse = (input: unknown) => securityConfigSchema.safeParse(input);
const ok = (input: unknown) => {
  const r = parse(input);
  if (!r.success) throw new Error(JSON.stringify(r.error.issues));
  return r.data;
};
const issuePaths = (input: unknown): string[] => {
  const r = parse(input);
  return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
};

describe('securityConfigSchema (§23) — secure by default', () => {
  it('an empty namespace parses to the restrictive defaults', () => {
    const c = ok({});
    expect(c.trustProxy).toBe(false);
    expect(c.httpsEnforcement).toEqual({ enabled: true, redirectStatus: 308 });
    expect(c.hsts).toEqual({
      maxAge: 63_072_000,
      includeSubDomains: true,
      preload: false,
    });
    expect(c.headers.frameOptions).toBe('DENY');
    expect(c.headers.coep).toBe('require-corp');
    expect(c.headers.csp).toMatchObject({
      enabled: true,
      reportOnly: false,
      useNonce: false,
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
      scriptSrc: [],
    });
    expect(c.cookies).toEqual({ defaultSameSite: 'lax', defaultSecure: true });
    expect(c.csrf).toEqual({
      enabled: true,
      cookieName: 'csrf-token',
      headerName: 'x-csrf-token',
    });
    expect(c.injection).toEqual({
      maxJsonDepth: 20,
      redosTimeoutMs: 100,
      stripPrototypeKeys: true,
    });
    expect(c.allowedHosts).toEqual([]);
    expect(c.ipPolicy).toEqual({ allowlist: [], blocklist: [] });
    expect(c.clamav.host).toBeUndefined();
    expect(c.clamav.port).toBe(3310);
    expect(c.clamav.timeoutMs).toBe(30_000);
    expect(c.clamav.failOpen).toBe(false);
    expect(c.webhookSigning).toEqual({
      secret: undefined,
      toleranceSeconds: 300,
    });
    expect(c.crypto).toEqual({
      currentKeyId: undefined,
      currentKeyRef: undefined,
      retiredKeys: [],
    });
  });

  it('parses env-style string values (booleans, numbers, CSV lists, empty = unset)', () => {
    const c = ok({
      trustProxy: '1',
      httpsEnforcement: { enabled: 'false', redirectStatus: '301' },
      hsts: { maxAge: '31536000', includeSubDomains: 'true', preload: 'true' },
      headers: {
        frameOptions: 'SAMEORIGIN',
        csp: {
          reportOnly: 'true',
          reportUri: '',
          scriptSrc: "'self', https://cdn.example.com",
          useNonce: '1',
        },
      },
      cookies: { defaultSecure: 'false' },
      csrf: { headerName: 'X-CSRF-Token' },
      allowedHosts: 'api.example.com, *.example.com, localhost:3000',
      ipPolicy: { allowlist: '10.0.0.0/8, ::1', blocklist: '' },
      clamav: { host: 'localhost', port: '3310', failOpen: 'false' },
    });
    expect(c.trustProxy).toBe(1);
    expect(c.httpsEnforcement).toEqual({ enabled: false, redirectStatus: 301 });
    expect(c.hsts.preload).toBe(true);
    expect(c.headers.csp.reportUri).toBeUndefined();
    expect(c.headers.csp.reportOnly).toBe(true);
    expect(c.headers.csp.scriptSrc).toEqual([
      "'self'",
      'https://cdn.example.com',
    ]);
    expect(c.csrf.headerName).toBe('x-csrf-token');
    expect(c.allowedHosts).toEqual([
      'api.example.com',
      '*.example.com',
      'localhost:3000',
    ]);
    expect(c.ipPolicy).toEqual({
      allowlist: ['10.0.0.0/8', '::1'],
      blocklist: [],
    });
    expect(c.clamav.host).toBe('localhost');
  });

  describe('trustProxy', () => {
    it.each([
      ['false', false],
      ['true', true],
      ['0', 0],
      ['2', 2],
      ['loopback', 'loopback'],
      ['10.0.0.0/8, loopback', '10.0.0.0/8, loopback'],
    ])('accepts %s', (input, expected) => {
      expect(ok({ trustProxy: input }).trustProxy).toBe(expected);
    });
    it.each(['nonsense', '10.0.0.0/33', '999', '1.2.3'])(
      'rejects %s',
      (input) => {
        expect(issuePaths({ trustProxy: input })).toContain('trustProxy');
      },
    );
  });

  describe('field-pairing rules (same namespace)', () => {
    it('hsts.preload requires includeSubDomains and a >= 1 year max-age', () => {
      expect(
        issuePaths({ hsts: { preload: 'true', includeSubDomains: 'false' } }),
      ).toContain('hsts.preload');
      expect(
        issuePaths({ hsts: { preload: 'true', maxAge: '3600' } }),
      ).toContain('hsts.preload');
      expect(
        parse({ hsts: { preload: 'true', maxAge: '31536000' } }).success,
      ).toBe(true);
    });
    it('SameSite=None requires Secure', () => {
      expect(
        issuePaths({
          cookies: { defaultSameSite: 'none', defaultSecure: 'false' },
        }),
      ).toContain('cookies.defaultSecure');
      expect(
        parse({ cookies: { defaultSameSite: 'none', defaultSecure: 'true' } })
          .success,
      ).toBe(true);
    });
    it('crypto.currentKeyId and currentKeyRef come together, and the key must be 32 bytes', () => {
      expect(parse({ crypto: { currentKeyId: 'k1' } }).success).toBe(false);
      expect(parse({ crypto: { currentKeyRef: HEX_KEY } }).success).toBe(false);
      expect(
        issuePaths({
          crypto: { currentKeyId: 'k1', currentKeyRef: 'tooshort' },
        }),
      ).toContain('crypto.currentKeyRef');
      expect(
        parse({ crypto: { currentKeyId: 'k1', currentKeyRef: HEX_KEY } })
          .success,
      ).toBe(true);
      expect(
        issuePaths({
          crypto: { currentKeyId: 'bad:id', currentKeyRef: HEX_KEY },
        }),
      ).toContain('crypto.currentKeyId');
    });
    it('never echoes key material in an error message', () => {
      const r = parse({
        crypto: { currentKeyId: 'k1', currentKeyRef: 'SUPER-SECRET-NOT-A-KEY' },
      });
      expect(JSON.stringify(r)).not.toContain('SUPER-SECRET-NOT-A-KEY');
    });
    it('retiredKeys: a JSON array in ONE env var; ids unique and different from the current key', () => {
      const c = ok({
        crypto: {
          currentKeyId: 'k2',
          currentKeyRef: HEX_KEY,
          retiredKeys: JSON.stringify([{ id: 'k1', keyRef: OTHER_HEX_KEY }]),
        },
      });
      expect(c.crypto.retiredKeys).toEqual([
        { id: 'k1', keyRef: OTHER_HEX_KEY },
      ]);
      expect(
        issuePaths({
          crypto: {
            currentKeyId: 'k1',
            currentKeyRef: HEX_KEY,
            retiredKeys: JSON.stringify([{ id: 'k1', keyRef: OTHER_HEX_KEY }]),
          },
        }),
      ).toContain('crypto.retiredKeys.0.id');
      expect(parse({ crypto: { retiredKeys: '[{' } }).success).toBe(false);
      expect(
        issuePaths({
          crypto: {
            retiredKeys: JSON.stringify([{ id: 'k1', keyRef: 'short' }]),
          },
        }),
      ).toContain('crypto.retiredKeys.0.keyRef');
      expect(ok({ crypto: { retiredKeys: '' } }).crypto.retiredKeys).toEqual(
        [],
      );
    });
  });

  describe('injection-resistant values', () => {
    it('a CSP source cannot smuggle a new directive (no `;`, whitespace or control chars)', () => {
      expect(
        parse({ headers: { csp: { scriptSrc: "'self'; script-src *" } } })
          .success,
      ).toBe(false);
      expect(
        parse({ headers: { csp: { scriptSrc: "'self'\r\nX-Evil: 1" } } })
          .success,
      ).toBe(false);
      expect(
        parse({
          headers: {
            csp: { reportUri: 'https://r.example.com/x; script-src *' },
          },
        }).success,
      ).toBe(false);
    });
    it('permissionsPolicy must be printable ASCII (no response splitting through config)', () => {
      expect(
        parse({ headers: { permissionsPolicy: 'camera=()\r\nX: 1' } }).success,
      ).toBe(false);
    });
    it('allowedHosts / ipPolicy entries are validated', () => {
      for (const bad of ['evil.com/path', 'a b.com', 'a.com@evil.com', '*'])
        expect(parse({ allowedHosts: bad }).success).toBe(false);
      for (const bad of ['not-an-ip', '10.0.0.0/33', 'loopback']) {
        expect(parse({ ipPolicy: { allowlist: bad } }).success).toBe(false);
        expect(parse({ ipPolicy: { blocklist: bad } }).success).toBe(false);
      }
    });
    it('cookie / header names must be RFC 7230 tokens', () => {
      expect(parse({ csrf: { cookieName: 'bad name' } }).success).toBe(false);
      expect(parse({ csrf: { headerName: 'x;evil' } }).success).toBe(false);
      expect(parse({ csrf: { cookieName: '__Host-csrf' } }).success).toBe(true);
    });
  });

  it('bounds numeric knobs', () => {
    expect(parse({ injection: { maxJsonDepth: '0' } }).success).toBe(false);
    expect(parse({ injection: { maxJsonDepth: '1000' } }).success).toBe(false);
    expect(parse({ injection: { redosTimeoutMs: '1' } }).success).toBe(false);
    expect(parse({ clamav: { port: '70000' } }).success).toBe(false);
    expect(parse({ webhookSigning: { toleranceSeconds: '0' } }).success).toBe(
      false,
    );
    expect(parse({ httpsEnforcement: { redirectStatus: '200' } }).success).toBe(
      false,
    );
  });

  it('webhookSigning.secret must be strong when set, and an empty value means unset', () => {
    expect(parse({ webhookSigning: { secret: 'short' } }).success).toBe(false);
    expect(
      ok({ webhookSigning: { secret: '' } }).webhookSigning.secret,
    ).toBeUndefined();
    expect(
      ok({ webhookSigning: { secret: 'x'.repeat(40) } }).webhookSigning.secret,
    ).toHaveLength(40);
  });
});

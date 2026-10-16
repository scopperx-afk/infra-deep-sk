import { ConfigValidationError } from '../../config';
import { defaultSecurityConfig } from '../testing/security-test-utils';
import { collectProductionSecurityIssues, securityCrossValidation } from './security.cross-validation';
import type { SecurityConfig } from './security.schema';

const security = (over: Record<string, unknown> = {}): SecurityConfig => defaultSecurityConfig(over) as unknown as SecurityConfig;
const ctx = (env: string, sec: SecurityConfig | undefined) =>
  ({ config: { app: { env }, ...(sec ? { security: sec } : {}) }, wasSupplied: () => false }) as never;

describe('security production cross-validation (Config spec §7.8)', () => {
  it('the secure defaults are valid for production', () => {
    expect(collectProductionSecurityIssues(security())).toEqual([]);
    expect(() => securityCrossValidation(ctx('production', security()))).not.toThrow();
  });

  it('reports EVERY production misconfiguration at once, naming the env var', () => {
    const issues = collectProductionSecurityIssues(
      security({
        trustProxy: true,
        httpsEnforcement: { enabled: false, redirectStatus: 308 },
        cookies: { defaultSameSite: 'lax', defaultSecure: false },
        hsts: { maxAge: 3600, includeSubDomains: true, preload: false },
        csrf: { enabled: false, cookieName: 'c', headerName: 'h' },
        headers: { ...(defaultSecurityConfig().headers as object), csp: { ...((defaultSecurityConfig().headers as { csp: object }).csp), enabled: false } },
      }),
    );
    expect(issues).toHaveLength(6);
    for (const name of ['SECURITY__TRUST_PROXY', 'HTTPS_ENFORCEMENT__ENABLED', 'COOKIES__DEFAULT_SECURE', 'HSTS__MAX_AGE', 'CSRF__ENABLED', 'CSP__ENABLED']) {
      expect(issues.some((i) => i.includes(name))).toBe(true);
    }
  });

  it('throws a ConfigValidationError in production, and is silent in every other environment', () => {
    const insecure = security({ httpsEnforcement: { enabled: false, redirectStatus: 308 } });
    expect(() => securityCrossValidation(ctx('production', insecure))).toThrow(ConfigValidationError);
    for (const env of ['development', 'test', 'staging']) expect(() => securityCrossValidation(ctx(env, insecure))).not.toThrow();
  });

  it('accepts a numeric hop count or a CIDR list for trustProxy in production, rejects only `true`', () => {
    expect(collectProductionSecurityIssues(security({ trustProxy: 1 }))).toEqual([]);
    expect(collectProductionSecurityIssues(security({ trustProxy: '10.0.0.0/8,loopback' }))).toEqual([]);
    expect(collectProductionSecurityIssues(security({ trustProxy: false }))).toEqual([]);
  });

  it('is a no-op when the security namespace is absent', () => {
    expect(() => securityCrossValidation(ctx('production', undefined))).not.toThrow();
  });
});

/**
 * Cross-NAMESPACE validation — Config spec §7.3/§7.8 (`registerCrossValidation`).
 *
 * Everything that needs `app.env` next to `security.*` lives here; rules over a single
 * namespace are in the schemas' own `.superRefine()`s. Registered by `SecurityModule`
 * through `CONFIG_REGISTRY` (same barrier as `forFeature()` registrars — see
 * `config.initializer.ts` "Registration ordering").
 *
 * PRODUCTION ONLY. A development machine legitimately runs plain HTTP with non-Secure
 * cookies; a production deploy that does is a misconfiguration the platform should refuse
 * to boot with, loudly, naming every offending key at once.
 */
import { ConfigValidationError, type CrossValidationFn } from '../../config';
import type { SecurityConfig } from './security.schema';

export const MIN_PRODUCTION_HSTS_MAX_AGE = 31_536_000; // 1 year

/** Pure, so it is unit-testable without booting Config. */
export function collectProductionSecurityIssues(security: SecurityConfig): string[] {
  const issues: string[] = [];
  if (security.trustProxy === true) {
    issues.push(
      'SECURITY__TRUST_PROXY=true trusts EVERY proxy hop, so any client can spoof its forwarded address headers and choose its own IP — set the real hop count (e.g. 1) or the proxy CIDRs',
    );
  }
  if (!security.httpsEnforcement.enabled) issues.push('SECURITY__HTTPS_ENFORCEMENT__ENABLED must be true in production');
  if (!security.cookies.defaultSecure) issues.push('SECURITY__COOKIES__DEFAULT_SECURE must be true in production');
  if (!security.headers.csp.enabled) issues.push('SECURITY__HEADERS__CSP__ENABLED must be true in production');
  if (security.hsts.maxAge < MIN_PRODUCTION_HSTS_MAX_AGE) {
    issues.push(`SECURITY__HSTS__MAX_AGE must be at least ${MIN_PRODUCTION_HSTS_MAX_AGE} (1 year) in production`);
  }
  if (!security.csrf.enabled) issues.push('SECURITY__CSRF__ENABLED must be true in production');
  return issues;
}

export const securityCrossValidation: CrossValidationFn = (ctx) => {
  const app = ctx.config['app'] as { env?: string } | undefined;
  const security = ctx.config['security'] as SecurityConfig | undefined;
  if (app?.env !== 'production' || security === undefined) return;
  const issues = collectProductionSecurityIssues(security);
  if (issues.length > 0) {
    throw new ConfigValidationError('security', 'Insecure security configuration for production', issues);
  }
};

/**
 * `SecurityHeadersMiddleware` — Security spec §9.1 (+ §8.1 HSTS).
 *
 * Registered at HTTP spec §3 step 4 — BEFORE guards — so a request a guard later rejects
 * still carries the same headers on its error response (the headers are set on `res`
 * up-front; Errors' filter writes the body onto that same response).
 *
 * Everything static is computed ONCE in the constructor (Config is frozen at that point);
 * per request this is a handful of `setHeader` calls plus, with `csp.useNonce`, one
 * `randomBytes(16)`.
 *
 * Beyond §9.1's list: `X-Permitted-Cross-Domain-Policies: none`, `X-DNS-Prefetch-Control:
 * off`, `X-XSS-Protection: 0` (the legacy XSS auditor is itself an attack surface —
 * OWASP/MDN say disable it), and `X-Powered-By` is removed (SPEC-ERRATA E-S10).
 */
import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { CONFIG_SERVICE, type ConfigService } from '../../config';
import type { SecurityConfig } from '../config/security.schema';
import { buildCspHeader, type CspHeader } from '../headers/csp.builder';
import { generateNonce, runWithCspNonce } from '../headers/csp-nonce.util';

export function buildHstsValue(hsts: SecurityConfig['hsts']): string {
  return `max-age=${hsts.maxAge}${hsts.includeSubDomains ? '; includeSubDomains' : ''}${hsts.preload ? '; preload' : ''}`;
}

@Injectable()
export class SecurityHeadersMiddleware implements NestMiddleware {
  private readonly staticHeaders: ReadonlyArray<readonly [string, string]>;
  private readonly csp: CspHeader | undefined;

  constructor(@Inject(CONFIG_SERVICE) config: ConfigService) {
    const { hsts, headers } = config.getNamespace<SecurityConfig>('security');
    this.staticHeaders = Object.freeze([
      ['Strict-Transport-Security', buildHstsValue(hsts)],
      ['X-Content-Type-Options', 'nosniff'],
      ['X-Frame-Options', headers.frameOptions],
      ['Referrer-Policy', headers.referrerPolicy],
      ['Cross-Origin-Opener-Policy', headers.coop],
      ['Cross-Origin-Embedder-Policy', headers.coep],
      ['Cross-Origin-Resource-Policy', headers.corp],
      ['Permissions-Policy', headers.permissionsPolicy],
      ['X-Permitted-Cross-Domain-Policies', 'none'],
      ['X-DNS-Prefetch-Control', 'off'],
      ['X-XSS-Protection', '0'],
    ] as const);
    this.csp = buildCspHeader(headers.csp);
  }

  use(_req: Request, res: Response, next: NextFunction): void {
    res.removeHeader('X-Powered-By');
    for (const [name, value] of this.staticHeaders) res.setHeader(name, value);

    const csp = this.csp;
    if (!csp) {
      next();
      return;
    }
    if (!csp.usesNonce) {
      res.setHeader(csp.name, csp.build());
      next();
      return;
    }
    const nonce = generateNonce();
    res.locals['cspNonce'] = nonce;
    res.setHeader(csp.name, csp.build(nonce));
    runWithCspNonce(nonce, next); // the rest of THIS request sees getCspNonce()
  }
}

/**
 * `CsrfTokenMiddleware` — token ISSUANCE, Security spec §12.2.
 *
 * Double-submit cookie, deliberately (no server-held session token → no store, no layer
 * inversion): the browser's same-origin policy is what stops a foreign page from READING
 * the cookie and echoing it in a header. Hence `httpOnly: false` (client JS must read it) and
 * `SameSite=Strict` as defence in depth.
 *
 * Not registered globally — a bearer-token API gains nothing from a CSRF cookie. A module
 * serving cookie-session routes applies it where needed:
 *     consumer.apply(CsrfTokenMiddleware).forRoutes(SessionController)
 * (exported from index.ts for that reason — SPEC-ERRATA E-S15; §22 listed no registration
 * point for this class).
 *
 * Reuses a well-formed existing cookie (stable token across requests); replaces a malformed
 * one. A `__Host-`/`__Secure-` cookie name (recommended in production — it defeats
 * cookie-tossing from sibling subdomains) is honoured: those prefixes force `Secure`.
 */
import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { CONFIG_SERVICE, type ConfigService } from '../../config';
import { readCookie } from '../cookies/cookie-reader.util';
import { setSecureCookie } from '../cookies/secure-cookie.util';
import { randomToken } from '../crypto/random.util';

/** Tokens this module issues: 32 random bytes, hex. Anything else is not ours. */
export const CSRF_TOKEN_RE = /^[0-9a-f]{64}$/;

export const generateCsrfToken = (): string => randomToken(32);

@Injectable()
export class CsrfTokenMiddleware implements NestMiddleware {
  private readonly cookieName: string;

  constructor(@Inject(CONFIG_SERVICE) config: ConfigService) {
    this.cookieName = config.get<string>('security.csrf.cookieName');
  }

  use(req: Request, res: Response, next: NextFunction): void {
    const existing = readCookie(req, this.cookieName);
    if (existing === undefined || !CSRF_TOKEN_RE.test(existing)) {
      const prefixed = this.cookieName.startsWith('__Host-') || this.cookieName.startsWith('__Secure-');
      setSecureCookie(res, this.cookieName, generateCsrfToken(), {
        httpOnly: false, // deliberate — double-submit needs client JS to read and echo this cookie
        sameSite: 'strict',
        ...(prefixed ? { secure: true } : {}),
      });
    }
    next();
  }
}

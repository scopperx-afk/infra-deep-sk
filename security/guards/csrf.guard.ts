/**
 * `CsrfGuard` — Security spec §12.1. Double-submit cookie check, applied PER ROUTE via
 * `@UseGuards()` on cookie-session routes — never globally. Bearer-token routes (§5's
 * default) are CSRF-immune by construction: a browser never attaches an
 * `Authorization` header to a cross-site request on its own.
 *
 * Differences from the sketch (all fail-closed or correctness fixes):
 *  - SAFE methods (GET/HEAD/OPTIONS) are not checked: they must not change state, and a
 *    token requirement there breaks plain page loads (SPEC-ERRATA E-S17);
 *  - the comparison is `constantTimeEquals`, not `===` (§24 source-scan rule);
 *  - the cookie is read via `readCookie` (works without `cookie-parser`, E-S8) and must be a
 *    token THIS module issues (64 hex chars) — an attacker-planted arbitrary value is rejected
 *    before comparison;
 *  - rejection is an explicit `403 FORBIDDEN` with a stable message, not Nest's default
 *    "Forbidden resource".
 */
import {
  ForbiddenException,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { CONFIG_SERVICE, type ConfigService } from '../../config';
import { readCookie } from '../cookies/cookie-reader.util';
import { constantTimeEquals } from '../crypto/compare.util';
import { CSRF_TOKEN_RE } from '../csrf/csrf-token.middleware';

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly enabled: boolean;
  private readonly cookieName: string;
  private readonly headerName: string;

  constructor(@Inject(CONFIG_SERVICE) config: ConfigService) {
    this.enabled = config.get<boolean>('security.csrf.enabled');
    this.cookieName = config.get<string>('security.csrf.cookieName');
    this.headerName = config.get<string>('security.csrf.headerName');
  }

  canActivate(ctx: ExecutionContext): boolean {
    if (!this.enabled) return true;
    const req = ctx.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method.toUpperCase())) return true;

    const cookieToken = readCookie(req, this.cookieName);
    const headerValue = req.headers[this.headerName];
    const headerToken = typeof headerValue === 'string' ? headerValue : undefined;
    if (
      cookieToken === undefined ||
      headerToken === undefined ||
      !CSRF_TOKEN_RE.test(cookieToken) ||
      !constantTimeEquals(cookieToken, headerToken)
    ) {
      throw new ForbiddenException('Invalid or missing CSRF token');
    }
    return true;
  }
}

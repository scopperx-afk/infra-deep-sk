/**
 * `HttpsEnforcementMiddleware` — Security spec §8.2.
 *
 * Redirects plain-HTTP requests to HTTPS. Enforced when `security.httpsEnforcement.enabled`
 * AND the environment is `production` or `staging` (the spec says production; staging is
 * routinely internet-reachable, so it gets the same treatment — SPEC-ERRATA E-S12).
 * `development`/`test` always pass through.
 *
 * "Is this request secure?": `req.secure` (Express, honours `trust proxy`) OR the first
 * `X-Forwarded-Proto` value being `https` — the spec's own rule. Trusting that header
 * unconditionally is acceptable HERE (unlike for client IPs): the worst a spoofer gains is
 * skipping a redirect that exists to protect the spoofer's own connection.
 *
 * Open-redirect hardening: the redirect target is built from the `Host` header, which is
 * attacker-controlled. It is accepted only if it is a syntactically plain host[:port]
 * (letters/digits/dot/hyphen or a bracketed IPv6) — anything else is a 400, never a
 * redirect — and, when `security.allowedHosts` is set, `HostValidationMiddleware` has
 * already pinned it to the allowlist before this runs. The path always starts at `/`.
 *
 * Health probes (`/health/live`, `/health/ready`) are exempt: an orchestrator probes the
 * pod over plain HTTP with no forwarded-proto header, and a redirect there would flap the
 * pod (SPEC-ERRATA E-S12). They return no sensitive data.
 */
import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { CONFIG_SERVICE, type ConfigService } from '../../config';
import type { SecurityConfig } from '../config/security.schema';
import { sendSecurityError } from '../network/security-response';

const PLAIN_HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;
const HEALTH_PATH_RE = /(?:^|\/)health\/(?:live|ready)\/?$/;

function isSecureRequest(req: Request): boolean {
  if (req.secure) return true;
  const forwarded = req.headers['x-forwarded-proto'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim().toLowerCase();
  return first === 'https';
}

@Injectable()
export class HttpsEnforcementMiddleware implements NestMiddleware {
  private readonly enforce: boolean;
  private readonly redirectStatus: number;

  constructor(@Inject(CONFIG_SERVICE) config: ConfigService) {
    const { httpsEnforcement } = config.getNamespace<SecurityConfig>('security');
    const environment = config.getEnvironment();
    this.enforce = httpsEnforcement.enabled && (environment === 'production' || environment === 'staging');
    this.redirectStatus = httpsEnforcement.redirectStatus;
  }

  use(req: Request, res: Response, next: NextFunction): void {
    if (!this.enforce || isSecureRequest(req)) {
      next();
      return;
    }
    const path = req.originalUrl.startsWith('/') ? req.originalUrl : `/${req.originalUrl}`;
    if (HEALTH_PATH_RE.test(path.split('?')[0] as string)) {
      next();
      return;
    }
    const host = req.headers.host;
    if (typeof host !== 'string' || !PLAIN_HOST_RE.test(host)) {
      sendSecurityError(res, 400, 'INVALID_HOST', 'Invalid Host header');
      return;
    }
    res.redirect(this.redirectStatus, `https://${host}${path}`);
  }
}

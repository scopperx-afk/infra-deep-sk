/**
 * `RequestSmugglingGuardMiddleware` — Security spec §16.4.
 *
 * **Threat:** HTTP request smuggling — a front proxy and this server disagree about where a
 * request body ends (`Content-Length` vs `Transfer-Encoding`), letting an attacker prepend
 * bytes to the NEXT user's request. Node's own parser already refuses the classic
 * CL+TE pair by default; this is the explicit, tested second layer (and it also covers a
 * deployment started with `--insecure-http-parser`).
 *
 * Rejected with `400 { code: 'AMBIGUOUS_BODY_FRAMING' }`:
 *  - both `Content-Length` and `Transfer-Encoding` present (§16.4);
 *  - a `Content-Length` that is not a single plain non-negative integer (`5, 6`, `+5`, `0x5`);
 *  - a `Transfer-Encoding` that is not exactly `chunked` (the obfuscations — `xchunked`,
 *    ` chunked`, `chunked, identity` — are how a lenient proxy and a strict backend are
 *    made to disagree; an API request has no legitimate other coding)
 *    (SPEC-ERRATA E-S14 — additive hardening beyond §16.4's sketch).
 */
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { sendSecurityError } from './security-response';

export function hasAmbiguousBodyFraming(headers: Readonly<Record<string, string | string[] | undefined>>): boolean {
  const contentLength = headers['content-length'];
  const transferEncoding = headers['transfer-encoding'];
  if (contentLength !== undefined && transferEncoding !== undefined) return true;
  if (contentLength !== undefined && (typeof contentLength !== 'string' || !/^\d{1,15}$/.test(contentLength))) return true;
  if (
    transferEncoding !== undefined &&
    !(typeof transferEncoding === 'string' && transferEncoding.toLowerCase() === 'chunked')
  ) {
    return true;
  }
  return false;
}

@Injectable()
export class RequestSmugglingGuardMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    if (hasAmbiguousBodyFraming(req.headers)) {
      sendSecurityError(res, 400, 'AMBIGUOUS_BODY_FRAMING', 'Ambiguous request body framing');
      return;
    }
    next();
  }
}

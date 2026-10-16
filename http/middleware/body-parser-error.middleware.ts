/**
 * Normalizes `express.json()`/`express.urlencoded()`'s own errors into real
 * Nest `HttpException`s — a gap HTTP spec §6 doesn't name explicitly but a
 * genuinely necessary piece for §6's own goal ("a request exceeding this is
 * rejected with a clear client-facing error") to actually hold.
 *
 * Verified empirically while building this module: `body-parser` reports an
 * oversized body (and a malformed-JSON body) as plain `http-errors`-style
 * objects — a numeric `.status`, NOT Nest's `HttpException` (no `.getStatus()`
 * method, so `instanceof HttpException` is false). Left unconverted, Errors'
 * `ErrorMapperService` (case 2 checks `instanceof HttpException` specifically,
 * Errors spec §7 point 2) would never recognize it and would fall through to
 * case 4 (Unknown) — a 413/"request too large" silently becoming a generic
 * 500 "Internal server error," which is both the wrong status and a
 * misleading message for a perfectly ordinary client mistake.
 *
 * This file does NOT import Errors (no lateral Layer-1 dependency, HTTP spec
 * §14) — it only constructs ordinary `@nestjs/common` `HttpException`
 * subtypes, the same framework dependency every module already has; Errors'
 * own filter picks them up through its existing, unmodified case 2.
 *
 * An Express ERROR-HANDLING middleware (4-argument signature, Express's own
 * convention for this) — registered via `app.use()` immediately after the
 * body parsers it is normalizing errors FROM.
 */
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import type { ErrorRequestHandler } from 'express';

interface HttpErrorsStyleError extends Error {
  status?: number;
  statusCode?: number;
}

function isHttpErrorsStyle(err: unknown): err is HttpErrorsStyleError {
  if (!(err instanceof Error) || 'getStatus' in err) return false; // already a real HttpException — leave it alone
  const e = err as HttpErrorsStyleError;
  return typeof e.status === 'number' || typeof e.statusCode === 'number';
}

export const normalizeBodyParserErrors: ErrorRequestHandler = (err, _req, _res, next) => {
  if (!isHttpErrorsStyle(err)) {
    next(err); // not a body-parser-shaped error — pass through unchanged
    return;
  }
  const status = err.status ?? err.statusCode;
  switch (status) {
    case 413:
      next(new PayloadTooLargeException(err.message));
      return;
    case 400:
      next(new BadRequestException(err.message));
      return;
    default:
      next(err); // an unrecognized body-parser-ish error — Unknown case still handles it safely (Errors spec §7 point 4)
  }
};

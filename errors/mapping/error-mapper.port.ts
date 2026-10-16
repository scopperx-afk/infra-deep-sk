/**
 * `ErrorMapper` — Errors spec §7. The one authoritative place the four-way
 * `AppError` / `HttpException` / `ZodError` / Unknown branching happens; both
 * `GlobalExceptionFilter` (§8) and `WsExceptionFilter` (§9) call the same
 * instance rather than re-implementing the branching each (Anti-Pattern #5).
 */
import type { ErrorCategory } from '../domain/app-error';
import type { ErrorResponseBody } from '../domain/error-response.port';

export interface MappedError {
  status: number;
  body: ErrorResponseBody;
  /** `'unknown'` only for §7's fourth case — never for a recognized `HttpException`
   *  with an uncommon status (§19's own metric is specifically about true Unknown). */
  category: ErrorCategory | 'unknown';
}

export interface ErrorMapper {
  mapToErrorResponse(exception: unknown): MappedError;
}

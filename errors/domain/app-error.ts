/**
 * The `AppError` hierarchy — Errors spec §3, §4, §6.
 *
 * One unified base, three throwable categories (domain / validation /
 * infrastructure) — "Unknown" is deliberately NOT a fourth class here; it is
 * whatever the mapper (§7) catches that is not `instanceof AppError`. You
 * cannot construct an Unknown on purpose, which is exactly what makes it a
 * trustworthy signal in metrics (§19) rather than a bucket anyone could throw
 * into by mistake.
 *
 * `code`/`httpStatus`/`category`/`retryable` are `readonly` FIELDS, never
 * constructor parameters — so a domain subclass (§12) can override just
 * `code` while inheriting everything else unchanged (Anti-Pattern #8: a
 * subclass overriding `httpStatus`/`category`/`retryable` "just this once" is
 * exactly what this shape is designed to make awkward to do by accident).
 *
 * `code` is explicitly typed `string` on every concrete row below (not left to
 * infer as the narrower string-literal type TypeScript would otherwise pick
 * for a `readonly` field with a literal initializer) — that's what lets §12's
 * subclasses legally override it to a different string. `httpStatus` and
 * `category` are deliberately left to infer as literals: TypeScript then
 * REJECTS a subclass trying to override either to a different value, turning
 * Anti-Pattern #8 into a compile error rather than a code-review reminder.
 */

export type ErrorCategory = 'domain' | 'validation' | 'infrastructure';

export interface AppErrorOptions {
  /** The underlying error being wrapped (a driver/SDK error, a lower-layer AppError). Preserved
   *  on `Error.cause` so the Logger's cause-chain serialization (§11) and Sentry see the REAL
   *  root cause — previously wrapping `new ServiceUnavailableError('db down')` around the
   *  driver error threw that cause away. Never sent to the client. */
  cause?: unknown;
}

export abstract class AppError extends Error {
  abstract readonly category: ErrorCategory;
  abstract readonly code: string;
  abstract readonly httpStatus: number;
  readonly retryable: boolean = false;
  readonly details?: unknown;

  constructor(message: string, details?: unknown, options?: AppErrorOptions) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.details = details;
    // `Error.prototype.name` is "Error", so every subclass used to log, group in Sentry and
    // count as just "Error" — the class name IS the most useful field in an error log line.
    // Non-enumerable so it never leaks into JSON.stringify(err) / extra-field serialization.
    Object.defineProperty(this, 'name', {
      value: new.target.name,
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }

  /**
   * Whether `details` may be sent to the CLIENT. Default: only for client errors (< 500).
   * `details` on a 5xx is by nature server-side context (hosts, ids, driver output) — it is
   * always LOGGED, never returned, unless a subclass deliberately opts in by overriding this.
   */
  get exposeDetails(): boolean {
    return this.httpStatus < 500;
  }
}
// ── Domain (§4, §6) ───────────────────────────────────────────────────────────
export abstract class DomainError extends AppError {
  readonly category = 'domain' as const;
}

export class NotFoundError extends DomainError {
  readonly code: string = 'NOT_FOUND';
  readonly httpStatus = 404;
}

export class ConflictError extends DomainError {
  readonly code: string = 'CONFLICT';
  readonly httpStatus = 409;
}

// ── Validation (§4, §6) ────────────────────────────────────────────────────────
export interface FieldError {
  path: string;
  message: string;
}

export class ValidationError extends AppError {
  readonly category = 'validation' as const;
  readonly code: string = 'VALIDATION_ERROR';
  readonly httpStatus = 400;
  declare readonly details: FieldError[];

  constructor(message: string, details: FieldError[], options?: AppErrorOptions) {
    super(message, details, options);
  }
}

// ── Infrastructure (§4, §6) ────────────────────────────────────────────────────
export abstract class InfrastructureError extends AppError {
  readonly category = 'infrastructure' as const;
}

export class UnauthorizedError extends InfrastructureError {
  readonly code: string = 'UNAUTHORIZED';
  readonly httpStatus = 401;
}

export class ForbiddenError extends InfrastructureError {
  readonly code: string = 'FORBIDDEN';
  readonly httpStatus = 403;
}

export class RateLimitedError extends InfrastructureError {
  readonly code: string = 'RATE_LIMITED';
  readonly httpStatus = 429;
  override readonly retryable = true;
}

export class ServiceUnavailableError extends InfrastructureError {
  readonly code: string = 'SERVICE_UNAVAILABLE';
  readonly httpStatus = 503;
  override readonly retryable = true;
}

export class TimeoutError extends InfrastructureError {
  readonly code: string = 'TIMEOUT';
  readonly httpStatus = 504;
  override readonly retryable = true;
}

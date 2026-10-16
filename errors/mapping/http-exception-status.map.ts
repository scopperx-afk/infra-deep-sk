/**
 * Status → `{ code, category, retryable }` fallback for a Nest `HttpException`
 * that isn't `instanceof AppError` — Errors spec §7 point 2. Reuses §6's own
 * strings where the status aligns (404→`NOT_FOUND`, 401→`UNAUTHORIZED`, …).
 *
 * A status NOT in this table (e.g. a bare `new HttpException('teapot', 418)`)
 * gets `code: 'INTERNAL_ERROR'`. §7/§19 leave its CATEGORY unstated — spec gap,
 * not a contradiction (see SPEC-ERRATA.md E-E2): this implementation reports
 * `'infrastructure'` for any recognized-but-uncommon `HttpException` status,
 * since it IS a recognized, structured framework exception (never nobody's
 * fault, unlike true case-4 Unknown) — `errorsByCategory.unknown` stays a pure
 * signal of §3's actual fallback case, per §19's own stated intent.
 */
import type { ErrorCategory } from '../domain/app-error';

export interface StatusMapping {
  code: string;
  category: ErrorCategory;
  retryable: boolean;
}

export const HTTP_EXCEPTION_STATUS_MAP: ReadonlyMap<number, StatusMapping> =
  new Map([
    [
      400,
      { code: 'VALIDATION_ERROR', category: 'validation', retryable: false },
    ],
    [
      401,
      { code: 'UNAUTHORIZED', category: 'infrastructure', retryable: false },
    ],
    [403, { code: 'FORBIDDEN', category: 'infrastructure', retryable: false }],
    [404, { code: 'NOT_FOUND', category: 'domain', retryable: false }],
    [405, { code: 'METHOD_NOT_ALLOWED', category: 'validation', retryable: false }],
    [406, { code: 'NOT_ACCEPTABLE', category: 'validation', retryable: false }],
    [408, { code: 'REQUEST_TIMEOUT', category: 'infrastructure', retryable: true }],
    [409, { code: 'CONFLICT', category: 'domain', retryable: false }],
    [410, { code: 'GONE', category: 'domain', retryable: false }],
    [413, { code: 'PAYLOAD_TOO_LARGE', category: 'validation', retryable: false }],
    [415, { code: 'UNSUPPORTED_MEDIA_TYPE', category: 'validation', retryable: false }],
    [422, { code: 'UNPROCESSABLE_ENTITY', category: 'validation', retryable: false }],
    [
      429,
      { code: 'RATE_LIMITED', category: 'infrastructure', retryable: true },
    ],
    [500, { code: 'INTERNAL_ERROR', category: 'infrastructure', retryable: false }],
    [501, { code: 'NOT_IMPLEMENTED', category: 'infrastructure', retryable: false }],
    [502, { code: 'BAD_GATEWAY', category: 'infrastructure', retryable: true }],
    [
      503,
      {
        code: 'SERVICE_UNAVAILABLE',
        category: 'infrastructure',
        retryable: true,
      },
    ],
    [504, { code: 'TIMEOUT', category: 'infrastructure', retryable: true }],
  ]);

/** An unlisted SERVER status (5xx). */
export const DEFAULT_HTTP_EXCEPTION_MAPPING: StatusMapping = {
  code: 'INTERNAL_ERROR',
  category: 'infrastructure',
  retryable: false,
};

/** An unlisted CLIENT status (4xx). The first version mapped every unlisted status — including
 *  413/415/422/405 — to `INTERNAL_ERROR`, so a client mistake looked like a server fault in the
 *  body AND in `errorsByCode`, and an alert keyed on INTERNAL_ERROR fired on user error. */
export const DEFAULT_CLIENT_ERROR_MAPPING: StatusMapping = {
  code: 'CLIENT_ERROR',
  category: 'validation',
  retryable: false,
};

export function mapHttpExceptionStatus(status: number): StatusMapping {
  return (
    HTTP_EXCEPTION_STATUS_MAP.get(status) ??
    (status >= 400 && status < 500
      ? DEFAULT_CLIENT_ERROR_MAPPING
      : DEFAULT_HTTP_EXCEPTION_MAPPING)
  );
}

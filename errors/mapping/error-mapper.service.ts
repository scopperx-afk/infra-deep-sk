/**
 * `ErrorMapperService` — Errors spec §7 (the four-way branch), §10 (dev/prod
 * split), §5 (`traceId` population). The one implementation both filters share.
 */
import { Inject, Injectable } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import { ZodError, type ZodIssue } from 'zod';
import { CONFIG_SERVICE, type ConfigService } from '../../config';
import { AppError } from '../domain/app-error';
import type { FieldError } from '../domain/app-error';
import type { ErrorResponseBody } from '../domain/error-response.port';
import { mapHttpExceptionStatus } from './http-exception-status.map';
import type { ErrorMapper, MappedError } from './error-mapper.port';
import { getTraceContext, deriveContext } from '../../tracing';

const UNKNOWN_MESSAGE = 'Internal server error';
const ZOD_MESSAGE = 'Validation failed';

/** Upper bound on `details` entries / message length sent to a client. 5000 invalid array items
 *  used to produce a 300 KB 400 response (and a 300 KB log payload) from a ~50 KB request. */
const MAX_FIELD_ERRORS = 50;
const MAX_CLIENT_MESSAGE_CHARS = 1_000;

/** A 5xx `HttpException`'s own message is server-side text (`'Redis node 10.0.3.4 refused'`,
 *  `'SELECT … failed'`, a library's internal wording) — outside development it is replaced by a
 *  fixed, status-appropriate one. The real message is still LOGGED. */
const GENERIC_5XX_MESSAGES: ReadonlyMap<number, string> = new Map([
  [501, 'Not implemented'],
  [502, 'Bad gateway'],
  [503, 'Service unavailable'],
  [504, 'Gateway timeout'],
]);

/** A status that can legitimately be sent as an HTTP ERROR. A subclass that sets
 *  `httpStatus = 200` (or a string / NaN) used to produce `200 OK` with an error body. */
function normalizeStatus(status: unknown): number {
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599
    ? status
    : 500;
}

const clip = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max)}…` : s;

/** Caps a FieldError-style array; leaves any other `details` shape untouched. */
function capDetails(details: unknown): unknown {
  if (!Array.isArray(details) || details.length <= MAX_FIELD_ERRORS) return details;
  return [
    ...details.slice(0, MAX_FIELD_ERRORS),
    { path: '', message: `${details.length - MAX_FIELD_ERRORS} more errors omitted` },
  ];
}

/** `http-errors` / body-parser / multer-style client errors that are NOT Nest `HttpException`s
 *  (they carry a numeric `status`/`statusCode` and `expose: true`) used to fall into the
 *  "Unknown" bucket: a 413 or a malformed-JSON 400 raised outside Nest's own pipeline was
 *  reported as `500 INTERNAL_ERROR` and counted as an un-classified bug. */
function httpErrorLikeStatus(exception: unknown): number | undefined {
  if (typeof exception !== 'object' || exception === null) return undefined;
  const e = exception as { status?: unknown; statusCode?: unknown; expose?: unknown };
  const status = e.status ?? e.statusCode;
  return typeof status === 'number' &&
    Number.isInteger(status) &&
    status >= 400 &&
    status < 500 &&
    e.expose === true
    ? status
    : undefined;
}

/** `['author', 'email']` → `'author.email'`; `['tags', 0]` → `'tags.0'`; `[]` → `''` (§7 point 3). */
function joinZodPath(path: ReadonlyArray<PropertyKey>): string {
  // zod/v4 paths are `PropertyKey[]` — a symbol key makes `Array.prototype.join` THROW.
  return path.map((p) => String(p)).join('.');
}

/** A per-issue cap. Zod's own messages for `invalid_enum_value` / `invalid_literal` / `unrecognized_keys`
 *  QUOTE the offending input: a 90 KB string in an enum field produced a 90 KB `details[].message`
 *  (reproduced) — attacker-chosen content reflected back, bounded only by the body limit. */
const MAX_ISSUE_MESSAGE_CHARS = 200;
const MAX_ISSUE_PATH_CHARS = 200;

function flattenZodIssues(issues: readonly ZodIssue[]): FieldError[] {
  return issues.map((issue) => ({
    path: clip(joinZodPath(issue.path), MAX_ISSUE_PATH_CHARS),
    message: clip(String(issue.message), MAX_ISSUE_MESSAGE_CHARS),
  }));
}

/**
 * Recognises a ZodError WITHOUT depending on class identity. `instanceof ZodError` is false for an error
 * constructed by ANOTHER COPY of zod — a duplicated dependency (pnpm / monorepo / a library that bundles its
 * own), or `zod/v4`, which the pinned 3.25 package ships at that subpath and which current documentation
 * recommends. Such an error fell through to the Unknown case: a plain client mistake became
 * `500 INTERNAL_ERROR` and was logged at ERROR (reproduced). Zod's own contract — `name === 'ZodError'` and an
 * `issues` array of `{ path, message }` — is identical across v3 and v4.
 */
function isZodErrorLike(e: unknown): e is { issues: ZodIssue[] } {
  if (e instanceof ZodError) return true;
  if (typeof e !== 'object' || e === null) return false;
  const c = e as { name?: unknown; issues?: unknown };
  return c.name === 'ZodError' && Array.isArray(c.issues);
}

/** Nest's `HttpException.getResponse()` returns either a plain string or an object whose
 *  `message` is a string OR a string array (Nest's own built-ins, e.g. `BadRequestException`
 *  with an array of validation messages) — §7 point 2 asks for both string and object shapes
 *  to be handled; an array is joined into one string since the wire body's `message` is
 *  always a single string (§5). */
function extractHttpExceptionMessage(exception: HttpException): string {
  const response = exception.getResponse();
  if (typeof response === 'string') return response;
  if (response && typeof response === 'object') {
    const message = (response as { message?: unknown }).message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message))
      return message
        .filter((m): m is string => typeof m === 'string')
        .join('; ');
  }
  return exception.message;
}

/** The Unknown-case `details` shape for the WIRE RESPONSE (§10) — a small, self-contained
 *  helper distinct from Logger's own serialization (§11), which governs the LOG LINE, not
 *  the HTTP body. Never used when `isProduction()` is true. */
function devDetails(
  exception: unknown,
  includeStack: boolean,
): { name: string; message: string; stack?: string } {
  if (exception instanceof Error) {
    return {
      name: exception.name,
      message: exception.message,
      ...(includeStack && typeof exception.stack === 'string' ? { stack: exception.stack } : {}),
    };
  }
  return { name: 'NonError', message: safeString(exception) };
}

function safeString(value: unknown): string {
  try {
    return typeof value === 'string'
      ? value
      : (JSON.stringify(value) ?? String(value));
  } catch {
    return String(value);
  }
}

@Injectable()
export class ErrorMapperService implements ErrorMapper {
  constructor(@Inject(CONFIG_SERVICE) private readonly config: ConfigService) {}

  /**
   * Never throws. The mapper runs INSIDE the exception filter: if it threw (an exception whose
   * `getResponse()`/`message` getter throws, a hostile object), the original error would be
   * replaced by the mapper's own failure and the client would get nothing useful.
   */
  mapToErrorResponse(exception: unknown): MappedError {
    try {
      return this.map(exception);
    } catch {
      return {
        status: 500,
        body: { code: 'INTERNAL_ERROR', message: UNKNOWN_MESSAGE },
        category: 'unknown',
      };
    }
  }

  /** Development / test only: dev conveniences (internal messages, `details` on 5xx, `name`+`message`
   *  of unknown errors). Deliberately NOT "everything except production": `staging`, previews and a
   *  mis-set NODE_ENV are routinely internet-reachable, and they used to receive full stack traces. */
  private exposeInternals(): boolean {
    const env = this.config.getEnvironment();
    return env === 'development' || env === 'test';
  }

  /** Stack traces only in `development` — never in `test`, never anywhere else. */
  private exposeStack(): boolean {
    return this.config.getEnvironment() === 'development';
  }

  private map(exception: unknown): MappedError {
    const traceId = (getTraceContext() ?? deriveContext()).traceId;
    const withTrace = (body: ErrorResponseBody): ErrorResponseBody => {
      if (traceId !== undefined) body.traceId = traceId;
      return body;
    };

    // ── case 1: AppError (or a domain subclass, §12) ──────────────────────────
    if (exception instanceof AppError) {
      const status = normalizeStatus(exception.httpStatus);
      const body: ErrorResponseBody = {
        code: String(exception.code),
        message: clip(String(exception.message), MAX_CLIENT_MESSAGE_CHARS),
      };
      // `details` is client-visible for client errors only (see AppError.exposeDetails) —
      // a 503 carrying `{ host, password }` used to return both verbatim.
      if (
        exception.details !== undefined &&
        (exception.exposeDetails || this.exposeInternals())
      )
        body.details = capDetails(exception.details);
      return { status, body: withTrace(body), category: exception.category };
    }

    // ── case 2: Nest's own HttpException tree ─────────────────────────────────
    if (exception instanceof HttpException) {
      const status = normalizeStatus(exception.getStatus());
      const { code, category } = mapHttpExceptionStatus(status);
      let message = extractHttpExceptionMessage(exception);
      if (status >= 500 && !this.exposeInternals())
        message = GENERIC_5XX_MESSAGES.get(status) ?? UNKNOWN_MESSAGE;
      return {
        status,
        body: withTrace({ code, message: clip(message, MAX_CLIENT_MESSAGE_CHARS) }),
        category,
      };
    }

    // ── case 2b: http-errors-style client error raised outside Nest's pipeline ──
    const likeStatus = httpErrorLikeStatus(exception);
    if (likeStatus !== undefined) {
      const { code, category } = mapHttpExceptionStatus(likeStatus);
      return {
        status: likeStatus,
        body: withTrace({
          code,
          message: clip(String((exception as { message?: unknown }).message ?? ''), MAX_CLIENT_MESSAGE_CHARS),
        }),
        category,
      };
    }

    // ── case 3: a raw ZodError ─────────────────────────────────────────────────
    if (isZodErrorLike(exception)) {
      return {
        status: 400,
        body: withTrace({
          code: 'VALIDATION_ERROR',
          message: ZOD_MESSAGE,
          details: capDetails(flattenZodIssues(exception.issues)),
        }),
        category: 'validation',
      };
    }

    // ── case 4: Unknown — never a class, always this fallback (§3) ────────────
    const body: ErrorResponseBody = {
      code: 'INTERNAL_ERROR',
      message: UNKNOWN_MESSAGE,
    };
    if (this.exposeInternals()) body.details = devDetails(exception, this.exposeStack());
    return { status: 500, body: withTrace(body), category: 'unknown' };
  }
}

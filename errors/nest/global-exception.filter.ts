/**
 * `GlobalExceptionFilter` — Errors spec §8. Registered globally via Nest's
 * `APP_FILTER` token by `ErrorsModule` (§15) — this is HTTP's own pipeline
 * step 11, the last stage HTTP only ever *lets run*, never implements itself
 * (HTTP spec §18 Anti-Pattern #4).
 *
 * `res` is duck-typed (`status().json()`), not `express.Response` — matching
 * Logger's own `nest/logger.middleware.ts` choice not to add a real Express/
 * Fastify dependency for a shape this small.
 *
 * Hardening over the first implementation (review findings):
 *  - the filter itself NEVER throws — it is the last line of defence, and a throw here
 *    replaces the original error (an AppError whose `details` was circular became a generic
 *    500; a response already started raised ERR_HTTP_HEADERS_SENT out of the filter);
 *  - a response whose headers were already sent (streaming, a timeout that already answered)
 *    is aborted instead of re-written;
 *  - a non-HTTP host (rpc/graphql) is logged and the ORIGINAL exception re-thrown, not masked
 *    by a `TypeError: undefined.status`;
 *  - error responses are `Cache-Control: no-store`;
 *  - log level follows the outcome (see `exception-logging.ts`).
 */
import {
  Catch,
  Inject,
  Injectable,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { ILogger } from '../../logger';
import { LOGGER_SERVICE } from '../../logger';
import { ERROR_MAPPER, ERRORS_METRICS_COLLECTOR } from '../errors.tokens';
import type { ErrorMapper, MappedError } from '../mapping/error-mapper.port';
import type { ErrorsMetricsCollector } from '../metrics/errors.metrics';
import { logCaughtException } from './exception-logging';

interface MinimalHttpResponse {
  headersSent?: boolean;
  status(code: number): { json(body: unknown): unknown };
  setHeader?(name: string, value: string): unknown;
  /** Destroys the socket — the only way to tell the client a half-sent response is broken. */
  destroy?(): unknown;
  end?(): unknown;
}

@Catch()
@Injectable()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(
    @Inject(ERROR_MAPPER) private readonly mapper: ErrorMapper,
    @Inject(LOGGER_SERVICE) private readonly logger: ILogger,
    @Inject(ERRORS_METRICS_COLLECTOR)
    private readonly metrics: ErrorsMetricsCollector,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const mapped = this.mapper.mapToErrorResponse(exception);
    logCaughtException(this.logger, exception, mapped); // §11 — the one guaranteed logging call site
    try {
      this.metrics.record(mapped.category, mapped.status, mapped.body.code); // §19
    } catch {
      /* metrics must never break error handling */
    }

    if (typeof host.getType === 'function' && host.getType() !== 'http') throw exception;

    const res = host.switchToHttp().getResponse<MinimalHttpResponse | undefined>();
    if (!res) return;
    if (res.headersSent) {
      this.abort(res);
      return;
    }
    this.send(res, mapped);
  }

  private send(res: MinimalHttpResponse, { status, body }: MappedError): void {
    try {
      res.setHeader?.('Cache-Control', 'no-store');
    } catch {
      /* best-effort header */
    }
    try {
      res.status(status).json(body);
    } catch {
      // `json()` stringifies BEFORE writing, so a throw here means nothing was sent: typically
      // a `details` value that cannot be serialized (circular, BigInt). Keep the status and
      // code — the client still learns WHAT happened — and drop only the offending details.
      try {
        res.status(status).json({
          code: body.code,
          message: body.message,
          ...(body.traceId !== undefined ? { traceId: body.traceId } : {}),
        });
      } catch {
        this.abort(res);
      }
    }
  }

  private abort(res: MinimalHttpResponse): void {
    try {
      if (typeof res.destroy === 'function') res.destroy();
      else res.end?.();
    } catch {
      /* nothing left to try */
    }
  }
}

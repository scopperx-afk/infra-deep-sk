/**
 * The ONE place that decides how a caught exception is logged — shared by the HTTP and WS
 * filters so the two can never drift apart (Anti-Pattern #5 applied to logging).
 *
 * The first implementation logged EVERY exception at ERROR with the message "Unhandled
 * exception" — a 404, a 400 validation failure, a 409 conflict, a scanner probing random URLs.
 * Consequences: every alert on `level=error` fired on user mistakes, every Sentry-forwarded
 * error (the Logger sends error/fatal) was a bad request, and "Unhandled" was simply false for
 * an error the application threw on purpose. Level now follows the OUTCOME:
 *
 *   unknown (case 4, a real un-classified bug)  → ERROR  "Unhandled exception"  (+ stack)
 *   5xx (known infra failure: 503, 504, …)      → ERROR  "Request failed"        (+ stack)
 *   401 / 403 / 429 (security-relevant)         → WARN   "Request rejected"      (no stack)
 *   every other 4xx (client error)              → INFO   "Request rejected"      (no stack)
 *
 * It must never throw: it runs inside an exception filter, where a failure would replace the
 * very error being reported.
 */
import type { ILogger } from '../../logger';
import type { MappedError } from '../mapping/error-mapper.port';

export function logCaughtException(
  logger: ILogger,
  exception: unknown,
  mapped: MappedError,
  channel: 'http' | 'ws' = 'http',
): void {
  try {
    const { status, body, category } = mapped;
    const meta = { code: body.code, status };
    const prefix = channel === 'ws' ? 'WS ' : '';

    if (category === 'unknown') {
      logger.error(`Unhandled ${channel === 'ws' ? 'WS ' : ''}exception`, exception, meta);
    } else if (status >= 500) {
      logger.error(`${prefix}Request failed`, exception, meta);
    } else {
      const errorName = exception instanceof Error ? exception.name : typeof exception;
      if (status === 401 || status === 403 || status === 429)
        logger.warn(`${prefix}Request rejected`, { ...meta, errorName });
      else logger.info(`${prefix}Request rejected`, { ...meta, errorName });
    }
  } catch {
    /* logging must never break error handling */
  }
}

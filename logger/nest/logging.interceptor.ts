/**
 * LoggingInterceptor — Logger spec §30, §31. Logs exactly once per request, at
 * completion (success or error) — never per-line-of-business-logic — with the
 * `durationMs` computed from `LogContext.startTime` (§8, set by
 * `LoggerMiddleware`), never itself stored as a raw field (§8's own rule: only
 * the derived duration is ever a log field, not the raw timestamp).
 *
 * Framework-level (`ExecutionContext`/`CallHandler` are core NestJS, not part
 * of an HTTP module that doesn't exist yet); `context.switchToHttp()` is
 * itself framework-provided regardless.
 */
import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Observable, catchError, tap, throwError } from 'rxjs';
import type { ILogger } from '../logger.port';
import { getLogContext } from '../context/log-context.store';
import { LOGGER_SERVICE } from '../logger.tokens';

interface MinimalHttpResponse {
  statusCode?: number;
}

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  constructor(@Inject(LOGGER_SERVICE) private readonly logger: ILogger) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const startTime = getLogContext()?.startTime ?? Date.now();

    return next.handle().pipe(
      tap(() => {
        const res = context.switchToHttp().getResponse<MinimalHttpResponse>();
        this.logger.info('HTTP request completed', {
          durationMs: Date.now() - startTime,
          statusCode: res?.statusCode,
        });
      }),
      catchError((err: unknown) => {
        this.logger.error('HTTP request failed', err, {
          durationMs: Date.now() - startTime,
        });
        return throwError(() => err);
      }),
    );
  }
}

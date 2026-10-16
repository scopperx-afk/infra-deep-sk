/**
 * `WsExceptionFilter` — Errors spec §9. A separate class from
 * `GlobalExceptionFilter`, not one filter branching on `host.getType()`,
 * because HTTP and WebSocket are genuinely different response mechanics
 * (`res.status().json()` vs. a socket `emit`) — both share the exact same
 * `ERROR_MAPPER` (§7), so the mapping decision itself is authored once, and the
 * exact same logging policy (`exception-logging.ts`).
 *
 * Applied per-gateway via `@UseFilters(WsExceptionFilter)` (§17) — Nest's
 * `APP_FILTER` global registration does not reliably reach WebSocket gateways
 * the way it does HTTP controllers, so this class is exported (§17) rather
 * than assumed globally wired, unlike `GlobalExceptionFilter`.
 *
 * The exact event name/payload shape a Realtime client receives is that
 * module's own integration surface, not yet specified (§9) — `emit('error',
 * body)` is illustrative of the pattern; what's fixed is that `body` is the
 * identical `ErrorResponseBody` (§5) the HTTP path produces.
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
import type { ErrorMapper } from '../mapping/error-mapper.port';
import type { ErrorsMetricsCollector } from '../metrics/errors.metrics';
import { logCaughtException } from './exception-logging';

interface MinimalWsClient {
  emit(event: string, payload: unknown): unknown;
}

@Catch()
@Injectable()
export class WsExceptionFilter implements ExceptionFilter {
  constructor(
    @Inject(ERROR_MAPPER) private readonly mapper: ErrorMapper,
    @Inject(LOGGER_SERVICE) private readonly logger: ILogger,
    @Inject(ERRORS_METRICS_COLLECTOR)
    private readonly metrics: ErrorsMetricsCollector,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const mapped = this.mapper.mapToErrorResponse(exception); // same mapper as HTTP (§7)
    logCaughtException(this.logger, exception, mapped, 'ws');
    try {
      this.metrics.record(mapped.category, mapped.status, mapped.body.code);
    } catch {
      /* metrics must never break error handling */
    }
    try {
      host.switchToWs().getClient<MinimalWsClient | undefined>()?.emit('error', mapped.body);
    } catch {
      /* a disconnected/invalid client must not turn error reporting into a second error */
    }
  }
}

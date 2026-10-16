/**
 * errors/index.ts — the ONLY public surface of the Errors module (§17),
 * mirroring config/index.ts's, tracing/index.ts's, and logger/index.ts's own
 * role. Everything else (the mapper's internal helpers, the status-fallback
 * table, the metrics collector's internals) is unreachable from outside
 * `errors/`, enforced by the same ESLint boundary rule every other module uses.
 */
export {
  AppError,
  DomainError,
  InfrastructureError,
  NotFoundError,
  ConflictError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  RateLimitedError,
  ServiceUnavailableError,
  TimeoutError,
} from './domain/app-error';
export type { ErrorCategory, FieldError } from './domain/app-error';
export type { ErrorResponseBody } from './domain/error-response.port';
export type { ErrorMapper, MappedError } from './mapping/error-mapper.port';
export type {
  ErrorsMetricsCollector,
  ErrorsMetricsSnapshot,
} from './metrics/errors.metrics';
export { ERROR_MAPPER, ERRORS_METRICS_COLLECTOR } from './errors.tokens'; // see errors.tokens.ts (SPEC-ERRATA E-E1)
export { ErrorsModule } from './errors.module';
export { GlobalExceptionFilter, WsExceptionFilter } from './nest';

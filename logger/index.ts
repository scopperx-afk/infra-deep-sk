/**
 * logger/index.ts — the ONLY public surface of the Logger module (§37),
 * mirroring config/index.ts's and tracing/index.ts's own role. Everything else
 * (the redactor, sampler, entry-builder, transport dispatcher, the concrete
 * Console transport, the internal tokens) is unreachable from outside
 * `logger/`, enforced by the same ESLint boundary rule Config and Tracing use.
 */
export { LoggerModule } from './logger.module';
export { LOGGER_RUNTIME, LOGGER_SERVICE } from './logger.tokens'; // NOT the internal ones (§37)
import type { LoggerService } from '@nestjs/common';
import type { ILogger } from './logger.port';
export type {
  HealthStatus,
  ILogger,
  LogContext,
  LogDropReason,
  LogEntry,
  LogLevel,
  LogMetadata,
  LogMetadataInput,
  LoggerContext,
  LoggerExtraTransport,
  LoggerHealth,
  LoggerMetricsSnapshot,
  LoggerModuleOptions,
  LoggerRuntime,
  SerializedError,
} from './logger.port';
export { LOG_LEVEL_ORDER, isLogLevel } from './logger.port';

// §8 — the one context function this module exports outward (never the ALS store itself).
export { enrichLogContext } from './context/log-context.store';

// §16 — the sanctioned way to bypass sampling for one call (never the raw LOG_FORCE symbol).
export { forceLog } from './sampling/log-sampler';

// §18 — the contract a project implements to add its own transport (File/HTTP/Sentry, §42).
export type {
  LogTransport,
  TransportHealth,
} from './transports/transport.interface';

// §31 — HTTP wires these; §31's own table (LoggingInterceptor measures/logs completion,
// LoggerAuthEnrichmentInterceptor is HTTP-owned and calls enrichLogContext() itself).
export { LoggerMiddleware } from './nest/logger.middleware';
export { LoggingInterceptor } from './nest/logging.interceptor';

// §32 — decorators.
export { InjectLogger } from './decorators/inject-logger.decorator';
export { LogMethod } from './decorators/log-method.decorator';
export type { LogMethodOptions } from './decorators/log-method.decorator';

// §27, §28 — usable before/without the DI graph.
export { BootstrapLogger } from './bootstrap/bootstrap-logger';
export type { BootstrapLoggerOptions } from './bootstrap/bootstrap-logger';
export { emergencyLog } from './bootstrap/emergency-logger';

// §13-equivalent testing utility — matches config/index.ts's staticSource and
// tracing/index.ts's withTraceContext for exactly the same reason.
export { withLogContext } from './testing/with-log-context';

/**
 * Combined type for NestJS's `app.useLogger()` compatibility surface
 * (Logger spec §29). Exposes ILogger + the Nest-mapping methods
 * (`log`, `verbose`, `nestError`, ...) that ILogger itself doesn't declare,
 * because they're only ever called by Nest — not by application code.
 */
export type NestCompatibleLogger = ILogger &
  Pick<LoggerService, 'log' | 'verbose' | 'debug' | 'warn' | 'error' | 'fatal'>;

/**
 * `ErrorsModule` — Errors spec §15, §17. Takes no `forRoot()` options at MVP:
 * unlike Config, there's nothing per-consumer to register (§17, same shape as
 * `LoggerModule`, minus the options object). `AppModule`, the composition
 * root, imports this once, plainly (`imports: [ErrorsModule]`) — nothing else
 * imports it directly; Nest's own token system (`APP_FILTER`) or ordinary DI
 * injection of `ERROR_MAPPER` reaches it from anywhere else.
 *
 * `@Global()` — not a `forRoot()`-style dynamic module, since §17 is explicit
 * this module takes no options at all — is what actually satisfies §17's own
 * claim that a future Realtime gateway resolves `ERROR_MAPPER` "with no direct
 * import of ErrorsModule required": a plain `@Module()` with no `@Global()`
 * would still require every consumer to list `ErrorsModule` in its own
 * `imports`, which is exactly the per-consumer coordination §17 says isn't
 * needed.
 */
import { APP_FILTER } from '@nestjs/core';
import { Global, Module } from '@nestjs/common';
import { GlobalExceptionFilter } from './nest';
import { ErrorMapperService } from './mapping/error-mapper.service';
import { ErrorsMetricsCollectorService } from './metrics/errors.metrics';
import { ERROR_MAPPER, ERRORS_METRICS_COLLECTOR } from './errors.tokens';

@Global()
@Module({
  providers: [
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: ERROR_MAPPER, useClass: ErrorMapperService },
    {
      provide: ERRORS_METRICS_COLLECTOR,
      useClass: ErrorsMetricsCollectorService,
    },
  ],
  exports: [ERROR_MAPPER, ERRORS_METRICS_COLLECTOR], // see errors.tokens.ts on the second one (SPEC-ERRATA E-E1)
})
export class ErrorsModule {}

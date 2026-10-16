/**
 * `HttpModule` — HTTP spec §3, §15, §16. `@Global()`, matching every other
 * module's own pattern: `RequestContextService` and the `READINESS_PROVIDER`
 * extension point both need to be reachable without every consumer
 * re-importing this module.
 *
 * `configure()` wires the three `NestMiddleware` classes IN ORDER — §3 steps
 * 1, 2, 3 (`TraceBindingMiddleware`, `RequestContextMiddleware`,
 * `LoggerMiddleware`) — `LoggerMiddleware` is Logger's OWN exported class
 * (Logger spec §31); Logger does not know about routes, so wiring it onto
 * `forRoutes('*')` is HTTP's job, not Logger's.
 *
 * `LoggerAuthEnrichmentInterceptor` (§3 step 6a, §13) is registered globally
 * via `APP_INTERCEPTOR` — it is a FIXED part of the numbered pipeline, not an
 * opt-in a project must remember to wire, and it is a safe no-op wherever
 * `req.user` doesn't exist yet (no Security built).
 *
 * ⚠️ AppModule import order requirement (HTTP spec §12, matching Tracing's
 * and Logger's own such notes): `HttpModule` must be imported BEFORE
 * `TracingModule` and `LoggerModule` so `installGracefulShutdown()`'s drain
 * step (§12) completes before `app.close()` triggers their own
 * `OnApplicationShutdown` hooks.
 */
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Global, Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { ConfigModule } from '../config';
import { LoggerMiddleware } from '../logger';
import { httpConfigSchema } from './config/http.schema';
import { TraceBindingMiddleware } from './middleware/trace-binding.middleware';
import { RequestContextMiddleware } from './middleware/request-context.middleware';
import { LoggerAuthEnrichmentInterceptor } from './interceptors/logger-auth-enrichment.interceptor';
import { RequestContextService } from './context/request-context.service';
import { requestContextStore } from './context/request-context.store';
import { HealthController } from './health/health.controller';
import { REQUEST_CONTEXT_SERVICE, REQUEST_CONTEXT_STORE } from './http.tokens';

@Global()
@Module({
  imports: [ConfigModule.forFeature('http', httpConfigSchema)],
  controllers: [HealthController],
  providers: [
    { provide: REQUEST_CONTEXT_STORE, useValue: requestContextStore },
    RequestContextService,
    { provide: REQUEST_CONTEXT_SERVICE, useExisting: RequestContextService },
    { provide: APP_INTERCEPTOR, useClass: LoggerAuthEnrichmentInterceptor },
  ],
  exports: [REQUEST_CONTEXT_SERVICE],
})
export class HttpModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TraceBindingMiddleware, RequestContextMiddleware, LoggerMiddleware).forRoutes('*');
  }
}

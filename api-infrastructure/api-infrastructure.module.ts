/**
 * `ApiInfrastructureModule` — API Infrastructure spec §10, §12.
 *
 * Registers its own `api.*` Config namespace (`forFeature`, with the secret-key path declared per
 * Config §7.5), exposes the frozen resolved config as `API_CONFIG`, and attaches to HTTP's
 * pipeline through Nest's own `APP_INTERCEPTOR` token — never by HTTP importing this module or
 * the reverse (HTTP spec §14; spec §2: no Layer 1 siblings, no Layer 2).
 *
 * Plain `@Global()` module with no `forRoot()` (E-A10) — the same shape Errors, Validation and
 * HTTP already have. Nothing here is configured through code; every knob is an `api.*` key.
 *
 * ── Composition-root ORDER matters (E-A15) ──────────────────────────────────────────────────
 * Nest nests global interceptors in registration order: the FIRST registered is OUTERMOST.
 * Idempotency spec §8.2 needs to cache the response the client actually receives — i.e. AFTER
 * enveloping — so `IdempotencyModule` must be imported BEFORE this module in `AppModule`:
 *
 *     imports: [ ..., IdempotencyModule, ApiInfrastructureModule, ... ]
 *
 * (`API_INFRASTRUCTURE_GUIDE.md` §"Composition root" shows the full import list, and
 * `integration/idempotency-order.spec.ts` pins the behaviour with a stand-in outer interceptor.)
 */
import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { CONFIG_SERVICE, ConfigModule, type ConfigService } from '../config';
import { apiConfigSchema, type ApiConfig } from './config/api.schema';
import { API_CONFIG } from './api-infrastructure.tokens';
import { DeprecationInterceptor } from './interceptors/deprecation.interceptor';
import { EnvelopeInterceptor } from './interceptors/envelope.interceptor';
import { configureApiRuntime } from './runtime/api-runtime';

@Global()
@Module({
  imports: [
    ConfigModule.forFeature('api', apiConfigSchema, { secretPaths: ['cursor.signingKeys'] }),
  ],
  providers: [
    {
      provide: API_CONFIG,
      inject: [CONFIG_SERVICE],
      // The runtime snapshot is filled HERE — at provider instantiation, before any request and
      // regardless of whether the host calls `init()` (a bare `Test.compile()` never fires
      // `onModuleInit`, and the static pagination schemas must not depend on that).
      useFactory: (config: ConfigService): ApiConfig => {
        const api = config.getNamespace<ApiConfig>('api');
        configureApiRuntime({
          pagination: {
            defaultLimit: api.pagination.defaultLimit,
            maxLimit: api.pagination.maxLimit,
            maxPage: api.pagination.maxPage,
          },
          cursorSigningKeys: api.cursor.signingKeys ?? [],
        });
        return api;
      },
    },
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
    { provide: APP_INTERCEPTOR, useClass: DeprecationInterceptor },
  ],
  exports: [API_CONFIG],
})
export class ApiInfrastructureModule {}

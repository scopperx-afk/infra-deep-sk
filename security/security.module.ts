/**
 * `SecurityModule.forRoot()` — Security spec §22.
 *
 * What it wires:
 *  - Config: registers the `security` namespace and (interim, SPEC-ERRATA E-S6) the `tokens`
 *    namespace through `ConfigModule.forFeature()`, plus the production cross-validation
 *    (`security.cross-validation.ts`) through `CONFIG_REGISTRY` — every rule fails the boot
 *    loudly, all at once, never at the first request;
 *  - `AuthGuard` via `APP_GUARD` (global, default-deny; `@Public()` opts out) and
 *    `AuditLogInterceptor` via `APP_INTERCEPTOR`;
 *  - five MIDDLEWARE, in this order, on every route: SecurityHeaders → HostValidation →
 *    RequestSmugglingGuard → [IP policy, only if `security.ipPolicy.*` is non-empty] →
 *    HttpsEnforcement. Headers go FIRST so even the 400/403/308 produced by the checks below
 *    them carry the full header set (the spec's table lists no inter-stage order; §9.1's
 *    "every response, including error responses" requires this one). The global IP policy
 *    is additive: §22's table lists no IP middleware, but `security.ipPolicy.*` exists in the
 *    Config catalog (§23) and an allow/blocklist that nothing enforces would be a silent
 *    security gap (SPEC-ERRATA E-S9);
 *  - the five extension ports with their shipped defaults: `PROFILE_VALIDATORS` (empty
 *    registry), `SECURITY_ALERT_EMITTER` (Logger), `ANOMALY_DETECTOR`,
 *    `REPLAY_PROTECTION_STORE` (in-memory), `CACHE_INVALIDATION_BUS` (in-memory) — each
 *    replaceable at the composition root through `forRoot()` options (§2: "port + shipped
 *    default + composition-root override");
 *  - a boot step that pushes the validated Config values into the plain-function utilities
 *    (cookie defaults, injection limits, ClamAV endpoint, encryption key ring) —
 *    SPEC-ERRATA E-S1.
 *
 * `@Global()` (via `global: true`), matching HttpModule/ErrorsModule: the ports must be
 * injectable anywhere without every consumer re-importing this module.
 *
 * ⚠ AppModule order: import `SecurityModule` AFTER `HttpModule` (HTTP spec §3 puts its
 * trace/context/logger middleware at steps 1–3; Security's are step 4 and Nest applies
 * middleware in module-import order), and after `ConfigModule`, `LoggerModule` and
 * `ErrorsModule`.
 */
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import {
  Inject,
  Module,
  type DynamicModule,
  type MiddlewareConsumer,
  type ModuleMetadata,
  type NestModule,
  type Provider,
  type Type,
} from '@nestjs/common';
import {
  CONFIG_REGISTRY,
  CONFIG_SERVICE,
  ConfigModule,
  type ConfigRegistry,
  type ConfigService,
} from '../config';
import { LoggerAlertEmitter } from './alerts/logger-alert.emitter';
import type { SecurityAlertEmitter } from './alerts/security-alert.port';
import type { AnomalyDetector } from './anomaly/anomaly-detector.port';
import { InMemoryAnomalyDetector } from './anomaly/in-memory-anomaly.detector';
import type { CacheInvalidationBus } from './cache/cache-invalidation-bus.port';
import { InMemoryCacheInvalidationBus } from './cache/in-memory-cache-invalidation.bus';
import { securityCrossValidation } from './config/security.cross-validation';
import { SECURITY_SECRET_PATHS, securityConfigSchema, type SecurityConfig } from './config/security.schema';
import { TOKENS_SECRET_PATHS, tokensConfigSchema } from './config/tokens.schema';
import { configureKeyRing } from './crypto/key-ring';
import { AuthGuard } from './guards/auth.guard';
import { AuditLogInterceptor } from './interceptors/audit-log.interceptor';
import { SecurityHeadersMiddleware } from './middleware/security-headers.middleware';
import { HttpsEnforcementMiddleware } from './middleware/https-enforcement.middleware';
import { HostValidationMiddleware } from './network/host-validation.middleware';
import { createIpFilterMiddleware, hasIpPolicy, type IpPolicy } from './network/ip-filter.util';
import { RequestSmugglingGuardMiddleware } from './network/request-smuggling-guard.middleware';
import type { ProfileValidatorRegistry } from './principal/profile-validator.port';
import { InMemoryReplayProtectionStore } from './protocol/in-memory-replay-protection.store';
import type { ReplayProtectionStore } from './protocol/replay-protection.port';
import { configureSecurityRuntime } from './runtime/security-runtime';
import {
  ANOMALY_DETECTOR,
  CACHE_INVALIDATION_BUS,
  PROFILE_VALIDATORS,
  REPLAY_PROTECTION_STORE,
  SECURITY_ALERT_EMITTER,
  SECURITY_CLOCK,
  SECURITY_CONFIG_VALIDATION,
  SECURITY_IP_POLICY,
  SECURITY_RUNTIME_BOOTSTRAP,
} from './security.tokens';
import { systemClock, type Clock } from './util/clock';

/** How a composition root supplies its own implementation of a port. */
export type PortOverride<T> =
  | { readonly useClass: Type<T> }
  | { readonly useValue: T }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Nest's own FactoryProvider signature
  | { readonly useFactory: (...args: any[]) => T | Promise<T>; readonly inject?: Array<string | symbol | Type<unknown>> }
  | { readonly useExisting: string | symbol | Type<unknown> };

export interface SecurityModuleOptions {
  /** Modules whose providers an override's `inject` list needs (e.g. the domain module holding the user repository). */
  readonly imports?: ModuleMetadata['imports'];
  /** One `ProfileValidator` per `tokens.profiles[].name` (§5.3). Default: none → `DefaultProfileValidator` + a WARN once per profile. */
  readonly profileValidators?: PortOverride<ProfileValidatorRegistry>;
  /** Default: `LoggerAlertEmitter`. Production: Slack / PagerDuty / Redis Pub-Sub. */
  readonly alertEmitter?: PortOverride<SecurityAlertEmitter>;
  /** Default: in-memory sliding window. Production: Redis-backed. */
  readonly anomalyDetector?: PortOverride<AnomalyDetector>;
  /** Default: in-memory. Production: Redis `SET NX EX`. */
  readonly replayProtectionStore?: PortOverride<ReplayProtectionStore>;
  /** Default: in-memory. Production: the Cache module's Redis pub/sub bus. */
  readonly cacheInvalidationBus?: PortOverride<CacheInvalidationBus>;
  /** Test hook. */
  readonly clock?: PortOverride<Clock>;
}

function provide<T>(token: symbol, override: PortOverride<T> | undefined, fallback: Provider): Provider {
  return override ? ({ provide: token, ...override } as Provider) : fallback;
}

@Module({})
export class SecurityModule implements NestModule {
  constructor(@Inject(CONFIG_SERVICE) private readonly config: ConfigService) {}

  static forRoot(options: SecurityModuleOptions = {}): DynamicModule {
    const providers: Provider[] = [
      provide(SECURITY_CLOCK, options.clock, { provide: SECURITY_CLOCK, useValue: systemClock }),
      provide(PROFILE_VALIDATORS, options.profileValidators, { provide: PROFILE_VALIDATORS, useValue: Object.freeze({}) }),
      provide(SECURITY_ALERT_EMITTER, options.alertEmitter, { provide: SECURITY_ALERT_EMITTER, useClass: LoggerAlertEmitter }),
      provide(ANOMALY_DETECTOR, options.anomalyDetector, {
        provide: ANOMALY_DETECTOR,
        useFactory: (clock: Clock) => new InMemoryAnomalyDetector({ clock }),
        inject: [SECURITY_CLOCK],
      }),
      provide(REPLAY_PROTECTION_STORE, options.replayProtectionStore, {
        provide: REPLAY_PROTECTION_STORE,
        useFactory: (clock: Clock) => new InMemoryReplayProtectionStore({ clock }),
        inject: [SECURITY_CLOCK],
      }),
      provide(CACHE_INVALIDATION_BUS, options.cacheInvalidationBus, {
        provide: CACHE_INVALIDATION_BUS,
        useValue: new InMemoryCacheInvalidationBus(),
      }),

      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_INTERCEPTOR, useClass: AuditLogInterceptor },

      // Production cross-namespace rules — registered through the same barrier forFeature() uses.
      {
        provide: SECURITY_CONFIG_VALIDATION,
        useFactory: (registry: ConfigRegistry): true => {
          registry.registerCrossValidation(securityCrossValidation);
          return true;
        },
        inject: [CONFIG_REGISTRY],
      },
      // Pushes validated Config into the plain-function utilities (SPEC-ERRATA E-S1).
      {
        provide: SECURITY_RUNTIME_BOOTSTRAP,
        useFactory: (config: ConfigService): true => {
          const security = config.getNamespace<SecurityConfig>('security');
          configureSecurityRuntime({
            cookies: { defaultSameSite: security.cookies.defaultSameSite, defaultSecure: security.cookies.defaultSecure },
            injection: {
              maxJsonDepth: security.injection.maxJsonDepth,
              redosTimeoutMs: security.injection.redosTimeoutMs,
              stripPrototypeKeys: security.injection.stripPrototypeKeys,
            },
            clamav: {
              host: security.clamav.host,
              port: security.clamav.port,
              timeoutMs: security.clamav.timeoutMs,
              failOpen: security.clamav.failOpen,
            },
          });
          configureKeyRing({
            currentKeyId: security.crypto.currentKeyId,
            currentKeyRef: security.crypto.currentKeyRef,
            retiredKeys: security.crypto.retiredKeys,
          });
          return true;
        },
        inject: [CONFIG_SERVICE],
      },
      {
        provide: SECURITY_IP_POLICY,
        useFactory: (config: ConfigService): IpPolicy => {
          const { ipPolicy } = config.getNamespace<SecurityConfig>('security');
          return Object.freeze({ allowlist: ipPolicy.allowlist, blocklist: ipPolicy.blocklist });
        },
        inject: [CONFIG_SERVICE],
      },
    ];

    return {
      module: SecurityModule,
      global: true,
      imports: [
        ConfigModule.forFeature('security', securityConfigSchema, {
          description: 'Security (Security spec §23)',
          secretPaths: SECURITY_SECRET_PATHS,
        }),
        ConfigModule.forFeature('tokens', tokensConfigSchema, {
          description: 'Token profiles — Config spec §13.7; registered here until Authentication exists (E-S6)',
          secretPaths: TOKENS_SECRET_PATHS,
        }),
        ...(options.imports ?? []),
      ],
      providers,
      exports: [
        PROFILE_VALIDATORS,
        SECURITY_ALERT_EMITTER,
        ANOMALY_DETECTOR,
        REPLAY_PROTECTION_STORE,
        CACHE_INVALIDATION_BUS,
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    const { ipPolicy } = this.config.getNamespace<SecurityConfig>('security');
    const policy: IpPolicy = { allowlist: ipPolicy.allowlist, blocklist: ipPolicy.blocklist };

    // Order matters — see the file header.
    const stages: Array<Type<unknown> | ((req: Request, res: Response, next: NextFunction) => void)> = [
      SecurityHeadersMiddleware,
      HostValidationMiddleware,
      RequestSmugglingGuardMiddleware,
    ];
    if (hasIpPolicy(policy)) {
      const filter = createIpFilterMiddleware(policy); // throws at boot on a malformed entry
      stages.push((req: Request, res: Response, next: NextFunction) => filter.use(req, res, next));
    }
    stages.push(HttpsEnforcementMiddleware);
    consumer.apply(...stages).forRoutes('*');
  }
}

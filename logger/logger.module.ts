/**
 * LoggerModule.forRoot() — Logger spec §5, §12, §34, §37.
 *
 * `global: true`, matching Config's and Tracing's own pattern: every module in
 * the graph needs `LOGGER_SERVICE`. Reads its own settings from Config
 * (`ConfigModule.forFeature('logging', …)`, this module's own namespace — see
 * config/logging.schema.ts) and reads trace context from Tracing's plain,
 * no-DI `getTraceContext()` function (Tracing spec §4.2) — never a DI
 * dependency on `TRACING_SERVICE` for something this cheap and this hot-path.
 *
 * File and Sentry transports (§20, §24 — see SPEC-ERRATA.md E-L9, E-L10) are
 * registered here CONDITIONALLY, on `logging.file.enabled` /
 * `logging.sentry.enabled`, and always `critical: false` (§25's table only
 * ever hard-wires Console) — neither one existing, or either one failing to
 * come up, must never stop the app from booting or make Console's own health
 * look unhealthy because of it.
 */
import {
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
  type OnModuleInit,
  type Provider,
} from '@nestjs/common';
import type { AppConfig } from '../config';
import { CONFIG_SERVICE, ConfigModule, type ConfigService } from '../config';
import { getTraceContext } from '../tracing';
import type { LoggingConfig } from './config/logging.schema';
import {
  LOGGING_SECRET_PATHS,
  loggingConfigSchema,
} from './config/logging.schema';
import { emergencyLog } from './bootstrap/emergency-logger';
import type { LoggerModuleOptions } from './logger.port';
import { LoggerServiceImpl, type LevelHolder } from './logger.service';
import {
  LOGGER_DISPATCHERS,
  LOGGER_LEVEL_HOLDER,
  LOGGER_OBSERVATION,
  LOGGER_OPTIONS,
  LOGGER_REDACTOR,
  LOGGER_RUNTIME,
  LOGGER_SAMPLER,
  LOGGER_SERVICE,
  LOGGER_TRANSPORTS,
} from './logger.tokens';
import { LoggerObservation } from './observation/logger.observation';
import { LogRedactor } from './redaction/log-redactor';
import { LogSampler } from './sampling/log-sampler';
import type { ServiceIdentity } from './serialization/entry-builder';
import { ConsoleTransport } from './transports/console/console.transport';
import { FileTransport } from './transports/file/file.transport';
import { SentryTransport } from './transports/sentry/sentry.transport';
import { TransportDispatcher } from './transports/transport-dispatcher';
import type { TransportRegistration } from './transports/transport.interface';

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;

/** §12 — production default `json`, development/test default `pretty`, UNLESS
 *  `logging.format` was explicitly set (Config §5.7: an explicit value always
 *  outranks a derived one). */
function resolveConsoleMode(
  format: LoggingConfig['format'],
  env: AppConfig['env'],
): 'json' | 'pretty' {
  return (
    format ?? (env === 'development' || env === 'test' ? 'pretty' : 'json')
  );
}

/**
 * Subscribes to Config's hot-reload of `logging.level` (Config spec §10.1's
 * exact whitelisted leaf) and applies it to the shared `LevelHolder` — see
 * `logger.service.ts`'s own header for why a shared holder, not a copied field,
 * is what makes this reach every already-created child logger. Injects
 * `LOGGER_RUNTIME`, not `LOGGER_SERVICE` (§37's own worked example injects
 * `LOGGER_SERVICE` typed as `LoggerRuntime` — a mismatch corrected here; see
 * SPEC-ERRATA.md E-L6).
 */
@Injectable()
class LogLevelManager implements OnModuleInit {
  constructor(
    @Inject(CONFIG_SERVICE) private readonly config: ConfigService,
    @Inject(LOGGER_RUNTIME)
    private readonly runtime: import('./logger.port').LoggerRuntime,
  ) {}
  onModuleInit(): void {
    this.config.onChange<LoggingConfig['level']>('logging.level', (level) =>
      this.runtime.setLevel(level),
    );
  }
}

/**
 * Builds every registered transport for this run — Console always, File and
 * Sentry only when their own `enabled` flag is set, plus whatever
 * `LoggerModuleOptions.transports` the host app supplied. Split out of the
 * `LOGGER_TRANSPORTS` provider itself only because it's genuinely async now
 * (`SentryTransport.create()` awaits a dynamic `import()`) — Nest's
 * `useFactory` supports an async factory directly, so this is still one DI
 * provider, just backed by a named function instead of an inline arrow.
 */
async function buildTransportRegistrations(
  config: ConfigService,
  options: LoggerModuleOptions,
): Promise<TransportRegistration[]> {
  const logging = config.getNamespace<LoggingConfig>('logging');
  const app = config.getNamespace<AppConfig>('app');

  const registrations: TransportRegistration[] = [
    {
      // §25 — the guaranteed-available fallback: always critical.
      transport: new ConsoleTransport({
        mode: resolveConsoleMode(logging.format, app.env),
      }),
      critical: true,
    },
  ];

  if (logging.file.enabled) {
    registrations.push({
      transport: new FileTransport({
        appPath: logging.file.appPath,
        errorPath: logging.file.errorPath,
        // `maxSizeMb`, not `maxSizeMB` — see logging.schema.ts's own header for why the
        // capitalization here is load-bearing, not cosmetic.
        maxSizeBytes: logging.file.maxSizeMb * 1024 * 1024,
        maxFiles: logging.file.maxFiles,
        compress: logging.file.compress,
        datePattern: logging.file.datePattern,
      }),
      critical: false, // §25 — File is never critical, only Console is.
    });
  }

  if (logging.sentry.enabled) {
    // `create()` never throws (sentry.transport.ts) — `undefined` means the SDK failed to
    // load or initialize (not installed, bad DSN, unreachable at boot, …); degrade to
    // Console(+File) rather than fail application bootstrap over it. `onFailure` still
    // reports it via `emergencyLog` — this module's own last-resort reporting path,
    // deliberately independent of everything else in Logger (emergency-logger.ts) — so a
    // silently-disabled Sentry transport doesn't go unnoticed by whoever operates this.
    const sentry = await SentryTransport.create(
      {
        dsn: logging.sentry.dsn as string, // guaranteed present — logging.schema.ts's own superRefine
        environment: logging.sentry.environment ?? app.env,
        tracesSampleRate: logging.sentry.tracesSampleRate,
      },
      (err) =>
        emergencyLog(
          'Sentry transport failed to initialize — continuing without it',
          err,
        ),
    );
    if (sentry) registrations.push({ transport: sentry, critical: false });
  }

  for (const extra of options.transports ?? []) {
    registrations.push({ transport: extra, critical: extra.critical ?? false });
  }
  return registrations;
}

@Module({})
export class LoggerModule implements OnApplicationShutdown {
  constructor(
    @Inject(LOGGER_DISPATCHERS)
    private readonly dispatchers: TransportDispatcher[],
    @Inject(LOGGER_OPTIONS) private readonly options: LoggerModuleOptions,
  ) {}

  /**
   * §34 — this hook must run LAST: flush every transport (bounded by `shutdownTimeoutMs`,
   * default 5000ms) after every business module's own shutdown hook and after Tracing's have run.
   *
   * ⚠️ Nest does not give modules shutdown priorities, so the order is a consequence of
   * `AppModule`'s import order — and NestJS 11 runs shutdown hooks in REVERSE import order
   * (verified: with `[Tracing, Logger]` the Logger flushed and closed FIRST, so everything
   * Tracing logged during its own flush/retry was lost). To get "Tracing, then Logger last",
   * import `LoggerModule` BEFORE `TracingModule`. (The previous wording of this comment —
   * "imported LAST" — describes NestJS ≤ 10 and is wrong on 11.)
   */
  async onApplicationShutdown(): Promise<void> {
    const timeoutMs =
      this.options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    await Promise.all(this.dispatchers.map((d) => d.close(timeoutMs)));
  }

  static forRoot(options: LoggerModuleOptions = {}): DynamicModule {
    const providers: Provider[] = [
      { provide: LOGGER_OPTIONS, useValue: options },
      {
        provide: LOGGER_OBSERVATION,
        useFactory: () => new LoggerObservation(),
      },
      {
        provide: LOGGER_REDACTOR,
        useFactory: (config: ConfigService) =>
          new LogRedactor(
            config.getNamespace<LoggingConfig>('logging').redact.paths,
          ),
        inject: [CONFIG_SERVICE],
      },
      {
        provide: LOGGER_SAMPLER,
        useFactory: (config: ConfigService) =>
          new LogSampler(
            config.getNamespace<LoggingConfig>('logging').sampling,
          ),
        inject: [CONFIG_SERVICE],
      },
      {
        provide: LOGGER_TRANSPORTS,
        useFactory: (config: ConfigService): Promise<TransportRegistration[]> =>
          buildTransportRegistrations(config, options),
        inject: [CONFIG_SERVICE],
      },
      {
        provide: LOGGER_DISPATCHERS,
        useFactory: (
          registrations: TransportRegistration[],
          observation: LoggerObservation,
        ) => registrations.map((r) => new TransportDispatcher(r, observation)),
        inject: [LOGGER_TRANSPORTS, LOGGER_OBSERVATION],
      },
      {
        // The single shared, mutable level cell every logger instance (root + every
        // child) reads from — see logger.service.ts's own header for why.
        provide: LOGGER_LEVEL_HOLDER,
        useFactory: (config: ConfigService): LevelHolder => ({
          current: config.getNamespace<LoggingConfig>('logging').level,
        }),
        inject: [CONFIG_SERVICE],
      },
      {
        provide: LOGGER_SERVICE,
        useFactory: (
          dispatchers: TransportDispatcher[],
          redactor: LogRedactor,
          sampler: LogSampler,
          observation: LoggerObservation,
          levelHolder: LevelHolder,
          config: ConfigService,
        ) => {
          const logging = config.getNamespace<LoggingConfig>('logging');
          const app = config.getNamespace<AppConfig>('app');
          const identity: ServiceIdentity = {
            service: app.name,
            environment: app.env,
            instanceId: app.instanceId,
          };
          return new LoggerServiceImpl({
            dispatchers,
            identity,
            redactor,
            sampler,
            limit: {
              sizeLimitBytes: logging.metadata.sizeLimitBytes,
              sizeLimitPolicy: logging.metadata.sizeLimitPolicy,
            },
            observation,
            levelHolder,
            getTraceContext,
          });
        },
        inject: [
          LOGGER_DISPATCHERS,
          LOGGER_REDACTOR,
          LOGGER_SAMPLER,
          LOGGER_OBSERVATION,
          LOGGER_LEVEL_HOLDER,
          CONFIG_SERVICE,
        ],
      },
      { provide: LOGGER_RUNTIME, useExisting: LOGGER_SERVICE },
      LogLevelManager,
    ];

    return {
      module: LoggerModule,
      global: true,
      imports: [
        ConfigModule.forFeature('logging', loggingConfigSchema, {
          secretPaths: LOGGING_SECRET_PATHS,
        }),
      ],
      providers,
      exports: [LOGGER_SERVICE, LOGGER_RUNTIME],
    };
  }
}

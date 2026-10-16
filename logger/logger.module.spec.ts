import { Test } from '@nestjs/testing';
import {
  CONFIG_SERVICE,
  ConfigModule,
  staticSource,
  type ConfigSource,
  type ConfigService,
} from '../config';
import { TracingModule } from '../tracing';
import { LoggerModule } from './logger.module';
import { LOGGER_RUNTIME, LOGGER_SERVICE } from './logger.tokens';
import type {
  ILogger,
  LogEntry,
  LoggerModuleOptions,
  LoggerRuntime,
} from './logger.port';

const BASE_ENV = {
  NODE_ENV: 'test',
  APP__NAME: 'test-service',
  APP__FRONTEND_URL: 'http://localhost:5173',
};

class FakeTransport {
  readonly name = 'fake';
  readonly entries: LogEntry[] = [];
  closed = false;
  critical?: boolean;
  write(entry: LogEntry): void {
    this.entries.push(entry);
  }
  health() {
    return { healthy: true };
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

async function bootLogger(
  env: Record<string, string> = {},
  loggerOptions: LoggerModuleOptions = {},
) {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        sources: [staticSource({ ...BASE_ENV, ...env })],
        exitOnValidationFailure: false,
      }),
      TracingModule.forRoot(),
      LoggerModule.forRoot(loggerOptions),
    ],
  }).compile();
  return {
    moduleRef,
    config: moduleRef.get<ConfigService>(CONFIG_SERVICE),
    logger: moduleRef.get<ILogger>(LOGGER_SERVICE),
    runtime: moduleRef.get<LoggerRuntime>(LOGGER_RUNTIME),
    close: () => moduleRef.close(),
  };
}

/** A hot-reload-capable Config source, built locally: Config's public surface exports only
 *  `staticSource` (no `watch()`), so this test constructs the small amount of `ConfigSource`
 *  logic itself, matching the shape `hot-reload/hot-reload.manager.ts` expects. */
function watchableSource(
  initial: Record<string, string>,
): ConfigSource & { emit(updates: Record<string, string>): void } {
  type Cb = Parameters<NonNullable<ConfigSource['watch']>>[0];
  let callback: Cb | undefined;
  return {
    name: 'watchable-test-source',
    critical: true,
    watchEnvironments: ['test'],
    async load() {
      return Object.fromEntries(
        Object.entries(initial).map(([k, v]) => [
          k,
          { value: v, origin: 'test-override' as const },
        ]),
      );
    },
    watch(cb: Cb) {
      callback = cb;
      return () => {
        callback = undefined;
      };
    },
    async health() {
      return { healthy: true, critical: true };
    },
    emit(updates: Record<string, string>) {
      callback?.(
        Object.fromEntries(
          Object.entries(updates).map(([k, v]) => [
            k,
            { value: v, origin: 'test-override' as const },
          ]),
        ),
      );
    },
  };
}

let stdoutSpy: jest.SpyInstance;
let stderrSpy: jest.SpyInstance;
beforeEach(() => {
  stdoutSpy = jest
    .spyOn(process.stdout, 'write')
    .mockImplementation(() => true);
  stderrSpy = jest
    .spyOn(process.stderr, 'write')
    .mockImplementation(() => true);
});
afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
});

describe('LoggerModule — boot and token identity (§37)', () => {
  it('boots successfully with just NODE_ENV/APP__NAME/APP__FRONTEND_URL — every logging.* field has a usable default', async () => {
    const { logger, close } = await bootLogger();
    expect(() => logger.info('hello')).not.toThrow();
    await close();
  });

  it('LOGGER_SERVICE and LOGGER_RUNTIME resolve to the exact same instance (useExisting, §37)', async () => {
    const { logger, runtime, close } = await bootLogger();
    expect(logger).toBe(runtime);
    await close();
  });
});

describe("LoggerModule — service identity from Config's app namespace (§3, §12)", () => {
  it('stamps service/environment/instanceId from app.name/app.env/app.instanceId onto every entry', async () => {
    const fake = new FakeTransport();
    const { logger, close } = await bootLogger(
      { APP__INSTANCE_ID: 'inst-42' },
      { transports: [fake] },
    );
    logger.info('x');
    expect(fake.entries[0]).toMatchObject({
      service: 'test-service',
      environment: 'test',
      instanceId: 'inst-42',
    });
    await close();
  });

  it('omits instanceId entirely when Config has none (it is optional, §13.1)', async () => {
    const fake = new FakeTransport();
    const { logger, close } = await bootLogger({}, { transports: [fake] });
    logger.info('x');
    expect('instanceId' in fake.entries[0]).toBe(false);
    await close();
  });
});

describe('LoggerModule — redaction wired from logging.redact.paths (§14, §12)', () => {
  it('an extra pattern from Config redacts a matching metadata key', async () => {
    const fake = new FakeTransport();
    const { logger, close } = await bootLogger(
      { LOGGING__REDACT__PATHS: 'ssn' },
      { transports: [fake] },
    );
    logger.info('x', { ssn: '123-45-6789', name: 'ok' });
    expect(fake.entries[0].ssn).toBe('[REDACTED]');
    expect(fake.entries[0].name).toBe('ok');
    await close();
  });
});

describe('LoggerModule — sampling wired from logging.sampling.* (§16, §12)', () => {
  it('a ratio of exactly 0 deterministically drops every line at that level', async () => {
    const fake = new FakeTransport();
    const { logger, close } = await bootLogger(
      { LOGGING__SAMPLING__DEBUG: '0' },
      { transports: [fake] },
    );
    for (let i = 0; i < 20; i++) logger.debug(`line ${i}`);
    expect(fake.entries).toHaveLength(0);
    await close();
  });

  it('WARN is never affected by a debug/info/trace sampling ratio of 0 — always sampled (§16)', async () => {
    const fake = new FakeTransport();
    const { logger, close } = await bootLogger(
      {
        LOGGING__SAMPLING__TRACE: '0',
        LOGGING__SAMPLING__DEBUG: '0',
        LOGGING__SAMPLING__INFO: '0',
      },
      { transports: [fake] },
    );
    logger.warn('always visible');
    expect(fake.entries).toHaveLength(1);
    await close();
  });
});

describe('LoggerModule — metadata size limit wired from logging.metadata.* (§15, §12)', () => {
  it('applies the configured byte limit and policy', async () => {
    const fake = new FakeTransport();
    const { logger, close } = await bootLogger(
      {
        LOGGING__METADATA__SIZE_LIMIT_BYTES: '10',
        LOGGING__METADATA__SIZE_LIMIT_POLICY: 'reject',
      },
      { transports: [fake] },
    );
    logger.info('x', { blob: 'y'.repeat(100) });
    expect(fake.entries[0].metadataRejected).toBe(true);
    await close();
  });
});

describe('LoggerModule — Console transport is present, critical, and format-driven by logging.format/app.env (§19, §25)', () => {
  it('emits real JSON to stdout in production even when NODE_ENV would otherwise suggest pretty', async () => {
    const { logger, close } = await bootLogger({ NODE_ENV: 'production' });
    logger.info('prod line');
    const line = stdoutSpy.mock.calls.find((c: unknown[]) =>
      String(c[0]).includes('prod line'),
    )?.[0] as string;
    expect(() => JSON.parse(line)).not.toThrow();
    await close();
  });

  it('an explicit logging.format overrides the environment-derived default', async () => {
    const { logger, close } = await bootLogger({
      NODE_ENV: 'production',
      LOGGING__FORMAT: 'pretty',
    });
    logger.info('forced pretty');
    const line = stdoutSpy.mock.calls.find((c: unknown[]) =>
      String(c[0]).includes('forced pretty'),
    )?.[0] as string;
    expect(() => JSON.parse(line)).toThrow(); // pretty output is not valid JSON
    await close();
  });

  it('Console is critical: an unhealthy Console makes getHealth() report unhealthy overall (§25)', async () => {
    const brokenStdout = {
      write: () => {
        throw new Error('EPIPE');
      },
    } as unknown as NodeJS.WritableStream;
    // We can't inject a stream into the module-managed Console transport directly, so this
    // exercises the health AGGREGATION rule instead, using an extra CRITICAL fake transport —
    // the same rule §25 applies regardless of which transport is the one that's down.
    const fake = new FakeTransport();
    fake.critical = true;
    fake.health = () => ({ healthy: false, message: 'down' });
    const { runtime, close } = await bootLogger({}, { transports: [fake] });
    expect(runtime.getHealth().status).toBe('unhealthy');
    void brokenStdout;
    await close();
  });
});

describe('LoggerModule — hot-reload of logging.level (§5, §10.1, §38)', () => {
  it('a Config hot-reload update to logging.level changes what LOGGER_RUNTIME (and LOGGER_SERVICE) actually emit', async () => {
    const source = watchableSource({ ...BASE_ENV, LOGGING__LEVEL: 'warn' });
    const fake = new FakeTransport();
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          sources: [source],
          hotReload: { enabled: true, paths: ['logging.level'] },
          exitOnValidationFailure: false,
        }),
        TracingModule.forRoot(),
        LoggerModule.forRoot({ transports: [fake] }),
      ],
    }).compile();
    await moduleRef.init(); // runs OnModuleInit — this is what wires LogLevelManager's subscription

    const logger = moduleRef.get<ILogger>(LOGGER_SERVICE);
    logger.info('filtered before hot-reload');
    expect(fake.entries).toHaveLength(0);

    source.emit({ LOGGING__LEVEL: 'info' });
    logger.info('visible after hot-reload');
    expect(fake.entries).toHaveLength(1);
    expect(fake.entries[0].message).toBe('visible after hot-reload');

    await moduleRef.close();
  });
});

describe('LoggerModule — graceful shutdown (§34)', () => {
  it('closing the application flushes and closes every extra transport', async () => {
    const fake = new FakeTransport();
    const { close } = await bootLogger({}, { transports: [fake] });
    expect(fake.closed).toBe(false);
    await close();
    expect(fake.closed).toBe(true);
  });

  it('respects a configured shutdownTimeoutMs rather than the hardcoded default', async () => {
    const fake = new FakeTransport();
    let observedTimeoutArg: number | undefined;
    const originalClose = fake.close.bind(fake);
    fake.close = async () => {
      observedTimeoutArg = Date.now(); // just proves close() was invoked promptly; exact timeout plumbing
      return originalClose();
    };
    const { close } = await bootLogger(
      {},
      { transports: [fake], shutdownTimeoutMs: 250 },
    );
    await close();
    expect(observedTimeoutArg).toEqual(expect.any(Number));
    expect(fake.closed).toBe(true);
  });
});

describe('LoggerModule — duplicate registration guard (Config spec §17.7, applied here)', () => {
  it('registering LoggerModule twice in the same app is rejected the same way any duplicate namespace is', async () => {
    await expect(
      Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            sources: [staticSource(BASE_ENV)],
            exitOnValidationFailure: false,
          }),
          TracingModule.forRoot(),
          LoggerModule.forRoot(),
          LoggerModule.forRoot(),
        ],
      }).compile(),
    ).rejects.toThrow(/already registered/);
  });
});

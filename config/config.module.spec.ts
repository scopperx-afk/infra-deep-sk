import { Inject, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { z } from 'zod';
import { ConfigModule } from './config.module';
import {
  ConfigMissingError,
  ConfigRegistrationError,
  ConfigValidationError,
  type ConfigRegistry,
  type ConfigService,
} from './config.port';
import { CONFIG_REGISTRY, CONFIG_SERVICE } from './config.tokens';
import {
  csvArray,
  durationSchema,
  numberSchema,
  portSchema,
  secretValueSchema,
} from './schema/primitives';
import type { SecretResolver } from './secrets/secret.resolver.port';
import { staticSource } from './sources/static.source';
import {
  BASE_ENV,
  boot,
  fakeSource,
  silenceStderr,
} from './testing/test-utils';

let stderr: jest.SpyInstance;
beforeEach(() => {
  stderr = silenceStderr();
});
afterEach(() => stderr.mockRestore());

const dbSchema = z.object({
  url: z.string().url(),
  pool: z
    .object({ max: portSchema.default(10), min: numberSchema.default(2) })
    .default({}),
});

describe('boot + read API (§3)', () => {
  it('boots with the minimal env and exposes the app namespace with defaults', async () => {
    const { config } = await boot();
    expect(
      config.getNamespace<{ port: number; name: string }>('app'),
    ).toMatchObject({ port: 3000, name: 'test-app' });
    expect(config.getEnvironment()).toBe('test');
    expect(config.isProduction()).toBe(false);
  });

  it('get / has / default semantics (§3, §8)', async () => {
    const { config } = await boot();
    expect(config.get('app.name')).toBe('test-app');
    expect(config.get<number>('app.port')).toBe(3000);
    expect(config.has('app.name')).toBe(true);

    // registered-but-optional and absent
    expect(config.has('app.instanceId')).toBe(false);
    expect(() => config.get('app.instanceId')).toThrow(ConfigMissingError);
    expect(config.get('app.instanceId', 'fallback')).toBe('fallback');

    // never registered: throws EVEN WITH a default; has() is false and never throws
    expect(() => config.get('nope.nothing')).toThrow(ConfigMissingError);
    expect(() => config.get('nope.nothing', 'default')).toThrow(
      ConfigMissingError,
    );
    expect(config.has('nope.nothing')).toBe(false);
    expect(config.has('')).toBe(false);
    expect(() => config.getNamespace('nope')).toThrow(ConfigMissingError);
  });

  it('a present null is a value: returned as-is, has() true, default NOT used', async () => {
    const { config } = await boot({ NULLY__X: 'anything' }, {}, [
      ConfigModule.forFeature(
        'nully',
        z.object({ x: z.string().transform(() => null) }),
      ),
    ]);
    expect(config.get('nully.x', 'default')).toBeNull();
    expect(config.has('nully.x')).toBe(true);
  });

  it('the returned tree is deeply frozen and there is no mutation API', async () => {
    const { config } = await boot({ DB__URL: 'postgres://u:p@h/db' }, {}, [
      ConfigModule.forFeature('db', dbSchema),
    ]);
    const ns = config.getNamespace<{ pool: { max: number } }>('db');
    expect(() => {
      ns.pool.max = 99;
    }).toThrow(TypeError);
    expect(Object.isFrozen(config.getNamespace('app'))).toBe(true);
    for (const banned of ['set', 'dump', 'inspect'])
      expect(
        (config as unknown as Record<string, unknown>)[banned],
      ).toBeUndefined();
  });

  it('coerces env strings via the schema (port, numbers, defaults)', async () => {
    const { config } = await boot(
      { DB__URL: 'postgres://h/db', DB__POOL__MAX: '25' },
      {},
      [ConfigModule.forFeature('db', dbSchema)],
    );
    expect(config.get('db.pool.max')).toBe(25);
    expect(config.get('db.pool.min')).toBe(2);
  });

  it('trims whitespace on non-secret values', async () => {
    const { config } = await boot({ APP__NAME: '  padded  ' });
    expect(config.get('app.name')).toBe('padded');
  });
});

describe('fail-fast validation (§6, §7.9)', () => {
  it('reports EVERY error at once, by env-var name, with the spec banner', async () => {
    const promise = boot(
      {
        DB__URL: 'not-a-url',
        DB__POOL__MAX: 'abc',
        APP__NAME: undefined,
        APP__FRONTEND_URL: undefined,
      },
      {},
      [
        ConfigModule.forFeature('db', dbSchema),
        ConfigModule.forFeature('cache', z.object({ ttl: durationSchema })),
      ],
    );
    await expect(promise).rejects.toBeInstanceOf(ConfigValidationError);
    const err = (await promise.catch((e) => e)) as ConfigValidationError;
    const all = err.errors.join('\n');
    expect(all).toContain('APP__NAME: required (env var not set)');
    expect(all).toContain('APP__FRONTEND_URL: required (env var not set)');
    expect(all).toContain('DB__URL:');
    expect(all).toMatch(
      /DB__POOL__MAX: expected number, received string "abc"/,
    );
    expect(all).toContain('CACHE__TTL: required (env var not set)');
    expect(err.message).toContain(
      '❌ ConfigModule — configuration errors detected:',
    );
    expect(err.message).toContain('Application startup aborted.');
    expect(stderr).toHaveBeenCalled(); // the banner went to stderr
  });

  it('a missing NODE_ENV fails immediately, and the error names NODE_ENV', async () => {
    const err = (await boot({ NODE_ENV: undefined }).catch(
      (e) => e,
    )) as ConfigValidationError;
    expect(err).toBeInstanceOf(ConfigValidationError);
    expect(err.errors.join('\n')).toContain(
      'NODE_ENV: required (env var not set)',
    );
  });

  it('rejects "dev" — only development|staging|production|test', async () => {
    const err = (await boot({ NODE_ENV: 'dev' }).catch(
      (e) => e,
    )) as ConfigValidationError;
    expect(err.errors.join('\n')).toContain('NODE_ENV:');
  });

  it('exitOnValidationFailure defaults to true: process.exit(1) at the one call site', async () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit called');
    });
    try {
      await expect(
        Test.createTestingModule({
          imports: [ConfigModule.forRoot({ sources: [staticSource({})] })], // no exitOnValidationFailure
        }).compile(),
      ).rejects.toThrow('exit called');
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      exit.mockRestore();
    }
  });

  it('a failing CRITICAL source aborts boot and joins the aggregate error list', async () => {
    const broken = {
      ...fakeSource('broken', 'process.env', {}),
      load: async () => Promise.reject(new Error('disk on fire')),
    };
    const err = (await boot(
      {},
      { sources: [broken, staticSource(BASE_ENV)] },
    ).catch((e) => e)) as ConfigValidationError;
    expect(err.errors.join('\n')).toContain(
      'config source "broken" (critical) failed to load: disk on fire',
    );
  });

  it('a failing NON-critical source degrades with a notice and boot continues', async () => {
    const optional = {
      ...fakeSource('flaky', 'remote', {}),
      critical: false,
      load: async () => Promise.reject(new Error('timeout')),
    };
    const { config, notices } = await boot(
      {},
      { sources: [optional, staticSource(BASE_ENV)] },
    );
    expect(config.getEnvironment()).toBe('test');
    expect(
      notices.find((n) => n.code === 'optional-source-unavailable'),
    ).toBeTruthy();
    const health = config.getHealth();
    expect(health.sources.find((s) => s.name === 'flaky')).toMatchObject({
      healthy: false,
      critical: false,
    });
  });
});

describe('secret redaction (§7.5, §11.5)', () => {
  const SECRET = 'hunter2-super-secret-value';
  const schema = z.object({
    token: z.enum(['alpha', 'beta']),
    url: z.string().url(),
  });

  it('never renders a secret-marked path’s received value — even when Zod’s own message would', async () => {
    // z.enum's built-in message embeds the received value ("received 'hunter2-…'").
    const err = (await boot({ SEC__TOKEN: SECRET, SEC__URL: 'nope' }, {}, [
      ConfigModule.forFeature('sec', schema, { secretPaths: ['token'] }),
    ]).catch((e) => e)) as ConfigValidationError;
    const text = `${err.message}\n${err.errors.join('\n')}`;
    expect(text).toContain('SEC__TOKEN:');
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain(SECRET);
    expect(text).toContain('SEC__URL:'); // the non-secret sibling is still reported normally
  });

  it('scrubs a secret that a cross-validation function interpolates anyway', async () => {
    @Module({
      imports: [
        ConfigModule.forFeature('sec', z.object({ pw: secretValueSchema }), {
          secretPaths: ['pw'],
        }),
      ],
    })
    class SecModule {
      constructor(@Inject(CONFIG_REGISTRY) reg: ConfigRegistry) {
        reg.registerCrossValidation(() => {
          throw new ConfigValidationError(
            'sec',
            `bad combination for password ${SECRET}`,
          );
        });
      }
    }
    const err = (await boot({ SEC__PW: SECRET }, {}, [SecModule]).catch(
      (e) => e,
    )) as ConfigValidationError;
    expect(err).toBeInstanceOf(ConfigValidationError);
    expect(err.message).not.toContain(SECRET);
    expect(err.errors.join('\n')).toContain(
      'bad combination for password [REDACTED]',
    );
  });

  it('redacts secrets inside a JSON blob and names the blob var + index', async () => {
    const profile = z.object({
      name: z.string(),
      secretRef: z.string().min(32),
    });
    const tokens = z.object({
      profiles: z
        .string()
        .transform((s, ctx) => {
          try {
            return JSON.parse(s) as unknown;
          } catch {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'invalid JSON',
            });
            return z.NEVER;
          }
        })
        .pipe(z.array(profile)),
    });
    const short = 'short-blob-secret';
    const err = (await boot(
      { TOKENS__PROFILES: [{ name: 'user', secretRef: short }] },
      {},
      [
        ConfigModule.forFeature('tokens', tokens, {
          secretPaths: ['profiles[].secretRef'],
        }),
      ],
    ).catch((e) => e)) as ConfigValidationError;
    const text = err.errors.join('\n');
    expect(text).toContain('TOKENS__PROFILES[0].secretRef');
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain(short);
  });
});

describe('cross-namespace validation (§7.4)', () => {
  it('runs every function, collects every failure, and only after namespaces pass', async () => {
    const ran: string[] = [];
    @Module({
      imports: [ConfigModule.forFeature('db', dbSchema)],
    })
    class RulesModule {
      constructor(@Inject(CONFIG_REGISTRY) reg: ConfigRegistry) {
        reg.registerCrossValidation(() => {
          ran.push('a');
          throw new ConfigValidationError(
            'db',
            'DB__URL must not point at localhost outside development',
          );
        });
        reg.registerCrossValidation(() => {
          ran.push('b');
          throw new Error('boom'); // unexpected error type is wrapped, not fatal to the pass
        });
        reg.registerCrossValidation(() => {
          ran.push('c'); // still runs after the two above threw
        });
      }
    }
    const err = (await boot({ DB__URL: 'postgres://localhost/db' }, {}, [
      RulesModule,
    ]).catch((e) => e)) as ConfigValidationError;
    expect(ran).toEqual(['a', 'b', 'c']);
    expect(err.errors).toHaveLength(2);
    expect(err.errors[0]).toContain('DB__URL must not point at localhost');
    expect(err.errors[1]).toContain('threw unexpectedly: boom');
  });

  it('is NOT run while a namespace is individually invalid', async () => {
    const fn = jest.fn();
    @Module({ imports: [ConfigModule.forFeature('db', dbSchema)] })
    class RulesModule {
      constructor(@Inject(CONFIG_REGISTRY) reg: ConfigRegistry) {
        reg.registerCrossValidation(fn);
      }
    }
    await expect(
      boot({ DB__URL: 'bad' }, {}, [RulesModule]),
    ).rejects.toBeInstanceOf(ConfigValidationError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('receives typed, defaulted, frozen config and a working wasSupplied()', async () => {
    let seen:
      | {
          poolMax: unknown;
          suppliedMax: boolean;
          suppliedMin: boolean;
          frozen: boolean;
        }
      | undefined;
    @Module({ imports: [ConfigModule.forFeature('db', dbSchema)] })
    class RulesModule {
      constructor(@Inject(CONFIG_REGISTRY) reg: ConfigRegistry) {
        reg.registerCrossValidation((ctx) => {
          const db = ctx.config['db'] as { pool: { max: number } };
          seen = {
            poolMax: db.pool.max,
            suppliedMax: ctx.wasSupplied('db.pool.max'),
            suppliedMin: ctx.wasSupplied('db.pool.min'),
            frozen: Object.isFrozen(db),
          };
        });
      }
    }
    await boot({ DB__URL: 'postgres://h/db', DB__POOL__MAX: '30' }, {}, [
      RulesModule,
    ]);
    expect(seen).toEqual({
      poolMax: 30,
      suppliedMax: true,
      suppliedMin: false,
      frozen: true,
    });
  });
});

describe('precedence across sources (§5.7)', () => {
  it('test-override > process.env > local-file > committed-file', async () => {
    const committed = fakeSource('dotenv', 'committed-file', {
      APP__NAME: 'committed',
      APP__FRONTEND_URL: 'http://committed',
    });
    const local = fakeSource('dotenv-local', 'local-file', {
      APP__NAME: 'local',
      APP__FRONTEND_URL: 'http://local',
    });
    const env = fakeSource('environment', 'process.env', {
      NODE_ENV: 'test',
      APP__NAME: 'env',
    });
    const override = fakeSource('static', 'test-override', {
      APP__NAME: 'override',
    });
    // Deliberately shuffled: rank must decide, not array order.
    const { config } = await boot(
      {},
      { sources: [override, committed, env, local] },
    );
    expect(config.get('app.name')).toBe('override');
    expect(config.get('app.frontendUrl')).toBe('http://local');
  });

  it('APP__ENV is ignored: the environment comes only from NODE_ENV', async () => {
    const { config, notices } = await boot({ APP__ENV: 'production' });
    expect(config.getEnvironment()).toBe('test');
    expect(notices.map((n) => n.code)).toContain('ignored-app-env');
  });
});

describe('production secret guard (§9.2)', () => {
  const secretNs = (opts = {}) =>
    ConfigModule.forFeature('db', z.object({ url: z.string().url() }), {
      secretPaths: ['url'],
      ...opts,
    });
  const PROD = {
    NODE_ENV: 'production',
    APP__NAME: 'a',
    APP__FRONTEND_URL: 'https://a.com',
  };
  const src = (
    origin: 'committed-file' | 'local-file' | 'process.env',
    extra: Record<string, string> = {},
    viaFile = false,
  ) =>
    fakeSource(
      's',
      origin,
      { ...PROD, DB__URL: 'postgres://u:pw@h/db', ...extra },
      { viaFile },
    );

  it('blocks a literal secret from a committed file in production — naming the var, never the value', async () => {
    const err = (await boot({}, { sources: [src('committed-file')] }, [
      secretNs(),
    ]).catch((e) => e)) as ConfigValidationError;
    expect(err).toBeInstanceOf(ConfigValidationError);
    const text = err.errors.join('\n');
    expect(text).toContain(
      'DB__URL: a literal secret was read from a committed file',
    );
    expect(text).not.toContain('pw@h');
  });

  it('also blocks .local files in staging/production', async () => {
    const err = (await boot(
      {},
      { sources: [src('local-file', { NODE_ENV: 'staging' })] },
      [secretNs()],
    ).catch((e) => e)) as ConfigValidationError;
    expect(err.errors.join('\n')).toContain('a .local file');
  });

  it('allows the same literal via process.env in production', async () => {
    const { config } = await boot({}, { sources: [src('process.env')] }, [
      secretNs(),
    ]);
    expect(config.isProduction()).toBe(true);
    expect(config.get('db.url')).toBe('postgres://u:pw@h/db');
  });

  it('allows committed-file secrets in development', async () => {
    const { config } = await boot(
      {},
      { sources: [src('committed-file', { NODE_ENV: 'development' })] },
      [secretNs()],
    );
    expect(config.get('db.url')).toBeTruthy();
  });

  it('a secret reference with no registered resolver is a fail-fast error in any environment', async () => {
    const err = (await boot({ DB__URL: 'vault://kv/db#url' }, {}, [
      ConfigModule.forFeature('db', z.object({ url: z.string().min(1) }), {
        secretPaths: ['url'],
      }),
    ]).catch((e) => e)) as ConfigValidationError;
    expect(err.errors.join('\n')).toMatch(
      /DB__URL: secret reference "vault:\/\/…" but no SecretResolver/,
    );
  });

  it('with a resolver: resolves, replaces the value, records ONLY the reference in the report', async () => {
    const resolver: SecretResolver = {
      prefix: 'vault',
      resolve: async (ref) =>
        ref === 'vault://kv/db#url'
          ? 'postgres://resolved/db'
          : Promise.reject(new Error('unknown ref')),
      health: async () => ({ healthy: true, critical: true }),
    };
    const { config } = await boot(
      { DB__URL: 'vault://kv/db#url' },
      { secretResolver: resolver },
      [
        ConfigModule.forFeature('db', z.object({ url: z.string().min(1) }), {
          secretPaths: ['url'],
        }),
      ],
    );
    expect(config.get('db.url')).toBe('postgres://resolved/db');
    const report = config.getConfigReport();
    expect(report.secretRefs).toEqual([
      { path: 'db.url', ref: 'vault://kv/db#url' },
    ]);
    expect(JSON.stringify(report)).not.toContain('resolved/db');
    const metrics = config.getMetricsSnapshot();
    expect(
      metrics.counters.find(
        (c) => c.name === 'config_secret_resolutions_total',
      ),
    ).toMatchObject({
      labels: { provider: 'vault', status: 'success' },
      value: 1,
    });
  });

  it('a resolver failure aborts boot', async () => {
    const resolver: SecretResolver = {
      prefix: 'vault',
      resolve: async () => Promise.reject(new Error('403 forbidden')),
      health: async () => ({ healthy: false, critical: true }),
    };
    const err = (await boot(
      { DB__URL: 'vault://kv/db#url' },
      { secretResolver: resolver },
      [
        ConfigModule.forFeature('db', z.object({ url: z.string().min(1) }), {
          secretPaths: ['url'],
        }),
      ],
    ).catch((e) => e)) as ConfigValidationError;
    expect(err.errors.join('\n')).toContain(
      'could not resolve secret reference via "vault": 403 forbidden',
    );
  });

  it('multiline secrets: a raw newline in a plain env value fails; the same content via _FILE passes', async () => {
    const pemNs = ConfigModule.forFeature(
      'apns',
      z.object({ key: z.string().min(1) }),
      { secretPaths: ['key'] },
    );
    const pem = '-----BEGIN-----\nabc\n-----END-----';
    const bad = (await boot({ APNS__KEY: pem }, {}, [pemNs]).catch(
      (e) => e,
    )) as ConfigValidationError;
    expect(bad.errors.join('\n')).toContain('APNS__KEY_FILE only');
    const escaped = (await boot({ APNS__KEY: 'a\\nb' }, {}, [pemNs]).catch(
      (e) => e,
    )) as ConfigValidationError;
    expect(escaped.errors.join('\n')).toContain('APNS__KEY_FILE only');

    const viaFile = fakeSource(
      'environment',
      'process.env',
      { ...BASE_ENV, APNS__KEY: pem },
      { viaFile: true },
    );
    const { config } = await boot({}, { sources: [viaFile] }, [pemNs]);
    expect(config.get('apns.key')).toBe(pem);
  });

  it('secret values are NOT trimmed', async () => {
    const { config } = await boot({ DB__URL: '  postgres://h/db  ' }, {}, [
      ConfigModule.forFeature('db', z.object({ url: z.string() }), {
        secretPaths: ['url'],
      }),
    ]);
    expect(config.get('db.url')).toBe('  postgres://h/db  ');
  });

  it('JSON-blob secrets: a literal blob from a committed file is blocked in production, by blob var + index', async () => {
    const tokens = z.object({
      profiles: z
        .string()
        .transform((s) => JSON.parse(s) as unknown)
        .pipe(z.array(z.object({ name: z.string(), secretRef: z.string() }))),
    });
    const blob = JSON.stringify([
      { name: 'user', secretRef: 'a-literal-secret-that-is-long-enough-1234' },
    ]);
    const err = (await boot(
      {},
      {
        sources: [
          fakeSource('dotenv', 'committed-file', {
            ...PROD,
            TOKENS__PROFILES: blob,
          }),
        ],
      },
      [
        ConfigModule.forFeature('tokens', tokens, {
          secretPaths: ['profiles[].secretRef'],
        }),
      ],
    ).catch((e) => e)) as ConfigValidationError;
    expect(err.errors.join('\n')).toContain(
      'TOKENS__PROFILES[0].secretRef: a literal secret was read from a committed file',
    );
    expect(err.errors.join('\n')).not.toContain('a-literal-secret');
  });
});

describe('warnings (§7.9)', () => {
  it('unused var: only flags variables that plausibly belong to us', async () => {
    const dotenv = fakeSource('dotenv', 'committed-file', {
      LEGACY_DB_URL: 'x',
      OLD_THING: 'y',
      UNRELATED_FLAG: 'z',
    });
    const env = fakeSource('environment', 'process.env', {
      ...BASE_ENV,
      DATABASE__POOLL__MAX: '5', // typo: nested marker → flagged
      PATH: '/usr/bin', // ordinary process env → never flagged
      HOME: '/root',
    });
    const { notices } = await boot(
      {},
      { sources: [dotenv, env], legacyEnvVars: ['LEGACY_DB_URL'] },
    );
    const unused = notices
      .filter((n) => n.code === 'unknown-var')
      .map((n) => n.message);
    expect(unused).toContain('unused var: DATABASE__POOLL__MAX');
    expect(unused).toContain('unused var: OLD_THING'); // any var in a loaded .env* file counts
    expect(unused).toContain('unused var: UNRELATED_FLAG');
    expect(unused).not.toContain('unused var: LEGACY_DB_URL'); // allowlisted
    expect(unused.join()).not.toContain('PATH');
    expect(unused.join()).not.toContain('HOME');
  });

  it('a typo INSIDE a registered namespace is caught too (Zod strips it; we notice)', async () => {
    const { notices } = await boot(
      { DB__URL: 'postgres://h/db', DB__POOLL__MAX: '5' },
      {},
      [ConfigModule.forFeature('db', dbSchema)],
    );
    expect(notices.map((n) => n.message)).toContain(
      'unused var: DB__POOLL__MAX',
    );
  });

  it('REDIS__PUBSUB_DB: the spec-vs-algorithm naming trap is silent for an optional key — the warning must say what was meant', async () => {
    // Catalog §13.5: `redis.pubSubDb` is optional with NO default. Appendix A / §7.4 spell the
    // variable REDIS__PUBSUB_DB, but §5.1.1 maps that to `redis.pubsubDb`, which no schema declares.
    // Nothing FAILS — the value is just treated as unset — so the warning is the only signal.
    const redis = z.object({ pubSubDb: numberSchema.optional() });
    const env = fakeSource('environment', 'process.env', {
      ...BASE_ENV,
      REDIS__PUBSUB_DB: '1',
    });
    const { config, notices } = await boot({}, { sources: [env] }, [
      ConfigModule.forFeature('redis', redis),
    ]);
    expect(config.has('redis.pubSubDb')).toBe(false); // silently ignored: pins the consequence
    expect(notices.find((n) => n.code === 'unknown-var')?.message).toBe(
      'unused var: REDIS__PUBSUB_DB — did you mean REDIS__PUB_SUB_DB?',
    );

    const fixed = fakeSource('environment', 'process.env', {
      ...BASE_ENV,
      REDIS__PUB_SUB_DB: '1',
    });
    const ok = await boot({}, { sources: [fixed] }, [
      ConfigModule.forFeature('redis', redis),
    ]);
    expect(ok.config.get('redis.pubSubDb')).toBe(1);
    expect(ok.notices.filter((n) => n.code === 'unknown-var')).toEqual([]);
  });

  it('suggestions are exact (same nesting, same letters) — a real typo gets no invented guess', async () => {
    const db = z.object({
      pool: z.object({ max: numberSchema.default(10) }).default({}),
    });
    const env = fakeSource('environment', 'process.env', {
      ...BASE_ENV,
      DB__POOLL__MAX: '5', // typo: no suggestion
      DB__POOL_MAX: '5', // wrong nesting (one underscore): must NOT be "corrected" to DB__POOL__MAX
    });
    const { notices } = await boot({}, { sources: [env] }, [
      ConfigModule.forFeature('db', db),
    ]);
    const messages = notices
      .filter((n) => n.code === 'unknown-var')
      .map((n) => n.message);
    expect(messages).toContain('unused var: DB__POOLL__MAX');
    expect(messages.join()).not.toContain('did you mean');
  });

  it('NODE_ENV (rule c) is never reported as an unused variable, whichever source supplies it', async () => {
    const dotenv = fakeSource('dotenv', 'committed-file', {
      NODE_ENV: 'test',
      APP__NAME: 'a',
      APP__FRONTEND_URL: 'http://a',
    });
    const { notices } = await boot({}, { sources: [dotenv] });
    expect(notices.filter((n) => n.code === 'unknown-var')).toEqual([]);
  });

  it('warns when schema defaults are used in production, listing the paths', async () => {
    const env = fakeSource('environment', 'process.env', {
      NODE_ENV: 'production',
      APP__NAME: 'a',
      APP__FRONTEND_URL: 'https://a.com',
    });
    const { notices } = await boot({}, { sources: [env] });
    const w = notices.find((n) => n.code === 'default-in-production');
    expect(w?.level).toBe('warning');
    expect(w?.message).toContain('app.port');
  });

  it('no default-in-production warning outside production', async () => {
    const { notices } = await boot();
    expect(
      notices.find((n) => n.code === 'default-in-production'),
    ).toBeUndefined();
  });
});

describe('registration (§12, §17.2, §17.7)', () => {
  it('forFeature() registers before the pipeline runs, so a consumer reads config in its constructor', async () => {
    @Injectable()
    class Consumer {
      readonly max: number;
      constructor(@Inject(CONFIG_SERVICE) config: ConfigService) {
        this.max = config.getNamespace<{ pool: { max: number } }>(
          'db',
        ).pool.max; // sync, in the constructor
      }
    }
    @Module({
      imports: [ConfigModule.forFeature('db', dbSchema)],
      providers: [Consumer],
      exports: [Consumer],
    })
    class DbModule {}

    const { module } = await boot(
      { DB__URL: 'postgres://h/db', DB__POOL__MAX: '17' },
      {},
      [DbModule],
    );
    expect(module.get(Consumer).max).toBe(17);
  });

  it('a registrar that needs many microtask turns still lands before validation (the barrier is load-bearing)', async () => {
    // Nest orders providers only by DI edges. A registrar that first awaits other async work
    // (here: 300 promise hops) has no DI edge to CONFIG_INITIALIZER, so without the barrier in
    // the initializer the registry would already be sealed by the time it registers.
    const SLOW = Symbol('SLOW_REGISTRAR');
    @Module({
      providers: [
        {
          provide: SLOW,
          inject: [CONFIG_REGISTRY],
          useFactory: async (registry: ConfigRegistry) => {
            for (let i = 0; i < 300; i++) await Promise.resolve();
            registry.registerSchema('slow', z.object({ v: z.string() }));
            return true;
          },
        },
      ],
    })
    class SlowModule {}
    const { config } = await boot({ SLOW__V: 'ok' }, {}, [SlowModule]);
    expect(config.get('slow.v')).toBe('ok');
  });

  it('a registrar that is REALLY late (needs a macrotask) fails boot loudly instead of vanishing', async () => {
    const LATE = Symbol('LATE_REGISTRAR');
    @Module({
      providers: [
        {
          provide: LATE,
          inject: [CONFIG_REGISTRY],
          useFactory: async (registry: ConfigRegistry) => {
            await new Promise((r) => setTimeout(r, 50));
            registry.registerSchema('late', z.object({ v: z.string() }));
            return true;
          },
        },
      ],
    })
    class LateModule {}
    await expect(boot({ LATE__V: 'x' }, {}, [LateModule])).rejects.toThrow(
      /after configuration loading started/,
    );
  });

  it('many forFeature() calls in different modules ALL register (Nest must not dedupe them away)', async () => {
    const mk = (ns: string) =>
      ConfigModule.forFeature(ns, z.object({ v: z.string() }));
    const { config } = await boot({ AA__V: '1', BB__V: '2', CC__V: '3' }, {}, [
      mk('aa'),
      mk('bb'),
      mk('cc'),
    ]);
    expect(config.getConfigReport().namespaces).toEqual([
      'aa',
      'app',
      'bb',
      'cc',
    ]);
  });

  it('duplicate registration is an error — no merge, no last-write-wins', async () => {
    const dup = (): Promise<unknown> =>
      boot({ DB__URL: 'postgres://h/db' }, {}, [
        ConfigModule.forFeature('db', dbSchema),
        ConfigModule.forFeature('db', dbSchema),
      ]);
    await expect(dup()).rejects.toBeInstanceOf(ConfigRegistrationError);
    await expect(dup()).rejects.toThrow(/already registered/);
  });

  it('registering `app` again is a duplicate too (Config owns it)', async () => {
    await expect(
      boot({}, {}, [ConfigModule.forFeature('app', z.object({}))]),
    ).rejects.toBeInstanceOf(ConfigRegistrationError);
  });

  it('a registration AFTER loading started throws instead of being silently skipped', async () => {
    const { module } = await boot();
    const registry = module.get<ConfigRegistry>(CONFIG_REGISTRY);
    expect(() => registry.registerSchema('late', z.object({}))).toThrow(
      ConfigRegistrationError,
    );
    expect(() => registry.registerCrossValidation(() => undefined)).toThrow(
      /after configuration loading started/,
    );
  });

  it.each(['db.pool', 'Database', '', 'has space', 'rate-limit'])(
    'rejects invalid namespace %j',
    async (ns) => {
      await expect(
        boot({}, {}, [ConfigModule.forFeature(ns, z.object({}))]),
      ).rejects.toBeInstanceOf(ConfigRegistrationError);
    },
  );

  it('rejects malformed secretPaths', async () => {
    await expect(
      boot({}, {}, [
        ConfigModule.forFeature('x', z.object({}), { secretPaths: ['a..b'] }),
      ]),
    ).rejects.toBeInstanceOf(ConfigRegistrationError);
  });

  it('internal tokens are not exported: CONFIG_SOURCES cannot be injected from outside', async () => {
    const { CONFIG_SOURCES } =
      require('./config.tokens') as typeof import('./config.tokens');
    @Injectable()
    class Rogue {
      constructor(@Inject(CONFIG_SOURCES) readonly sources: unknown) {}
    }
    await expect(
      Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            sources: [staticSource(BASE_ENV)],
            exitOnValidationFailure: false,
          }),
        ],
        providers: [Rogue],
      }).compile(),
    ).rejects.toThrow();
  });

  it('a fresh DI container gets a fresh registry: re-registering the same namespace across suites is fine', async () => {
    const feature = ConfigModule.forFeature('db', dbSchema);
    const root = ConfigModule.forRoot({
      sources: [staticSource({ ...BASE_ENV, DB__URL: 'postgres://h/db' })],
      exitOnValidationFailure: false,
    });
    for (let i = 0; i < 2; i++) {
      const m = await Test.createTestingModule({
        imports: [root, feature],
      }).compile();
      expect(m.get<ConfigService>(CONFIG_SERVICE).get('db.url')).toBe(
        'postgres://h/db',
      );
      await m.close();
    }
  });
});

describe('report, health, metrics (§9.3, §11)', () => {
  it('getConfigReport lists namespaces and key NAMES only — never values', async () => {
    const { config } = await boot(
      { DB__URL: 'postgres://user:topsecret@h/db' },
      {},
      [ConfigModule.forFeature('db', dbSchema, { secretPaths: ['url'] })],
    );
    const report = config.getConfigReport();
    expect(report.namespaces).toEqual(['app', 'db']);
    expect(report.keys).toEqual(
      expect.arrayContaining(['app.env', 'app.name', 'db.url', 'db.pool.max']),
    );
    expect(report.secretRefs).toEqual([]); // literal env-injected secret: absent entirely
    expect(report.configVersion).toBeUndefined();
    const json = JSON.stringify(report);
    expect(json).not.toContain('topsecret');
    expect(json).not.toContain('test-app');
    expect(json).not.toContain('localhost');
  });

  it('getHealth reflects a healthy boot', async () => {
    const { config } = await boot();
    const h = config.getHealth();
    expect(h).toMatchObject({
      loaded: true,
      schemaValid: true,
      hotReloadActive: false,
    });
    expect(h.sources).toEqual([
      expect.objectContaining({
        name: 'static',
        healthy: true,
        critical: true,
      }),
    ]);
    expect(h.sources[0].lastLoadAt).toEqual(expect.any(String));
    expect(h.configVersion).toBeUndefined();
  });

  it('a source that goes unhealthy AFTER boot is reported by the NEXT getHealth() call (§11.2)', async () => {
    let healthy = true;
    const flaky = {
      ...fakeSource('flaky-watch', 'test-override', BASE_ENV),
      health: async () => ({
        healthy,
        critical: true,
        message: healthy ? undefined : 'watch connection lost',
      }),
    };
    const { config } = await boot({}, { sources: [flaky] });
    const settle = () => new Promise((r) => setImmediate(r)); // lets the in-flight background refresh finish
    expect(config.getHealth().sources[0]).toMatchObject({ healthy: true });
    await settle(); // refreshes are coalesced: don't flip the flag while one is still running

    healthy = false; // e.g. the dev file-watcher errored
    config.getHealth(); // this call triggers the (non-blocking) refresh…
    await settle();
    expect(config.getHealth().sources[0]).toMatchObject({
      healthy: false,
      error: 'watch connection lost',
    }); // …so the next call sees it
    await settle();

    healthy = true; // and it recovers the same way
    config.getHealth();
    await settle();
    expect(config.getHealth().sources[0]).toMatchObject({ healthy: true });
  });

  it('a failed LOAD stays unhealthy even if the source later claims to be fine', async () => {
    const optional = {
      ...fakeSource('flaky', 'remote', {}),
      critical: false,
      load: async () => Promise.reject(new Error('timeout')),
      health: async () => ({ healthy: true, critical: false }),
    };
    const { config } = await boot(
      {},
      { sources: [optional, staticSource(BASE_ENV)] },
    );
    config.getHealth();
    await new Promise((r) => setImmediate(r));
    expect(
      config.getHealth().sources.find((s) => s.name === 'flaky'),
    ).toMatchObject({ healthy: false, error: 'timeout' });
  });

  it('getMetricsSnapshot exposes plain numbers and no config values in labels', async () => {
    const { config } = await boot();
    const m = config.getMetricsSnapshot();
    expect(
      m.counters.find((c) => c.name === 'config_loads_total'),
    ).toMatchObject({
      labels: { source: 'static', status: 'success' },
      value: 1,
    });
    expect(
      m.histograms.find((h) => h.name === 'config_load_duration_seconds'),
    ).toMatchObject({ labels: { source: 'static' }, count: 1 });
    expect(
      m.gauges.find((g) => g.name === 'config_sources_healthy'),
    ).toMatchObject({ value: 1 });
    expect(
      m.gauges.find((g) => g.name === 'config_namespaces_registered')?.value,
    ).toBe(1);
    expect(m.gauges.find((g) => g.name === 'config_version')?.value).toBe(0);
    expect(JSON.stringify(m)).not.toContain('test-app');
  });

  it('csvArray namespace round-trips through the whole pipeline', async () => {
    const { config } = await boot(
      { HTTP__CORS__ORIGINS: 'http://a.com, http://b.com' },
      {},
      [
        ConfigModule.forFeature(
          'http',
          z.object({ cors: z.object({ origins: csvArray(z.string().url()) }) }),
        ),
      ],
    );
    expect(config.get('http.cors.origins')).toEqual([
      'http://a.com',
      'http://b.com',
    ]);
  });
});

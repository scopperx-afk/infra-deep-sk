import { z } from 'zod';
import { ConfigModule } from '../config.module';
import { ConfigRegistrationError, type ConfigNotice } from '../config.port';
import { numberSchema } from '../schema/primitives';
import {
  BASE_ENV,
  boot,
  silenceStderr,
  watchableSource,
} from '../testing/test-utils';
import {
  assertWithinWhitelist,
  matchesWhitelist,
  namespaceHasWhitelistedPath,
} from './hot-reload.whitelist';

let stderr: jest.SpyInstance;
beforeEach(() => {
  stderr = silenceStderr();
});
afterEach(() => stderr.mockRestore());

const logging = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  format: z.enum(['json', 'pretty']).default('json'),
});
const rateLimit = z.object({
  default: z
    .object({
      ttlSeconds: numberSchema.default(60),
      max: numberSchema.default(100),
    })
    .default({}),
  login: z.object({ max: numberSchema.default(5) }).default({}),
});
const sec = z.object({ token: z.string().min(1) });
const features = () => [
  ConfigModule.forFeature('logging', logging),
  ConfigModule.forFeature('rateLimit', rateLimit),
  ConfigModule.forFeature('sec', sec, { secretPaths: ['token'] }),
];
const HR = { enabled: true, paths: ['logging.level', 'rateLimit.*'] };
// `null` (not `undefined`!) means "no hotReload option": an `undefined` argument would trigger the default param.
const start = (
  source = watchableSource({ ...BASE_ENV, SEC__TOKEN: 'tok' }),
  hotReload: typeof HR | null = HR,
) =>
  boot(
    {},
    { sources: [source], ...(hotReload ? { hotReload } : {}) },
    features(),
  ).then((b) => ({ ...b, source }));

const codes = (notices: ConfigNotice[]) => notices.map((n) => n.code);

describe('whitelist grammar (§10.1)', () => {
  it('exact path matches only that leaf; `.*` matches the subtree below, at any depth', () => {
    expect(matchesWhitelist('logging.level')).toBe(true);
    expect(matchesWhitelist('logging.format')).toBe(false);
    expect(matchesWhitelist('logging')).toBe(false);
    expect(matchesWhitelist('logging.level.extra')).toBe(false);
    expect(matchesWhitelist('rateLimit.default.ttlSeconds')).toBe(true);
    expect(matchesWhitelist('rateLimit.login.max')).toBe(true);
    expect(matchesWhitelist('rateLimit')).toBe(false); // the bare namespace is onNamespaceChange territory
    expect(matchesWhitelist('database.url')).toBe(false);
  });

  it('array-element paths are never matchable', () => {
    expect(matchesWhitelist('rateLimit.tiers[0].max')).toBe(false);
    expect(matchesWhitelist('rateLimit.tiers.0.max')).toBe(false);
  });

  it('namespace subscription needs some whitelisted path inside the namespace', () => {
    expect(namespaceHasWhitelistedPath('logging')).toBe(true);
    expect(namespaceHasWhitelistedPath('rateLimit')).toBe(true);
    expect(namespaceHasWhitelistedPath('database')).toBe(false);
  });

  it('options can narrow the whitelist but never widen it', () => {
    expect(() => assertWithinWhitelist(['logging.level'])).not.toThrow();
    expect(() => assertWithinWhitelist(['rateLimit.login.*'])).not.toThrow();
    expect(() => assertWithinWhitelist(['database.url'])).toThrow(
      ConfigRegistrationError,
    );
    expect(() => assertWithinWhitelist(['logging.*'])).toThrow(
      ConfigRegistrationError,
    );
    for (const bad of [
      '*',
      '**',
      '*.level',
      'logging.*.level',
      'logging..level',
      'rateLimit.**',
    ])
      expect(() => assertWithinWhitelist([bad])).toThrow(
        ConfigRegistrationError,
      );
    expect(() =>
      ConfigModule.forRoot({
        hotReload: { enabled: true, paths: ['database.url'] },
      }),
    ).toThrow(ConfigRegistrationError);
  });
});

describe('subscription-time errors (§10.1)', () => {
  it('onChange on a non-whitelisted path throws SYNCHRONOUSLY', async () => {
    const { config } = await start();
    expect(() => config.onChange('app.port', () => undefined)).toThrow(
      ConfigRegistrationError,
    );
    expect(() => config.onChange('logging.format', () => undefined)).toThrow(
      ConfigRegistrationError,
    );
    expect(() => config.onChange('rateLimit', () => undefined)).toThrow(
      /onNamespaceChange/,
    );
    expect(() =>
      config.onChange('rateLimit.tiers[0].max', () => undefined),
    ).toThrow(ConfigRegistrationError);
  });

  it('onNamespaceChange on a namespace with no whitelisted path throws', async () => {
    const { config } = await start();
    expect(() => config.onNamespaceChange('app', () => undefined)).toThrow(
      ConfigRegistrationError,
    );
    expect(() =>
      config.onNamespaceChange('logging', () => undefined),
    ).not.toThrow();
    expect(() =>
      config.onNamespaceChange('rateLimit', () => undefined),
    ).not.toThrow();
  });

  it('subscribing is legal even when hot reload is disabled (a consumer must not care about deployment)', async () => {
    const { config } = await start(undefined, null);
    expect(() =>
      config.onChange('logging.level', () => undefined),
    ).not.toThrow();
  });
});

describe('a whitelisted change (§10.3)', () => {
  it('atomically swaps the snapshot, bumps configVersion, fires the listener with the NEW value', async () => {
    const { config, source } = await start();
    const seen: string[] = [];
    config.onChange<string>('logging.level', (v) => seen.push(v));

    const beforeNs = config.getNamespace<{ level: string; format: string }>(
      'logging',
    );
    expect(beforeNs.level).toBe('info');
    expect(config.getConfigReport().configVersion).toBeUndefined();

    source.emit({ LOGGING__LEVEL: 'debug' });

    expect(config.get('logging.level')).toBe('debug'); // fresh read sees the new value
    expect(seen).toEqual(['debug']);
    expect(config.getConfigReport().configVersion).toBe(1);
    expect(config.getHealth()).toMatchObject({
      configVersion: 1,
      hotReloadActive: true,
    });

    // Stale-reference contract (§10.3): the object obtained BEFORE the swap is a frozen
    // point-in-time value; it is never mutated, so it keeps reading pre-swap data.
    expect(beforeNs.level).toBe('info');
    expect(Object.isFrozen(config.getNamespace('logging'))).toBe(true);
    // Unrelated fields of the namespace are untouched
    expect(config.get('logging.format')).toBe('json');
  });

  it('a `rateLimit.*` change reaches both onChange (leaf) and onNamespaceChange, in registration order', async () => {
    const { config, source } = await start();
    const order: string[] = [];
    config.onNamespaceChange<{ default: { max: number } }>('rateLimit', (ns) =>
      order.push(`ns:${ns.default.max}`),
    );
    config.onChange<number>('rateLimit.default.max', (v) =>
      order.push(`leaf:${v}`),
    );
    config.onChange<number>('rateLimit.login.max', (v) =>
      order.push(`login:${v}`),
    ); // unchanged → must NOT fire

    source.emit({ RATE_LIMIT__DEFAULT__MAX: '250' });

    expect(config.get('rateLimit.default.max')).toBe(250);
    expect(order).toEqual(['ns:250', 'leaf:250']);
  });

  it('a batch touching several paths is ONE swap (version +1)', async () => {
    const { config, source } = await start();
    source.emit({
      LOGGING__LEVEL: 'warn',
      RATE_LIMIT__DEFAULT__MAX: '7',
      RATE_LIMIT__LOGIN__MAX: '2',
    });
    expect(config.get('logging.level')).toBe('warn');
    expect(config.get('rateLimit.default.max')).toBe(7);
    expect(config.get('rateLimit.login.max')).toBe(2);
    expect(config.getConfigReport().configVersion).toBe(1);
    const m = config.getMetricsSnapshot();
    expect(
      m.counters
        .filter((c) => c.name === 'config_hot_reloads_total')
        .map((c) => c.labels.path)
        .sort(),
    ).toEqual([
      'logging.level',
      'rateLimit.default.max',
      'rateLimit.login.max',
    ]);
    expect(m.gauges.find((g) => g.name === 'config_version')?.value).toBe(1);
  });

  it('re-applying an identical value fires nobody', async () => {
    const { config, source } = await start();
    const fn = jest.fn();
    config.onChange('logging.level', fn);
    source.emit({ LOGGING__LEVEL: 'info' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('unsubscribe stops delivery', async () => {
    const { config, source } = await start();
    const fn = jest.fn();
    const off = config.onChange('logging.level', fn);
    off();
    source.emit({ LOGGING__LEVEL: 'error' });
    expect(fn).not.toHaveBeenCalled();
    expect(config.get('logging.level')).toBe('error'); // the swap itself still happened
  });
});

describe('rejections leave the old value active (§10.2)', () => {
  it('an INVALID value is rejected, reported, and changes nothing', async () => {
    const { config, source, notices } = await start();
    const fn = jest.fn();
    config.onChange('logging.level', fn);
    source.emit({ LOGGING__LEVEL: 'verbose' });
    expect(config.get('logging.level')).toBe('info');
    expect(config.getConfigReport().configVersion).toBeUndefined();
    expect(fn).not.toHaveBeenCalled();
    const n = notices.find((x) => x.code === 'hot-reload-rejected');
    expect(n?.level).toBe('error');
    expect(n?.message).toContain('LOGGING__LEVEL');
  });

  it('a mixed batch applies the valid namespace and rejects the invalid one', async () => {
    const { config, source, notices } = await start();
    source.emit({ LOGGING__LEVEL: 'verbose', RATE_LIMIT__DEFAULT__MAX: '9' });
    expect(config.get('logging.level')).toBe('info');
    expect(config.get('rateLimit.default.max')).toBe(9);
    expect(codes(notices)).toContain('hot-reload-rejected');
  });

  it('a SECRET-marked path is rejected outright, never applied — checked before the whitelist', async () => {
    const { config, source, notices } = await start();
    source.emit({ SEC__TOKEN: 'rotated-live' });
    expect(config.get('sec.token')).toBe('tok');
    const n = notices.find((x) => x.code === 'hot-reload-rejected');
    expect(n?.message).toContain('SEC__TOKEN');
    expect(n?.message).toContain('secret-marked path');
    expect(n?.message).not.toContain('rotated-live');
  });

  it('a non-whitelisted change is ignored with a "restart required" warning', async () => {
    const { config, source, notices } = await start();
    source.emit({ APP__PORT: '9999' });
    expect(config.get('app.port')).toBe(3000);
    const n = notices.find((x) => x.code === 'hot-reload-ignored');
    expect(n?.level).toBe('warning');
    expect(n?.message).toContain('APP__PORT');
  });

  it('APP__ENV / NODE_ENV can never be hot-swapped', async () => {
    const { config, source } = await start();
    source.emit({ NODE_ENV: 'production' });
    expect(config.getEnvironment()).toBe('test');
  });

  it('a throwing listener neither rolls back the swap nor stops the others', async () => {
    const { config, source, notices } = await start();
    const second = jest.fn();
    config.onChange('logging.level', () => {
      throw new Error('listener bug');
    });
    config.onChange('logging.level', second);
    source.emit({ LOGGING__LEVEL: 'debug' });
    expect(config.get('logging.level')).toBe('debug');
    expect(second).toHaveBeenCalledWith('debug');
    expect(
      notices.find((n) => n.code === 'hot-reload-listener-error')?.message,
    ).toContain('listener bug');
  });
});

describe('hot reload is gated by environment and options (§5.6, §11.2)', () => {
  it('disabled by default: the source is never asked to watch', async () => {
    const source = watchableSource({ ...BASE_ENV, SEC__TOKEN: 'tok' });
    const { config } = await start(source, null);
    expect(source.watching()).toBe(false);
    expect(config.getHealth().hotReloadActive).toBe(false);
  });

  it('enabled in test/development: watching, hotReloadActive true', async () => {
    const source = watchableSource({ ...BASE_ENV, SEC__TOKEN: 'tok' });
    const { config } = await start(source);
    expect(source.watching()).toBe(true);
    expect(config.getHealth().hotReloadActive).toBe(true);
  });

  it('NEVER starts a dev-only watch in staging/production, even when enabled — and says so honestly', async () => {
    const source = watchableSource({
      ...BASE_ENV,
      NODE_ENV: 'staging',
      SEC__TOKEN: 'tok',
    });
    const { config } = await start(source);
    expect(source.watching()).toBe(false);
    expect(config.getHealth().hotReloadActive).toBe(false);
  });

  it('the `sources` option filters which watch-capable sources may deliver updates', async () => {
    const source = watchableSource(
      { ...BASE_ENV, SEC__TOKEN: 'tok' },
      { name: 'dotenv' },
    );
    await start(source, { ...HR, sources: ['remote'] } as typeof HR);
    expect(source.watching()).toBe(false);
  });

  it('options.paths NARROWS delivery: a whitelisted path outside the option list is ignored', async () => {
    const source = watchableSource({ ...BASE_ENV, SEC__TOKEN: 'tok' });
    const { config, notices } = await start(source, {
      enabled: true,
      paths: ['logging.level'],
    });
    source.emit({ RATE_LIMIT__DEFAULT__MAX: '5' });
    expect(config.get('rateLimit.default.max')).toBe(100);
    expect(codes(notices)).toContain('hot-reload-ignored');
    source.emit({ LOGGING__LEVEL: 'debug' });
    expect(config.get('logging.level')).toBe('debug');
  });

  it('closing the app stops the watcher (no leaked subscription)', async () => {
    const source = watchableSource({ ...BASE_ENV, SEC__TOKEN: 'tok' });
    const { module, config } = await start(source);
    expect(source.watching()).toBe(true);
    await module.close();
    expect(source.watching()).toBe(false);
    expect(config.getHealth().hotReloadActive).toBe(false);
  });
});

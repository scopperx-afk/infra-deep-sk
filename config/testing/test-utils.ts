/**
 * Shared helpers for the Config module's own tests. Not part of the public surface.
 */
import { Test, type TestingModule } from '@nestjs/testing';
import type { Type, DynamicModule } from '@nestjs/common';
import { ConfigModule } from '../config.module';
import type {
  ConfigModuleOptions,
  ConfigNotice,
  ConfigService,
} from '../config.port';
import { CONFIG_SERVICE } from '../config.tokens';
import type {
  ConfigSource,
  ConfigValueOrigin,
  RawValueWithProvenance,
  Unsubscribe,
} from '../sources/config-source.port';
import type { Environment } from '../config.port';
import { staticSource } from '../sources/static.source';

export const BASE_ENV = {
  NODE_ENV: 'test',
  APP__NAME: 'test-app',
  APP__FRONTEND_URL: 'http://localhost:5173',
};

export interface Booted {
  module: TestingModule;
  config: ConfigService;
  notices: ConfigNotice[];
  close(): Promise<void>;
}

export async function boot(
  data: Record<string, unknown> = {},
  opts: Partial<ConfigModuleOptions> = {},
  extraImports: Array<Type<unknown> | DynamicModule> = [],
): Promise<Booted> {
  const notices: ConfigNotice[] = [];
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        sources: opts.sources ?? [staticSource({ ...BASE_ENV, ...data })],
        exitOnValidationFailure: false,
        onNotice: (n) => notices.push(n),
        ...opts,
      }),
      ...extraImports,
    ],
  }).compile();
  return {
    module,
    config: module.get<ConfigService>(CONFIG_SERVICE),
    notices,
    close: () => module.close(),
  };
}

/** A source with a chosen origin/name — for precedence and guard tests. */
export function fakeSource(
  name: string,
  origin: ConfigValueOrigin,
  data: Record<string, string>,
  extra: Partial<ConfigSource> & { viaFile?: boolean } = {},
): ConfigSource {
  const { viaFile, ...rest } = extra;
  return {
    name,
    critical: true,
    async load() {
      const out: Record<string, RawValueWithProvenance> = {};
      for (const [k, v] of Object.entries(data))
        out[k] = { value: v, origin, ...(viaFile ? { viaFile } : {}) };
      return out;
    },
    async health() {
      return { healthy: true, critical: true };
    },
    ...rest,
  };
}

/** A watch-capable source the test can push updates through. */
export function watchableSource(
  initial: Record<string, string>,
  opts: { name?: string; watchEnvironments?: readonly Environment[] } = {},
): ConfigSource & {
  emit(updates: Record<string, string>): void;
  watching(): boolean;
} {
  let callback:
    ((u: Record<string, RawValueWithProvenance>) => void) | undefined;
  return {
    name: opts.name ?? 'dotenv',
    critical: true,
    watchEnvironments: opts.watchEnvironments ?? ['development', 'test'],
    async load() {
      return Object.fromEntries(
        Object.entries(initial).map(([k, v]) => [
          k,
          { value: v, origin: 'test-override' as const },
        ]),
      );
    },
    watch(cb): Unsubscribe {
      callback = cb;
      return () => {
        callback = undefined;
      };
    },
    async health() {
      return { healthy: true, critical: true };
    },
    emit(updates) {
      callback?.(
        Object.fromEntries(
          Object.entries(updates).map(([k, v]) => [
            k,
            { value: v, origin: 'test-override' as const },
          ]),
        ),
      );
    },
    watching: () => callback !== undefined,
  };
}

export function silenceStderr(): jest.SpyInstance {
  return jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
}

/**
 * ConfigModule.forRoot() / forFeature() — Config spec §3.3, §17.2.
 *
 * forRoot()  builds the whole pipeline as a GLOBAL dynamic module: CONFIG_SERVICE is an
 *            async factory provider, so Nest resolves it (load → validate → guard →
 *            freeze) BEFORE any consumer's constructor runs — which is what lets a
 *            consumer read `config.getNamespace(...)` synchronously in its constructor
 *            (§3.2). Validation failure aborts boot (§6).
 * forFeature() is sugar over `ConfigRegistry.registerSchema()`: a pure registration
 *            hand-off. Config never imports the calling module (§2, §17.6).
 */
import {
  Inject,
  Module,
  type DynamicModule,
  type OnModuleDestroy,
  type Provider,
} from '@nestjs/common';
import type { ZodType, ZodTypeDef } from 'zod';
import type { ConfigModuleOptions, RegisterOptions } from './config.port';
import { initializeConfig, type ConfigInitResult } from './config.initializer';
import { ConfigServiceImpl } from './config.service';
import {
  CONFIG_INITIALIZER,
  CONFIG_LISTENERS,
  CONFIG_LOADER,
  CONFIG_NOTIFIER,
  CONFIG_OBSERVATION,
  CONFIG_OPTIONS,
  CONFIG_REGISTRY,
  CONFIG_SERVICE,
  CONFIG_SOURCES,
  CONFIG_STORE,
  CONFIG_VALIDATOR,
  SECRET_RESOLVER,
} from './config.tokens';
import { assertWithinWhitelist } from './hot-reload/hot-reload.whitelist';
import { ListenerRegistry } from './hot-reload/hot-reload.listeners';
import { ConfigNotifier } from './notices/config.notice';
import { ConfigObservation } from './observation/config.observation';
import { ConfigLoader } from './pipeline/config.loader';
import { ConfigValidator } from './pipeline/config.validator';
import { appConfigSchema } from './schema/app.schema';
import { ConfigRegistryImpl } from './schema/registry';
import type { ConfigSource } from './sources/config-source.port';
import { DotenvConfigSource } from './sources/dotenv.source';
import { EnvironmentConfigSource } from './sources/env.source';
import { ConfigStore } from './store/config.store';

/** Internal carrier for forFeature() registrars. Not exported from index.ts. */
@Module({})
export class ConfigFeatureModule {}

/** "Build now" sources only (§15): env + dotenv. Nothing speculative. */
const defaultSources = (): ConfigSource[] => [
  new DotenvConfigSource(),
  new EnvironmentConfigSource(),
];

let featureSeq = 0;

@Module({})
export class ConfigModule implements OnModuleDestroy {
  constructor(
    @Inject(CONFIG_INITIALIZER) private readonly initialized: ConfigInitResult,
  ) {}

  onModuleDestroy(): void {
    this.initialized.dispose();
  }

  static forRoot(options: ConfigModuleOptions = {}): DynamicModule {
    // Synchronous, at module-definition time: a widened whitelist is a boot-time error (§10.1).
    if (options.hotReload?.paths)
      assertWithinWhitelist(options.hotReload.paths);

    // Stateful collaborators are FACTORIES, not useValue instances: every DI container
    // (every test suite — §17.3) gets a fresh registry/store even if this DynamicModule
    // object is reused.
    const providers: Provider[] = [
      { provide: CONFIG_OPTIONS, useValue: options },
      {
        provide: CONFIG_SOURCES,
        useFactory: () => options.sources ?? defaultSources(),
      },
      { provide: SECRET_RESOLVER, useValue: options.secretResolver ?? null },
      {
        provide: CONFIG_NOTIFIER,
        useFactory: () => new ConfigNotifier(options.onNotice),
      },
      {
        provide: CONFIG_OBSERVATION,
        useFactory: () => new ConfigObservation(),
      },
      { provide: CONFIG_STORE, useFactory: () => new ConfigStore() },
      { provide: CONFIG_LISTENERS, useFactory: () => new ListenerRegistry() },
      { provide: CONFIG_LOADER, useFactory: () => new ConfigLoader() },
      { provide: CONFIG_VALIDATOR, useFactory: () => new ConfigValidator() },
      {
        // `app.*` is the one namespace Config owns (see schema/app.schema.ts).
        provide: CONFIG_REGISTRY,
        useFactory: () => {
          const registry = new ConfigRegistryImpl();
          registry.registerSchema('app', appConfigSchema, {
            description: 'Application identity (§13.1)',
          });
          return registry;
        },
      },
      {
        provide: CONFIG_INITIALIZER,
        useFactory: (
          opts: ConfigModuleOptions,
          sources: ConfigSource[],
          registry: ConfigRegistryImpl,
          store: ConfigStore,
          loader: ConfigLoader,
          validator: ConfigValidator,
          observation: ConfigObservation,
          notifier: ConfigNotifier,
          listeners: ListenerRegistry,
          resolver: ConfigModuleOptions['secretResolver'] | null,
        ) =>
          initializeConfig({
            options: opts,
            sources,
            registry,
            store,
            loader,
            validator,
            observation,
            notifier,
            listeners,
            resolver: resolver ?? null,
          }),
        inject: [
          CONFIG_OPTIONS,
          CONFIG_SOURCES,
          CONFIG_REGISTRY,
          CONFIG_STORE,
          CONFIG_LOADER,
          CONFIG_VALIDATOR,
          CONFIG_OBSERVATION,
          CONFIG_NOTIFIER,
          CONFIG_LISTENERS,
          SECRET_RESOLVER,
        ],
      },
      {
        // Depends on CONFIG_INITIALIZER, so every consumer of CONFIG_SERVICE is only
        // instantiated after the whole pipeline has finished.
        provide: CONFIG_SERVICE,
        useFactory: (
          _initialized: ConfigInitResult,
          store: ConfigStore,
          registry: ConfigRegistryImpl,
          listeners: ListenerRegistry,
          observation: ConfigObservation,
        ) => new ConfigServiceImpl(store, registry, listeners, observation),
        inject: [
          CONFIG_INITIALIZER,
          CONFIG_STORE,
          CONFIG_REGISTRY,
          CONFIG_LISTENERS,
          CONFIG_OBSERVATION,
        ],
      },
    ];

    return {
      module: ConfigModule,
      global: true, // so forFeature() finds CONFIG_REGISTRY from any module (§17.2)
      providers,
      exports: [CONFIG_SERVICE, CONFIG_REGISTRY, CONFIG_OPTIONS], // internal tokens stay private (§4)
    };
  }

  static forFeature<T>(
    namespace: string,
    schema: ZodType<T, ZodTypeDef, unknown>,
    options?: RegisterOptions,
  ): DynamicModule {
    // The provider token must be UNIQUE per call: Nest de-duplicates dynamic modules by
    // their serialized metadata, and two forFeature() calls would otherwise serialize
    // identically (same factory source) and the second registration would silently vanish.
    const token = Symbol(`CONFIG_FEATURE:${namespace}#${++featureSeq}`);
    return {
      module: ConfigFeatureModule,
      providers: [
        {
          provide: token,
          useFactory: (registry: ConfigRegistryImpl) => {
            registry.registerSchema(namespace, schema, options);
            return true;
          },
          inject: [CONFIG_REGISTRY],
        },
      ],
    };
  }
}

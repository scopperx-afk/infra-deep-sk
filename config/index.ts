/**
 * config/index.ts — the ONLY public surface of the Config module (§17.5).
 *
 * Everything else (loader, validator, guards, individual source adapters, the registry's
 * internal storage, CONFIG_SOURCES, …) is unreachable from outside `config/`, enforced by
 * the ESLint boundary rule (§4, §21): `src/infrastructure/config/**` may only be
 * imported via this file.
 *
 * NOTE (§17.5 vs §20): the spec's index sketch re-exports `DatabaseConfig`, `RedisConfig`,
 * … from `./schemas`, but §12/§17.6 say every module registers ITS OWN schema. Config
 * therefore exports only the type of the one namespace it owns (`AppConfig`); each other
 * module exports its own `XxxConfig` type next to its own schema.
 */
export { ConfigModule } from './config.module';
export {
  ConfigMissingError,
  ConfigRegistrationError,
  ConfigValidationError,
} from './config.port';
export type {
  ConfigHealth,
  ConfigHistogramSample,
  ConfigMetricSample,
  ConfigMetricsSnapshot,
  ConfigModuleOptions,
  ConfigNotice,
  ConfigNoticeLevel,
  ConfigRegistry,
  ConfigReport,
  ConfigService,
  CrossValidationContext,
  CrossValidationFn,
  Environment,
  HotReloadOptions,
  RegisterOptions,
  Unsubscribe,
} from './config.port';
export {
  CONFIG_OPTIONS,
  CONFIG_REGISTRY,
  CONFIG_SERVICE,
} from './config.tokens'; // NOT CONFIG_SOURCES (§4)

// Primitive schemas every module needs to author its own namespace schema (§7.10).
export {
  booleanSchema,
  csvArray,
  durationSchema,
  mimeSchema,
  numberSchema,
  portSchema,
  secretValueSchema,
} from './schema/primitives';
export type { AppConfig } from './schema/app.schema';

// Extension points.
export type {
  ConfigSource,
  ConfigValueOrigin,
  RawValueWithProvenance,
  SourceHealth,
} from './sources/config-source.port';
export type { SecretResolver } from './secrets/secret.resolver.port';

// §3.4 — a real testing utility, not an internal leak.
export { staticSource } from './sources/static.source';

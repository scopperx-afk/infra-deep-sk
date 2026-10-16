/**
 * DI tokens — Logger spec §37.
 *
 * Plain Symbol() only, never Symbol.for() (matching Config's and Tracing's own
 * token rule). There is no LOGGER_REGISTRY and no forFeature() — unlike
 * Config, Logger has no per-consumer schema to register (§37).
 */

// ── Public (re-exported from index.ts) ───────────────────────────────────────
export const LOGGER_SERVICE = Symbol('LOGGER_SERVICE'); // ILogger
export const LOGGER_RUNTIME = Symbol('LOGGER_RUNTIME'); // LoggerRuntime (§6)

// ── Internal — NOT exported from index.ts (§37) ───────────────────────────────
export const LOGGER_OPTIONS = Symbol('LOGGER_OPTIONS');
export const LOGGER_TRANSPORTS = Symbol('LOGGER_TRANSPORTS');
export const LOGGER_REDACTOR = Symbol('LOGGER_REDACTOR');
export const LOGGER_SAMPLER = Symbol('LOGGER_SAMPLER');
// NOTE: §37 also lists a `LOG_CONTEXT_STORE` token. Not declared here — see
// SPEC-ERRATA.md E-L7: the `LogContext` ALS is a plain module-level singleton
// (context/log-context.store.ts), the same pattern Tracing's OWN ALS store
// uses with NO DI token of its own (tracing.context.ts). A token with no
// provider and no injection site would be dead code.

// Implementation-detail tokens this implementation adds, for the same reason
// Config's config.tokens.ts adds CONFIG_OBSERVATION/CONFIG_NOTIFIER/
// CONFIG_LISTENERS beyond its own spec's §4 list: keeps every collaborator
// injectable and unit-testable without inventing a second place tokens live.
export const LOGGER_OBSERVATION = Symbol('LOGGER_OBSERVATION');
export const LOGGER_DISPATCHERS = Symbol('LOGGER_DISPATCHERS');
export const LOGGER_LEVEL_HOLDER = Symbol('LOGGER_LEVEL_HOLDER'); // the shared { current: LogLevel } cell — see logger.service.ts

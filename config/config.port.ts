/**
 * Public contract of the Config module — Config spec §3, §11.
 * Interfaces and error classes only; no behavior lives here.
 */
import type { ZodType, ZodTypeDef } from 'zod';
import type { ConfigSource, Unsubscribe } from './sources/config-source.port';
import type { SecretResolver } from './secrets/secret.resolver.port';

export type { Unsubscribe };
export type Environment = 'development' | 'staging' | 'production' | 'test';

// ─────────────────────────────────────────────────────────────────────────────
// ConfigService (read side)
// ─────────────────────────────────────────────────────────────────────────────
export interface ConfigService {
  /**
   * Typed read by dotted path.
   * Throws ConfigMissingError if the path was never registered by any schema,
   * or if it's registered-but-optional and no value is present.
   * Never returns undefined silently (Anti-Pattern #7).
   *
   * ⚠️ Throws on an UNREGISTERED path even when you pass a default — see the
   * two-argument overload below. Intentional (§3, §16 #7).
   */
  get<T = unknown>(path: string): T;

  /**
   * Same lookup, but returns defaultValue when a *registered* path's value is
   * genuinely absent (undefined) after validation. A legitimately `null` value
   * is a present value and is returned as-is, never replaced by defaultValue.
   */
  get<T = unknown>(path: string, defaultValue: T): T;

  /**
   * true iff `path` was registered by some schema AND currently resolves to a
   * defined value (including an explicit, schema-valid `null`). false for BOTH
   * "never registered" and "registered but currently absent". Never throws.
   */
  has(path: string): boolean;

  /** Entire namespace as a typed object. Throws ConfigMissingError if never registered. */
  getNamespace<T>(namespace: string): T;

  isProduction(): boolean;
  getEnvironment(): Environment;

  /**
   * Fires when a *whitelisted* path changes via hot-reload. Subscribing to a
   * non-whitelisted path throws ConfigRegistrationError synchronously (§10.1).
   * The value passed to `callback` is a one-shot frozen snapshot taken at fire
   * time — holding onto it across reloads means reading a stale copy (§10.3).
   */
  onChange<T>(path: string, callback: (value: T) => void): Unsubscribe;
  onNamespaceChange<T>(
    namespace: string,
    callback: (config: T) => void,
  ): Unsubscribe;

  /** Safe manifest for startup logging/audit — namespaces and key names only, never values. */
  getConfigReport(): ConfigReport;

  /** Pull-based health read for the Health aggregator module (§11.2). */
  getHealth(): ConfigHealth;

  /** Pull-based metrics read for the Metrics module (§11.3). */
  getMetricsSnapshot(): ConfigMetricsSnapshot;
}

export interface ConfigReport {
  namespaces: string[];
  keys: string[];
  /**
   * Path + reference string for every schema-marked secret field resolved via a
   * reference — never the resolved value, and absent entirely for env-injected
   * literal secrets.
   */
  secretRefs: Array<{ path: string; ref: string }>;
  /** Absent (or 0) at fresh startup; +1 on every successful hot-reload swap. */
  configVersion?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// ConfigRegistry (write side — registration only)
// ─────────────────────────────────────────────────────────────────────────────
/** Registration only — reading always goes through ConfigService, never ConfigRegistry. */
export interface ConfigRegistry {
  /**
   * `ZodType<T, ZodTypeDef, unknown>` (input type left open): schemas that
   * coerce/transform (durations, ports, CSV) have an input type ≠ output type
   * and would not be assignable to the narrower `ZodType<T>`.
   */
  registerSchema<T>(
    namespace: string,
    schema: ZodType<T, ZodTypeDef, unknown>,
    options?: RegisterOptions,
  ): void;
  /**
   * Runs after every individual namespace schema has already passed (§7.4).
   * Every registered function runs on every validation pass; one throwing does
   * not prevent the others — all failures are collected (§6, §7.9).
   */
  registerCrossValidation(fn: CrossValidationFn): void;
}

/**
 * What a cross-validation function receives. `config` is every namespace's
 * already individually-validated, typed, defaulted value, keyed by namespace name.
 * `wasSupplied(path)` answers "did some source actually provide this value, or did
 * it come entirely from a Zod `.default()`?" (§7.4, §7.9).
 */
export interface CrossValidationContext {
  readonly config: Readonly<Record<string, unknown>>;
  wasSupplied(path: string): boolean;
}
export type CrossValidationFn = (ctx: CrossValidationContext) => void; // throws ConfigValidationError on failure

export interface RegisterOptions {
  description?: string;
  /**
   * Dotted paths, relative to this namespace, that hold secret values (e.g.
   * ["url"] for `database`, ["profiles[].secretRef"] for `tokens`). This is the
   * ONLY mechanism Config uses to classify a path as secret (§7.5) — it never
   * walks Zod schema internals to guess.
   */
  secretPaths?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Module options
// ─────────────────────────────────────────────────────────────────────────────
export interface HotReloadOptions {
  enabled: boolean;
  /**
   * Exact dotted paths, or a dotted prefix ending in ".*" (§10.1). Must be a
   * subset of the project whitelist (`logging.level`, `rateLimit.*`) — options can
   * narrow the whitelist, never widen it.
   */
  paths: string[];
  /**
   * Optional filter on which watch-capable sources may deliver updates, matched
   * against `ConfigSource.name`. Omitted = every source that implements watch().
   */
  sources?: Array<'dotenv' | 'remote'>;
  pollIntervalMs?: number;
}

export type ConfigNoticeLevel = 'warning' | 'error';
export interface ConfigNotice {
  level: ConfigNoticeLevel;
  /** e.g. "unknown-var", "default-in-production", "hot-reload-rejected" */
  code: string;
  message: string;
}

export interface ConfigModuleOptions {
  sources?: ConfigSource[];
  hotReload?: HotReloadOptions;
  /**
   * Single channel for both a rejected hot-reload update and general warnings
   * (§10.2, §11.5). Defaults to a structured line on process.stderr — Config
   * never depends on Logger.
   */
  onNotice?: (notice: ConfigNotice) => void;
  /**
   * Defaults to true (process.exit(1) on validation failure, §6). Set to false in
   * test bootstrap contexts so tests can assert on the thrown ConfigValidationError.
   */
  exitOnValidationFailure?: boolean;
  /**
   * The one SecretResolver (§5.5). Deferred: no adapter ships yet, so this is
   * normally omitted; when omitted, any secret *reference* is a fail-fast error (§9.2).
   */
  secretResolver?: SecretResolver;
  /**
   * Legacy flat variable names (Appendix B) still tolerated during migration —
   * excluded from the "unused var" warning (§7.9, §11.5).
   */
  legacyEnvVars?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Health & metrics (pull-based observation port, §11.2–§11.3)
// ─────────────────────────────────────────────────────────────────────────────
export interface ConfigHealth {
  loaded: boolean;
  sources: Array<{
    name: string;
    healthy: boolean;
    critical: boolean;
    lastLoadAt?: string;
    latencyMs?: number;
    error?: string;
  }>;
  schemaValid: boolean;
  hotReloadActive: boolean;
  configVersion?: number;
}

export interface ConfigMetricSample {
  name: string;
  /** Never contains config values (§11.3). */
  labels: Record<string, string>;
  value: number;
}
export interface ConfigHistogramSample {
  name: string;
  labels: Record<string, string>;
  count: number;
  /** Sum of observed values, in seconds. */
  sum: number;
}
/** Plain numbers only — the Metrics module relabels these into its own system. */
export interface ConfigMetricsSnapshot {
  counters: ConfigMetricSample[];
  histograms: ConfigHistogramSample[];
  gauges: ConfigMetricSample[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────
export class ConfigMissingError extends Error {
  constructor(
    public readonly path: string,
    public readonly reason: 'unregistered' | 'absent' = 'unregistered',
  ) {
    super(
      reason === 'unregistered'
        ? `Config path "${path}" was never registered by any schema.`
        : `Config path "${path}" is registered but has no value (no source supplied it and its schema has no default).`,
    );
    this.name = 'ConfigMissingError';
  }
}

export class ConfigValidationError extends Error {
  constructor(
    public readonly namespace: string,
    message: string,
    /** Individual error lines when this error aggregates a whole failed boot. */
    public readonly errors: readonly string[] = [],
  ) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

/**
 * Thrown for every registration/subscription-time misuse this spec defines as a
 * hard error rather than silent behavior: registering the same namespace twice
 * (§17.7), subscribing onChange/onNamespaceChange to a non-whitelisted path
 * (§10.1), and a secret-marked path reported by watch() (§10.2).
 */
export class ConfigRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigRegistrationError';
  }
}

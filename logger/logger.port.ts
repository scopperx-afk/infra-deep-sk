/**
 * Public contract of the Logger module — Logger spec §6, §8, §25, §26.
 * Interfaces and plain types only; no behavior lives here (mirrors config.port.ts's
 * and tracing.port.ts's own split).
 */

// ─────────────────────────────────────────────────────────────────────────────
// §5 — Log levels
// ─────────────────────────────────────────────────────────────────────────────
/**
 * TRACE → DEBUG → INFO → AUDIT → WARN → ERROR → FATAL (§5). AUDIT sits between
 * INFO and WARN in severity order — it is a first-class level with its own
 * ordinal, not an alias for INFO or WARN. Level FILTERING (is this level enabled
 * given the configured minimum?) uses this ordering; level SAMPLING (§16) is a
 * completely separate, per-level policy applied afterward.
 */
export type LogLevel =
  'trace' | 'debug' | 'info' | 'audit' | 'warn' | 'error' | 'fatal';

/** Ordinal severity, lowest first — the one place this order is encoded (§5). */
export const LOG_LEVEL_ORDER: readonly LogLevel[] = [
  'trace',
  'debug',
  'info',
  'audit',
  'warn',
  'error',
  'fatal',
];

export const isLogLevel = (value: unknown): value is LogLevel =>
  typeof value === 'string' &&
  (LOG_LEVEL_ORDER as readonly string[]).includes(value);

// ─────────────────────────────────────────────────────────────────────────────
// §6 — Public Logger Interface
// ─────────────────────────────────────────────────────────────────────────────
export type LogMetadata = Record<string, unknown>;
export type LogMetadataInput = LogMetadata | (() => LogMetadata);

export interface ILogger {
  trace(message: string, metadata?: LogMetadataInput): void;
  debug(message: string, metadata?: LogMetadataInput): void;
  info(message: string, metadata?: LogMetadataInput): void;
  audit(message: string, metadata?: LogMetadataInput): void;
  warn(message: string, metadata?: LogMetadataInput): void;
  error(message: string, error?: unknown, metadata?: LogMetadataInput): void;
  fatal(message: string, error?: unknown, metadata?: LogMetadataInput): void;
  /** §7. Returns a NEW logger; never mutates the one it was called on. */
  child(context: LoggerContext): ILogger;
}

/**
 * The runtime-management surface — deliberately separate from ILogger, which
 * application code depends on (§6). Only the hot-reload subscriber (§5) and the
 * Health/Metrics pull methods (§25, §26) need this.
 */
export interface LoggerRuntime {
  setLevel(level: LogLevel): void;
  getHealth(): LoggerHealth;
  getMetricsSnapshot(): LoggerMetricsSnapshot;
}

/** §7 — static, call-site-known child-logger bindings. Never ALS-based. */
export interface LoggerContext {
  module?: string;
  operation?: string;
  entityType?: string;
  entityId?: string;
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// §8 — LogContext (Logger's own request-scoped enrichment, ALS-backed)
// ─────────────────────────────────────────────────────────────────────────────
export interface LogContext {
  userId?: string;
  method?: string;
  url?: string;
  userAgent?: string;
  ip?: string;
  /** Set once, at entry; used to compute durationMs at completion (§30). Never
   *  itself included as a raw field in output — only the derived duration is. */
  startTime?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// §13 — Error serialization
// ─────────────────────────────────────────────────────────────────────────────
export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  cause?: SerializedError;
  /** Present (true) only on the deepest entry once MAX_DEPTH (§13, §14) is hit — never a bare `false`. */
  causeTruncated?: true;
}

// ─────────────────────────────────────────────────────────────────────────────
// §11 — the final structured entry a transport receives
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Present fields only — an absent field is omitted entirely from a transport's
 * write(), never emitted as `null`/`"undefined"` (§11). `[key: string]: unknown`
 * covers caller-supplied metadata merged in after the named fields.
 */
export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  service?: string;
  environment?: string;
  instanceId?: string;
  module?: string;
  operation?: string;
  entityType?: string;
  entityId?: string;
  correlationId?: string;
  causationId?: string;
  traceId?: string;
  spanId?: string;
  userId?: string;
  durationMs?: number;
  error?: SerializedError;
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// §25 — Health
// ─────────────────────────────────────────────────────────────────────────────
export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface LoggerHealth {
  status: HealthStatus;
  transports: Array<{
    name: string;
    healthy: boolean;
    critical: boolean;
    message?: string;
  }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// §26 — Metrics
// ─────────────────────────────────────────────────────────────────────────────
export type LogDropReason =
  | 'buffer_overflow'
  | 'sampled'
  | 'oversized_metadata'
  /** `write()` itself failed (a throwing getter / lazy callback / exotic value) — a degraded
   *  fallback line is emitted instead; this counts the incident. */
  | 'internal_error'
  /** Arrived after (or was still buffered when) the transport began shutting down. */
  | 'transport_closed';

export interface LoggerMetricsSnapshot {
  logsTotal: number;
  logsByLevel: Record<LogLevel, number>;
  logsDroppedTotal: number;
  logsDroppedByReason: Array<{
    reason: LogDropReason;
    level: LogLevel;
    transport: string;
    count: number;
  }>;
  transportErrorsTotal: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Module options
// ─────────────────────────────────────────────────────────────────────────────
export interface LoggerModuleOptions {
  /** Additional transports beyond the mandatory Console transport (§18, §42). */
  transports?: LoggerExtraTransport[];
  /** Graceful-shutdown timeout in ms (§34). */
  shutdownTimeoutMs?: number;
}

/** Forward-declared here (rather than in transports/transport.interface.ts) so this
 *  file has no import from transports/ — transports/transport.interface.ts re-exports
 *  the identical shape as `LogTransport`, the name application code actually uses. */
export interface LoggerExtraTransport {
  readonly name: string;
  write(entry: LogEntry): Promise<void> | void;
  health(): { healthy: boolean; message?: string };
  close(): Promise<void>;
  /** §25's critical/non-critical distinction for THIS transport — defaults to
   *  false (a project adding, say, an HTTP transport is not thereby declaring
   *  the whole app unhealthy if that one endpoint is down; only Console is
   *  hard-wired critical, in logger.module.ts). */
  readonly critical?: boolean;
}

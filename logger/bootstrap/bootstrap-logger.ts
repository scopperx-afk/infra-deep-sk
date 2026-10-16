/**
 * BootstrapLogger — Logger spec §28. Usable in `main.ts` before Nest's DI graph
 * (and therefore Config, and the real `LoggerService`) exists — e.g. to report
 * "Config validation failed" itself. Swapped for the real `LoggerService` once
 * the application context is up (§28's own module-structure note).
 *
 * Deliberately minimal: no Config-driven settings (there IS no Config yet), no
 * transports beyond Console, no sampling, no backpressure, no hot-reload — just
 * enough of the same pipeline (redaction, error serialization, the real
 * pino-backed Console transport) to produce a correctly shaped, safe `LogEntry`,
 * because a startup failure is exactly the moment a secret-laden config error
 * or a raw stack trace is most likely to be logged (§28).
 */
import type { ILogger, LoggerContext, LogMetadataInput } from '../logger.port';
import { LOG_LEVEL_ORDER, type LogLevel } from '../logger.port';
import { getTraceContext } from '../../tracing';
import { buildLogEntry } from '../serialization/entry-builder';
import { LogRedactor } from '../redaction/log-redactor';
import {
  ConsoleTransport,
  type ConsoleMode,
} from '../transports/console/console.transport';
import { DEFAULT_METADATA_SIZE_LIMIT_BYTES } from '../logger.constants';
import { nowIso } from '../util/clock';

const LEVEL_INDEX: Record<LogLevel, number> = Object.fromEntries(
  LOG_LEVEL_ORDER.map((l, i) => [l, i]),
) as Record<LogLevel, number>;

export interface BootstrapLoggerOptions {
  /** Defaults from `NODE_ENV` directly (Config doesn't exist yet to ask) — `production`/`staging`
   *  get JSON, anything else gets pretty, mirroring `logging.format`'s own eventual default (§19). */
  mode?: ConsoleMode;
  /** Defaults to `'info'` — Config's own `logging.level` default (§13.11) — since there is no
   *  Config yet to read it from during this phase. */
  minLevel?: LogLevel;
}

function defaultMode(): ConsoleMode {
  const env = process.env.NODE_ENV;
  return env === 'production' || env === 'staging' ? 'json' : 'pretty';
}

export class BootstrapLogger implements ILogger {
  private readonly transport: ConsoleTransport;
  private readonly redactor = new LogRedactor();
  private readonly minLevel: LogLevel;
  private readonly staticContext: LoggerContext;

  constructor(
    options: BootstrapLoggerOptions = {},
    staticContext: LoggerContext = {},
    /** Shares an existing transport when created via child() — never opens a second stream writer. */
    existingTransport?: ConsoleTransport,
  ) {
    this.transport =
      existingTransport ??
      new ConsoleTransport({ mode: options.mode ?? defaultMode() });
    this.minLevel = options.minLevel ?? 'info';
    this.staticContext = staticContext;
  }

  trace(message: string, metadata?: LogMetadataInput): void {
    this.write('trace', message, metadata);
  }
  debug(message: string, metadata?: LogMetadataInput): void {
    this.write('debug', message, metadata);
  }
  info(message: string, metadata?: LogMetadataInput): void {
    this.write('info', message, metadata);
  }
  audit(message: string, metadata?: LogMetadataInput): void {
    this.write('audit', message, metadata);
  }
  warn(message: string, metadata?: LogMetadataInput): void {
    this.write('warn', message, metadata);
  }
  error(message: string, error?: unknown, metadata?: LogMetadataInput): void {
    this.write('error', message, metadata, error);
  }
  fatal(message: string, error?: unknown, metadata?: LogMetadataInput): void {
    this.write('fatal', message, metadata, error);
  }

  child(context: LoggerContext): ILogger {
    return new BootstrapLogger(
      { minLevel: this.minLevel },
      { ...this.staticContext, ...context },
      this.transport,
    );
  }

  private write(
    level: LogLevel,
    message: string,
    metadataInput: LogMetadataInput | undefined,
    rawError?: unknown,
  ): void {
    if (LEVEL_INDEX[level] < LEVEL_INDEX[this.minLevel]) return;
    const metadata =
      typeof metadataInput === 'function' ? metadataInput() : metadataInput;
    const entry = buildLogEntry({
      level,
      message,
      staticContext: this.staticContext,
      identity: {},
      trace: getTraceContext(),
      logContext: undefined,
      metadata,
      rawError,
      redactor: this.redactor,
      limit: {
        sizeLimitBytes: DEFAULT_METADATA_SIZE_LIMIT_BYTES,
        sizeLimitPolicy: 'truncate',
      },
      now: nowIso,
    });
    this.transport.write(entry);
  }
}

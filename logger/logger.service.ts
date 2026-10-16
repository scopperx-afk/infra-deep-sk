/**
 * ILogger + LoggerRuntime implementation — Logger spec §6, §7, §25, §26, §29.
 *
 * One class implements BOTH ports (mirrors TracingServiceImpl implementing the
 * whole TracingService port in one class): `LOGGER_SERVICE` and `LOGGER_RUNTIME`
 * resolve to the SAME singleton, typed differently at each injection site (§37).
 * `child()` (§7) returns a NEW instance that shares every collaborator by
 * reference — including `levelHolder` (see below) — except `staticContext`,
 * which is the one thing that's genuinely per-instance.
 *
 * ── Why `level` lives in a shared, mutable holder object, not a plain field ──
 * §5/§38 require `logging.level` hot-reload to change emitted output FOR EVERY
 * LOGGER INSTANCE ALREADY CREATED, not just new ones — a service class typically
 * injects one child logger once, in its constructor, and keeps it for the
 * process's lifetime. If `level` were copied into each child at construction
 * time, a later `setLevel()` call on the root would never reach any
 * already-existing child. Every instance in one child-logger tree therefore
 * shares ONE `{ current: LogLevel }` object by reference; `setLevel()` mutates
 * it in place, and this satisfied Config's own "effectiveness over mechanism"
 * standard: §38 explicitly test this consequence, not just that `onChange` fired.
 */
import type {
  ILogger,
  LogEntry,
  LogLevel,
  LogMetadataInput,
  LoggerContext,
  LoggerHealth,
  LoggerMetricsSnapshot,
  LoggerRuntime,
} from './logger.port';
import { LOG_LEVEL_ORDER } from './logger.port';
import { getLogContext } from './context/log-context.store';
import {
  buildLogEntry,
  type MetadataLimit,
  type ServiceIdentity,
} from './serialization/entry-builder';
import type { LogRedactor } from './redaction/log-redactor';
import type { LogSampler } from './sampling/log-sampler';
import {
  computeLoggerHealth,
  type LoggerObservation,
} from './observation/logger.observation';
import type { TransportDispatcher } from './transports/transport-dispatcher';
import { nowIso } from './util/clock';

export interface LevelHolder {
  current: LogLevel;
}

/** Injected rather than imported directly, so this file has no hard dependency on
 *  the Tracing module's own import path — see logger.module.ts for the real wiring. */
export type TraceReader = () =>
  | {
      correlationId: string;
      causationId?: string;
      traceId?: string;
      spanId?: string;
    }
  | undefined;

export interface LoggerServiceDeps {
  dispatchers: TransportDispatcher[];
  identity: ServiceIdentity;
  redactor: LogRedactor;
  sampler: LogSampler;
  limit: MetadataLimit;
  observation: LoggerObservation;
  levelHolder: LevelHolder;
  getTraceContext: TraceReader;
  staticContext?: LoggerContext;
}

const LEVEL_INDEX: Record<LogLevel, number> = Object.fromEntries(
  LOG_LEVEL_ORDER.map((l, i) => [l, i]),
) as Record<LogLevel, number>;

export class LoggerServiceImpl implements ILogger, LoggerRuntime {
  private readonly dispatchers: TransportDispatcher[];
  private readonly identity: ServiceIdentity;
  private readonly redactor: LogRedactor;
  private readonly sampler: LogSampler;
  private readonly limit: MetadataLimit;
  private readonly observation: LoggerObservation;
  private readonly levelHolder: LevelHolder;
  private readonly getTraceContext: TraceReader;
  private readonly staticContext: LoggerContext;

  constructor(deps: LoggerServiceDeps) {
    this.dispatchers = deps.dispatchers;
    this.identity = deps.identity;
    this.redactor = deps.redactor;
    this.sampler = deps.sampler;
    this.limit = deps.limit;
    this.observation = deps.observation;
    this.levelHolder = deps.levelHolder;
    this.getTraceContext = deps.getTraceContext;
    this.staticContext = deps.staticContext ?? {};
  }

  // ── ILogger (§6) ──────────────────────────────────────────────────────────
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
    return new LoggerServiceImpl({
      dispatchers: this.dispatchers,
      identity: this.identity,
      redactor: this.redactor,
      sampler: this.sampler,
      limit: this.limit,
      observation: this.observation,
      levelHolder: this.levelHolder, // shared reference — see file header
      getTraceContext: this.getTraceContext,
      staticContext: { ...this.staticContext, ...context },
    });
  }

  // ── LoggerRuntime (§25, §26, §5) ─────────────────────────────────────────
  setLevel(level: LogLevel): void {
    this.levelHolder.current = level;
  }
  getHealth(): LoggerHealth {
    return computeLoggerHealth(this.dispatchers);
  }
  getMetricsSnapshot(): LoggerMetricsSnapshot {
    return this.observation.getMetricsSnapshot();
  }

  // ── internals ────────────────────────────────────────────────────────────
  private isEnabled(level: LogLevel): boolean {
    // AUDIT sits between INFO and WARN in the severity order, so a plain threshold comparison
    // silently DISABLES the audit trail whenever the level is raised to warn/error (a very
    // common production setting). An audit record is a compliance artifact, not a diagnostic:
    // like the sampler (§16), the level threshold must never be able to switch it off.
    if (level === 'audit') return true;
    return LEVEL_INDEX[level] >= LEVEL_INDEX[this.levelHolder.current];
  }

  /**
   * A logging call must NEVER throw into business code. Transport failures were already
   * isolated (§23), but everything BEFORE dispatch — a lazy metadata callback, a throwing
   * getter, an exotic object, a hostile Proxy — ran unguarded, so `logger.info('x', obj)`
   * could abort a request. On failure a degraded line (message + correlation, no metadata)
   * is emitted instead and the incident is counted as an `internal_error` drop.
   */
  private write(
    level: LogLevel,
    message: string,
    metadataInput: LogMetadataInput | undefined,
    rawError?: unknown,
  ): void {
    try {
      this.writeUnsafe(level, message, metadataInput, rawError);
    } catch (err) {
      this.emitDegraded(level, message, err);
    }
  }

  private emitDegraded(level: LogLevel, message: unknown, cause: unknown): void {
    try {
      this.observation.recordDrop({ reason: 'internal_error', level, transport: '*' });
      let text = typeof message === 'string' ? message : '[non-string message]';
      let reason = cause instanceof Error ? cause.message : String(cause);
      try {
        text = this.redactor.redactText(text.slice(0, 2000));
        reason = this.redactor.redactText(reason.slice(0, 500));
      } catch {
        /* keep the raw (already length-capped) text */
      }
      const trace = this.getTraceContext();
      const entry: LogEntry = {
        timestamp: nowIso(),
        level,
        message: text,
        ...(this.identity.service !== undefined ? { service: this.identity.service } : {}),
        ...(this.identity.environment !== undefined ? { environment: this.identity.environment } : {}),
        ...(this.identity.instanceId !== undefined ? { instanceId: this.identity.instanceId } : {}),
        ...(trace?.correlationId !== undefined ? { correlationId: trace.correlationId } : {}),
        logBuildError: reason,
      };
      for (const dispatcher of this.dispatchers) dispatcher.dispatch(level, entry);
    } catch {
      /* the logger itself is the last thing allowed to take the process down */
    }
  }

  private writeUnsafe(
    level: LogLevel,
    message: string,
    metadataInput: LogMetadataInput | undefined,
    rawError?: unknown,
  ): void {
    if (!this.isEnabled(level)) return; // §35 — cheap: one array-index comparison, no allocation
    if (!this.sampler.shouldSample(level, metadataInput)) {
      this.observation.recordDrop({ reason: 'sampled', level, transport: '*' });
      return;
    }
    // §10 — evaluated only now: level enabled AND sampling survived.
    const metadata =
      typeof metadataInput === 'function' ? metadataInput() : metadataInput;

    this.observation.recordLog(level);
    const entry = buildLogEntry({
      level,
      message,
      staticContext: this.staticContext,
      identity: this.identity,
      trace: this.getTraceContext(),
      logContext: getLogContext(),
      metadata,
      rawError,
      redactor: this.redactor,
      limit: this.limit,
      now: nowIso,
      onMetadataOversized: (lvl) =>
        this.observation.recordDrop({
          reason: 'oversized_metadata',
          level: lvl,
          transport: '*',
        }),
    });
    for (const dispatcher of this.dispatchers)
      dispatcher.dispatch(level, entry);
  }

  // ── NestJS LoggerService compatibility (§29) — used only via app.useLogger() ─
  /** `log` → `info`, per §29's mapping table. */
  log(message: unknown, ...optionalParams: unknown[]): void {
    const { context, rest } = splitNestParams(optionalParams);
    this.info(nestMessage(message), nestMetadata(context, rest));
  }
  /** `verbose` → `trace`, per §29's mapping table. */
  verbose(message: unknown, ...optionalParams: unknown[]): void {
    const { context, rest } = splitNestParams(optionalParams);
    this.trace(nestMessage(message), nestMetadata(context, rest));
  }
  nestDebug(message: unknown, ...optionalParams: unknown[]): void {
    const { context, rest } = splitNestParams(optionalParams);
    this.debug(nestMessage(message), nestMetadata(context, rest));
  }
  nestWarn(message: unknown, ...optionalParams: unknown[]): void {
    const { context, rest } = splitNestParams(optionalParams);
    this.warn(nestMessage(message), nestMetadata(context, rest));
  }
  nestFatal(message: unknown, ...optionalParams: unknown[]): void {
    const { context, rest } = splitNestParams(optionalParams);
    this.fatal(nestMessage(message), undefined, nestMetadata(context, rest));
  }
  /** Nest's own `(message, stack?, context?)` / `(message, context?)` ambiguity (§29) —
   *  see `splitNestErrorParams` for the exact heuristic and its documented limits. */
  nestError(message: unknown, ...optionalParams: unknown[]): void {
    const { context, stack, rest } = splitNestErrorParams(optionalParams);
    const err = stack ? new StackOnlyError(stack) : undefined;
    this.error(nestMessage(message), err, nestMetadata(context, rest));
  }
}

/** Nest hands over `unknown` messages: objects used to print as "[object Object]" and an
 *  `Error` lost its message. Strings pass through; everything else is rendered compactly. */
function nestMessage(message: unknown): string {
  if (typeof message === 'string') return message;
  if (message instanceof Error) return message.message;
  if (typeof message === 'object' && message !== null) {
    try {
      return JSON.stringify(message).slice(0, 2000);
    } catch {
      /* fall through */
    }
  }
  return String(message);
}

/** A synthetic Error whose `.stack` IS the string Nest handed us — so the normal
 *  error-serialization path (§13) still produces a `{name,message,stack}` shape
 *  instead of a bespoke one just for this call site. */
class StackOnlyError extends Error {
  constructor(stack: string) {
    super(firstLine(stack));
    this.name = 'NestError';
    this.stack = stack;
  }
}
const firstLine = (s: string): string => s.split('\n')[0] ?? s;

/** Nest convention: the LAST string argument, when present, is a "context" (typically
 *  a class/module name) — everything else is passed through as opaque extra args. */
function splitNestParams(optionalParams: unknown[]): {
  context?: string;
  rest: unknown[];
} {
  if (optionalParams.length === 0) return { rest: [] };
  const last = optionalParams[optionalParams.length - 1];
  if (typeof last === 'string')
    return { context: last, rest: optionalParams.slice(0, -1) };
  return { rest: optionalParams };
}

/**
 * §29's specific ambiguity: Nest's `Logger.error()` is called as either
 * `(message, context?)` or `(message, stack?, context?)`, and callers don't
 * declare which. Heuristic: with 2+ params, the first is treated as a stack
 * trace only if it "looks like" one (contains a newline or a `"    at "` frame
 * marker); a single trailing string is always `context`, never a stack, since a
 * real stack trace is never just one bare line. This does not claim to be
 * perfect — no purely structural rule can be, given Nest imposes no type
 * distinction here — but it fails toward the safe side: a misclassified
 * "context" still becomes visible metadata (in `nestContext`), never dropped.
 */
function splitNestErrorParams(optionalParams: unknown[]): {
  context?: string;
  stack?: string;
  rest: unknown[];
} {
  if (optionalParams.length === 0) return { rest: [] };
  const [first, ...others] = optionalParams;
  if (typeof first === 'string' && looksLikeStack(first)) {
    const { context, rest } = splitNestParams(others);
    return { stack: first, context, rest };
  }
  const { context, rest } = splitNestParams(optionalParams);
  return { context, rest };
}
const looksLikeStack = (s: string): boolean =>
  s.includes('\n') || /\bat\s+\S+/.test(s);

function nestMetadata(
  context: string | undefined,
  rest: unknown[],
): Record<string, unknown> | undefined {
  if (context === undefined && rest.length === 0) return undefined;
  const out: Record<string, unknown> = {};
  if (context !== undefined) out.nestContext = context;
  if (rest.length > 0) out.nestArgs = rest;
  return out;
}

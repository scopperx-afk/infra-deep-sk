/**
 * Sentry transport — Logger spec §24 (deferred in the original implementation;
 * built out here per §42's own "one at a time" plan — see SPEC-ERRATA.md
 * E-L10). NEVER critical (§25's table only hard-wires Console) — Sentry being
 * unreachable, misconfigured, or simply not installed must degrade, never
 * take the app down. `create()` below is therefore an async FACTORY that
 * never throws, not a constructor: `@sentry/node`'s `import()` and
 * `Sentry.init()` both happen inside it, wrapped in one try/catch, and any
 * failure just means "this transport doesn't get registered" back in
 * logger.module.ts, never a boot-time crash over an optional collaborator.
 *
 * The SDK is imported lazily (`await import('@sentry/node')`, never a static
 * top-level import) for the same reason: a project that never sets
 * `logging.sentry.enabled=true` never pays for loading it, and doesn't need
 * the package installed at all to boot.
 *
 * Scope, deliberately narrow:
 *  - ERROR/FATAL become a real Sentry event: `captureException()` when this
 *    module's own `SerializedError` (§13) is reconstructed into a real `Error`
 *    first (so Sentry gets an actual stack, not a flattened string),
 *    `captureMessage()` when `.error()/.fatal()` was called with no `error`
 *    argument at all.
 *  - Every OTHER level becomes a Sentry BREADCRUMB, not its own event — the
 *    trail leading up to a failure is exactly what a breadcrumb is for, and
 *    turning every `logger.debug()` into a separate Sentry issue would make
 *    Sentry's own event quota the next incident.
 *  - `correlationId`/`causationId`/`traceId`/`spanId` (already on `LogEntry`,
 *    §11) are attached as tags, and `userId` as Sentry's own user context, on
 *    every event — so a Sentry issue and this app's own structured logs for
 *    the same request can be cross-referenced by `correlationId` without
 *    wiring Sentry's separate tracing integration in here at all.
 */
import type { LogEntry, LogLevel } from '../../logger.port';
import type { LogTransport, TransportHealth } from '../transport.interface';

export interface SentryTransportOptions {
  dsn: string;
  environment: string;
  tracesSampleRate: number;
}

// The exact surface used below — kept narrow and structural rather than
// `typeof import('@sentry/node')` so this file still type-checks in a project
// that hasn't installed `@sentry/node` as a dependency at all (it's optional —
// only required when `logging.sentry.enabled=true`).
interface SentryScope {
  setLevel(level: string): void;
  setTag(key: string, value: string): void;
  setUser(user: { id: string }): void;
}
interface SentryIntegration {
  name: string;
}
interface SentryInitOptions {
  dsn: string;
  environment: string;
  tracesSampleRate: number;
  sendDefaultPii: boolean;
  skipOpenTelemetrySetup: boolean;
  integrations: (defaults: SentryIntegration[]) => SentryIntegration[];
}
interface SentrySdk {
  init(options: SentryInitOptions): void;
  withScope(fn: (scope: SentryScope) => void): void;
  captureException(err: unknown): void;
  captureMessage(message: string, level: string): void;
  addBreadcrumb(breadcrumb: {
    message: string;
    level: string;
    category: string;
    data: Record<string, string>;
  }): void;
  close(timeoutMs: number): Promise<boolean>;
}

const ERROR_LEVELS: ReadonlySet<LogLevel> = new Set(['error', 'fatal']);

/** Default integrations that duplicate something the application already owns. */
const SENTRY_INTEGRATIONS_TO_DROP: ReadonlySet<string> = new Set([
  'OnUncaughtException', // process lifecycle belongs to main.ts
  'OnUnhandledRejection',
  'Http', // tracing/instrumentation belongs to the OpenTelemetry SDK
  'NodeFetch',
  'Console', // would mirror every console.* line into breadcrumbs
  'LocalVariablesAsync', // captures local variable VALUES on exceptions — a secrets/PII risk
  'LocalVariables',
]);

/** Sentry's own severity vocabulary (`debug|info|warning|error|fatal`) — mapped
 *  from this module's 7 levels; AUDIT has no Sentry equivalent, so it is
 *  treated as `info`, the same tier §22's backpressure buffer already puts
 *  it adjacent to (see priority-buffer.ts's own AUDIT note, E-L4). */
const SENTRY_LEVEL: Record<LogLevel, string> = {
  trace: 'debug',
  debug: 'debug',
  info: 'info',
  audit: 'info',
  warn: 'warning',
  error: 'error',
  fatal: 'fatal',
};

export class SentryTransport implements LogTransport {
  readonly name = 'sentry';
  private lastError: string | undefined;

  private constructor(private readonly sentry: SentrySdk) {}

  /**
   * Never throws — see file header. Returns `undefined` if `@sentry/node`
   * isn't installed, or if `init()` itself fails; the caller
   * (logger.module.ts) simply doesn't register this transport in that case.
   *
   * `onFailure`, added after review: `create()` failing and staying silent
   * about it means an operator who thinks Sentry is capturing errors has no
   * signal that it actually isn't (a bad DSN, the package never installed, a
   * network that can't reach Sentry at boot) — degrading silently is right
   * for §25's health model (this transport is never critical), but silence
   * all the way to "nobody finds out" is not the same thing. The caller
   * decides how to surface it — logger.module.ts uses `emergencyLog()`
   * (emergency-logger.ts), the one reporting path guaranteed to work even
   * this early in bootstrap, before `LOGGER_SERVICE` itself necessarily
   * exists yet.
   */
  static async create(
    options: SentryTransportOptions,
    onFailure?: (err: unknown) => void,
    /** Injectable so the transport can be tested without the real SDK (it had no tests). */
    loadSdk: () => Promise<unknown> = () => import('@sentry/node'),
  ): Promise<SentryTransport | undefined> {
    try {
      // optional peer dependency (see file header); the structural `SentrySdk` type above is
      // this file's own contract for what it actually calls, not `@sentry/node`'s full API.
      const sentry = (await loadSdk()) as SentrySdk;
      sentry.init({
        dsn: options.dsn,
        environment: options.environment,
        tracesSampleRate: options.tracesSampleRate,
        // This transport is an ERROR SINK, not an APM / process supervisor. A bare `init()`
        // also (verified on @sentry/node 11): installs its own uncaughtException /
        // unhandledRejection listeners, instruments http + fetch a SECOND time on top of the
        // app's OpenTelemetry SDK (duplicate spans), mirrors every console.* call as a breadcrumb
        // and ships request/PII context by default. Be explicit instead of inheriting that.
        sendDefaultPii: false,
        skipOpenTelemetrySetup: true,
        integrations: (defaults) =>
          defaults.filter((i) => !SENTRY_INTEGRATIONS_TO_DROP.has(i.name)),
      });
      return new SentryTransport(sentry);
    } catch (err) {
      onFailure?.(err);
      return undefined;
    }
  }

  write(entry: LogEntry): void {
    try {
      if (ERROR_LEVELS.has(entry.level)) {
        this.captureEvent(entry);
      } else {
        this.sentry.addBreadcrumb({
          message: entry.message,
          level: SENTRY_LEVEL[entry.level],
          category: typeof entry.module === 'string' ? entry.module : 'log',
          data: this.contextTags(entry),
        });
      }
      this.lastError = undefined;
    } catch (err) {
      // Isolated here, exactly like every other transport — see transport-dispatcher.ts (§23).
      this.lastError = (err as Error).message;
    }
  }

  private captureEvent(entry: LogEntry): void {
    this.sentry.withScope((scope) => {
      scope.setLevel(SENTRY_LEVEL[entry.level]);
      for (const [key, value] of Object.entries(this.contextTags(entry)))
        scope.setTag(key, value);
      if (entry.userId) scope.setUser({ id: entry.userId });

      const serialized = entry.error;
      if (serialized) {
        // Reconstruct a real Error so Sentry gets an actual stack, rather than just
        // the flattened `{name,message,stack}` shape §13 produces for storage/transport.
        const reconstructed = new Error(serialized.message);
        reconstructed.name = serialized.name;
        if (serialized.stack) reconstructed.stack = serialized.stack;
        this.sentry.captureException(reconstructed);
      } else {
        this.sentry.captureMessage(entry.message, SENTRY_LEVEL[entry.level]);
      }
    });
  }

  private contextTags(entry: LogEntry): Record<string, string> {
    const out: Record<string, string> = {};
    if (entry.correlationId) out.correlationId = entry.correlationId;
    if (entry.causationId) out.causationId = entry.causationId;
    if (entry.traceId) out.traceId = entry.traceId;
    if (entry.spanId) out.spanId = entry.spanId;
    return out;
  }

  health(): TransportHealth {
    return this.lastError === undefined
      ? { healthy: true }
      : { healthy: false, message: this.lastError };
  }

  async close(): Promise<void> {
    try {
      // §34 — best-effort final flush within Sentry's own send queue; 2s is a fixed,
      // small slice of whatever budget TransportDispatcher.close() already enforces
      // around this call (transport-dispatcher.ts's own `withTimeout` wraps it again).
      await this.sentry.close(2000);
    } catch {
      /* isolated — a failed final flush must never block shutdown (§23, §34) */
    }
  }
}

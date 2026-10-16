/**
 * connectWithRetry() — Database spec §8, Redis spec §7, Storage spec §11.2, Queue/Events.
 *
 * Bounded, jittered BOOT-TIME connection retry, shared by every module that owns a
 * connection. A deliberate, narrow exception to Config's own "fail fast" philosophy:
 * container orchestration routinely starts the app before the datastore accepts
 * connections — a transient condition that resolves itself within seconds. After the
 * budget is spent the ORIGINAL error is rethrown and application boot fails loudly.
 *
 * ── Differences from the specs' first sketch (database/SPEC-ERRATA.md D-1) ────────────────
 *  1. JITTER via the shared `computeBackoff` — a fleet that boots at once (rolling deploy,
 *     node restart) must not retry in lock-step against a recovering database.
 *  2. `isRetryable` — retrying a WRONG PASSWORD five times is useless and can trip
 *     account lock-out / fail2ban; a permanent failure aborts on the first attempt.
 *  3. Generic `connect(signal)` callback instead of `$connect?()/connect?()` duck-typing, so
 *     one function serves Prisma, pg, the Mongo driver, ioredis and the S3 client.
 *  4. PER-ATTEMPT TIMEOUT (default 10 s). Without it a `connect()` that never settles
 *     (a firewall silently dropping SYNs; `pg` has no default connect timeout) freezes boot
 *     forever, because the loop only advances when an attempt SETTLES — the exact failure
 *     mode "every external call needs a timeout" exists to prevent.
 *  5. OPTIONAL OVERALL DEADLINE — bounds the whole sequence (an orchestrator's startup
 *     probe has its own deadline); mirrors Resilience spec §6's `overallDeadlineMs`.
 *  6. CANCELLATION — an external `AbortSignal` (SIGTERM during boot) stops the loop at once,
 *     including mid-sleep, and every attempt receives its own `AbortSignal`.
 *  7. Options are VALIDATED up front. `maxAttempts: NaN` previously made the loop infinite
 *     (`attempt >= NaN` is never true); invalid configuration now throws a `RangeError`.
 *  8. Errors are logged through `describeConnectError()` — name/code/message only, credentials
 *     in connection strings masked, control characters stripped, length bounded.
 *
 * Contract the spec tests pin (kept exactly): success logs `logger.info('<name> connected',
 * { attempt })`; exhaustion logs one `fatal` and rethrows the last error unchanged.
 *
 * ⚠ What `connect` must guarantee: it is called again after a failed or timed-out attempt on
 * the SAME client, so it must be safe to re-invoke (Prisma `$connect`, an ioredis client with
 * `lazyConnect: true`, a fresh `MongoClient.connect()`), and it should honour `signal` to
 * release a half-open socket — an attempt abandoned after its timeout is not forcibly killed,
 * only ignored (its late rejection is swallowed so it cannot crash the process).
 */
import type { ILogger } from '../logger';
import { computeBackoff } from './computeBackoff';

export interface ConnectRetryOptions {
  /** Total attempts including the first. Integer ≥ 1. */
  readonly maxAttempts: number;
  /** Delay before the first retry, milliseconds. */
  readonly initialDelayMs: number;
  /** Ceiling of the exponential curve (before jitter), milliseconds. Must be ≥ `initialDelayMs`. */
  readonly maxDelayMs: number;
  /** Default 0.2 (±20 %). Within [0, 1]. */
  readonly jitterRatio?: number;
  /** Upper bound for ONE attempt. Default 10 000 ms. */
  readonly attemptTimeoutMs?: number;
  /** Upper bound for the WHOLE sequence, attempts and waits included. Default: none. */
  readonly overallDeadlineMs?: number;
}

export type RetryLogger = Pick<ILogger, 'info' | 'warn' | 'fatal'>;

export interface ConnectWithRetryParams {
  /** Used in log lines only — `'database'`, `'mongo'`, `'redis'`, `'redis-subscriber'`, `'storage'`… */
  readonly name: string;
  /** One connection attempt. Must be safe to call again; should honour `signal`. */
  readonly connect: (signal: AbortSignal) => Promise<void>;
  readonly retry: ConnectRetryOptions;
  readonly logger: RetryLogger;
  /** Return `false` for a PERMANENT failure (bad credentials, unknown database…). Default: retry everything. */
  readonly isRetryable?: (err: unknown) => boolean;
  /** Aborts the whole sequence (e.g. process shutdown while booting). */
  readonly signal?: AbortSignal;
  /** Injectable for tests. Receives the sequence's signal so a real sleep can be interrupted. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable jitter source; see `computeBackoff`. */
  readonly random?: () => number;
  /** Injectable clock (epoch ms) for the overall deadline and `elapsedMs`. */
  readonly now?: () => number;
}

export interface ConnectResult {
  /** The attempt number that succeeded (1-based). */
  readonly attempts: number;
  readonly elapsedMs: number;
}

export const DEFAULT_ATTEMPT_TIMEOUT_MS = 10_000;
export const DEFAULT_JITTER_RATIO = 0.2;

/** One attempt exceeded `attemptTimeoutMs`. Retryable by default; `connect` receives an abort for it. */
export class ConnectAttemptTimeoutError extends Error {
  constructor(readonly attemptTimeoutMs: number) {
    super(`connection attempt timed out after ${attemptTimeoutMs}ms`);
    this.name = 'ConnectAttemptTimeoutError';
  }
}

/** The sequence was cancelled through `params.signal`. Never retried. */
export class ConnectAbortedError extends Error {
  constructor(name: string, options?: { cause?: unknown }) {
    super(`${name} connection was aborted`, options);
    this.name = 'ConnectAbortedError';
  }
}

// ── error description (safe for logs) ────────────────────────────────────────────────────────
const MAX_ERROR_MESSAGE_CHARS = 300;
/** `scheme://user:password@host` → `scheme://***@host` (any scheme: postgres, mongodb+srv, redis, amqp, https…). */
const URL_CREDENTIALS_RE = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi;
/** `password=…`, `pwd=…`, `secret=…`, `token=…`, `apikey=…` in ADO/JDBC/query-style strings. */
/** Matches `password=…` AND `my_password=…` / `access_token=…` — the key may have any
 *  prefix/suffix of word characters. `\b` was too strict: a key like `db_password` or
 *  `access_token` in a connection string or JDBC URL is just as sensitive as a bare
 *  `password`, and `\b` before the alternation never matched inside a longer identifier. */
const KEY_VALUE_SECRET_RE = /([A-Za-z0-9_]*(?:password|passwd|pwd|pass|secret|token|apikey|api_key|accesskey|access_key)[A-Za-z0-9_]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s;&,]+)/gi;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g;

export function describeConnectError(err: unknown): { errorName: string; errorMessage: string; errorCode?: string | number } {
  const base = err instanceof Error ? err : undefined;
  const rawMessage = base ? base.message : typeof err === 'string' ? err : '';
  const errorMessage = rawMessage
    .replace(URL_CREDENTIALS_RE, '$1***@')
    .replace(KEY_VALUE_SECRET_RE, '$1$2***')
    .replace(CONTROL_CHARS_RE, ' ')
    .trim()
    .slice(0, MAX_ERROR_MESSAGE_CHARS);
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return {
    errorName: base ? base.name : typeof err,
    errorMessage,
    ...(typeof code === 'string' || typeof code === 'number' ? { errorCode: code } : {}),
  };
}

// ── validation ───────────────────────────────────────────────────────────────────────────────
function assertValid(name: string, retry: ConnectRetryOptions): void {
  if (typeof name !== 'string' || name === '') throw new RangeError('connectWithRetry(): name must be a non-empty string');
  if (!Number.isInteger(retry.maxAttempts) || retry.maxAttempts < 1) {
    throw new RangeError(`connectWithRetry(${name}): maxAttempts must be an integer >= 1 (got ${String(retry.maxAttempts)})`);
  }
  if (!Number.isFinite(retry.initialDelayMs) || retry.initialDelayMs < 0) {
    throw new RangeError(`connectWithRetry(${name}): initialDelayMs must be a finite number >= 0`);
  }
  if (!Number.isFinite(retry.maxDelayMs) || retry.maxDelayMs < retry.initialDelayMs) {
    throw new RangeError(`connectWithRetry(${name}): maxDelayMs must be a finite number >= initialDelayMs`);
  }
  if (retry.jitterRatio !== undefined && (!Number.isFinite(retry.jitterRatio) || retry.jitterRatio < 0 || retry.jitterRatio > 1)) {
    throw new RangeError(`connectWithRetry(${name}): jitterRatio must be within [0, 1]`);
  }
  if (retry.attemptTimeoutMs !== undefined && (!Number.isFinite(retry.attemptTimeoutMs) || retry.attemptTimeoutMs <= 0)) {
    throw new RangeError(`connectWithRetry(${name}): attemptTimeoutMs must be a finite number > 0`);
  }
  if (retry.overallDeadlineMs !== undefined && (!Number.isFinite(retry.overallDeadlineMs) || retry.overallDeadlineMs <= 0)) {
    throw new RangeError(`connectWithRetry(${name}): overallDeadlineMs must be a finite number > 0`);
  }
}

// ── cancellable sleep ────────────────────────────────────────────────────────────────────────
/** Resolves after `ms`; rejects with the signal's reason as soon as it aborts. Timer and listener are always released. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ── one attempt, bounded and cancellable ─────────────────────────────────────────────────────
async function runAttempt(
  name: string,
  connect: (signal: AbortSignal) => Promise<void>,
  timeoutMs: number,
  external: AbortSignal | undefined,
): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onExternalAbort: (() => void) | undefined;

  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const timeout = new ConnectAttemptTimeoutError(timeoutMs);
      controller.abort(timeout); // tell the driver to release the half-open socket
      reject(timeout);
    }, timeoutMs);
    if (external) {
      onExternalAbort = (): void => {
        const aborted = new ConnectAbortedError(name, { cause: external.reason });
        controller.abort(aborted);
        reject(aborted);
      };
      if (external.aborted) onExternalAbort();
      else external.addEventListener('abort', onExternalAbort, { once: true });
    }
  });
  guard.catch(() => undefined); // never an unhandled rejection if the attempt wins the race

  // `async () => connect(...)` also converts a SYNCHRONOUS throw from connect() into a rejection.
  const attempt = (async () => connect(controller.signal))();
  attempt.catch(() => undefined); // an attempt abandoned after timeout/abort must not crash the process when it later fails

  try {
    await Promise.race([attempt, guard]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onExternalAbort) external?.removeEventListener('abort', onExternalAbort);
  }
}

export async function connectWithRetry(params: ConnectWithRetryParams): Promise<ConnectResult> {
  const { name, connect, retry, logger, signal } = params;
  assertValid(name, retry);

  const sleep = params.sleep ?? abortableSleep;
  const now = params.now ?? Date.now;
  const jitterRatio = retry.jitterRatio ?? DEFAULT_JITTER_RATIO;
  const attemptTimeoutMs = retry.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const startedAt = now();
  const deadline = retry.overallDeadlineMs === undefined ? undefined : startedAt + retry.overallDeadlineMs;

  if (signal?.aborted) throw new ConnectAbortedError(name, { cause: signal.reason });

  const failDeadline = (attempt: number, err: unknown): never => {
    logger.fatal(
      `${name} did not connect within the overall deadline of ${retry.overallDeadlineMs}ms (${attempt} attempts) — aborting boot`,
      err,
      { attempts: attempt, overallDeadlineMs: retry.overallDeadlineMs },
    );
    throw err;
  };

  let lastError: unknown;
  for (let attempt = 1; ; attempt++) {
    // A real timer can oversleep past the deadline; never START an attempt that cannot finish.
    if (deadline !== undefined && attempt > 1 && now() >= deadline) failDeadline(attempt - 1, lastError);

    const remaining = deadline === undefined ? Number.POSITIVE_INFINITY : deadline - now();
    try {
      await runAttempt(name, connect, Math.max(1, Math.min(attemptTimeoutMs, remaining)), signal);
      logger.info(`${name} connected`, { attempt }); // metadata shape is pinned by the Database/Redis spec tests
      return { attempts: attempt, elapsedMs: now() - startedAt };
    } catch (err) {
      lastError = err;

      if (err instanceof ConnectAbortedError || signal?.aborted) {
        logger.warn(`${name} connection aborted`, { attempt });
        throw err instanceof ConnectAbortedError ? err : new ConnectAbortedError(name, { cause: err });
      }

      let retryable = true;
      if (params.isRetryable) {
        try {
          retryable = params.isRetryable(err);
        } catch (classifierError) {
          retryable = false; // a buggy classifier must not turn a boot failure into a long, blind retry
          logger.warn(`${name} isRetryable threw; treating the failure as permanent`, {
            attempt,
            ...describeConnectError(classifierError),
          });
        }
      }
      if (!retryable) {
        logger.fatal(`${name} connection failed with a non-retryable error — aborting boot`, err, { attempt });
        throw err;
      }
      if (attempt >= retry.maxAttempts) {
        logger.fatal(`${name} failed to connect after ${attempt} attempts — aborting boot`, err, { attempts: attempt });
        throw err;
      }

      const delayMs = computeBackoff(
        attempt - 1,
        { backoffMs: retry.initialDelayMs, maxDelayMs: retry.maxDelayMs, jitterRatio },
        params.random,
      );
      if (deadline !== undefined && now() + delayMs >= deadline) failDeadline(attempt, err);

      logger.warn(`${name} connection attempt ${attempt} failed, retrying in ${delayMs}ms`, {
        attempt,
        maxAttempts: retry.maxAttempts,
        delayMs,
        ...describeConnectError(err),
      });
      try {
        await sleep(delayMs, signal);
      } catch (sleepError) {
        logger.warn(`${name} connection aborted`, { attempt });
        throw new ConnectAbortedError(name, { cause: sleepError });
      }
    }
  }
}

/**
 * `isTransientNetworkError()` — a building block for a connect-time `isRetryable`.
 *
 * Recognises the Node/libuv errno codes that mean "the peer is not reachable RIGHT NOW"
 * (the condition boot-time retry exists for: the container started before the datastore
 * accepts connections), plus this module's own attempt-timeout error. It is deliberately
 * NOT driver-aware — Prisma/pg/Mongo/ioredis/S3 each signal "wrong credentials" and
 * "unknown database" in their own vocabulary, and `shared/` may not import any of them. A
 * Layer 2 module composes this with its own permanent-failure check:
 *
 *     isRetryable: (e) => !isAuthFailure(e) && (isTransientNetworkError(e) || isDriverTransient(e))
 *
 * Walks `.cause` (≤ 3 levels) and `AggregateError.errors` — Node's happy-eyeballs
 * `net.connect` reports a refused dual-stack connection as an AggregateError whose own
 * `code` is set, but wrappers frequently re-throw with only a `cause`.
 */
import { ConnectAttemptTimeoutError } from './connect-with-retry';

const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED', // port not open yet — the canonical "database still starting"
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENETDOWN',
  'EPIPE',
  'EAI_AGAIN', // DNS temporary failure
  'ENOTFOUND', // service DNS not registered yet (orchestrators publish it a moment after the pod)
  'EADDRNOTAVAIL',
]);

const MAX_DEPTH = 3;

function check(err: unknown, depth: number): boolean {
  if (typeof err !== 'object' || err === null || depth > MAX_DEPTH) return false;
  if (err instanceof ConnectAttemptTimeoutError) return true;
  const { code, errors, cause } = err as { code?: unknown; errors?: unknown; cause?: unknown };
  if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return true;
  if (Array.isArray(errors) && errors.some((e) => check(e, depth + 1))) return true;
  return check(cause, depth + 1);
}

export function isTransientNetworkError(err: unknown): boolean {
  return check(err, 0);
}

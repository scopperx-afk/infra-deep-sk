/**
 * infrastructure/shared — plain, stateless helpers that more than one module needs and no
 * single module may own (Resilience spec §6.2, Database spec §8). NOT a module: no DI, no
 * lifecycle, no state — import and call.
 *
 * The specs also import the two helpers by their direct file paths
 * (`shared/computeBackoff`, `shared/connect-with-retry`); both routes are supported.
 */
export { computeBackoff } from './computeBackoff';
export type { BackoffOptions } from './computeBackoff';

export {
  connectWithRetry,
  abortableSleep,
  describeConnectError,
  ConnectAttemptTimeoutError,
  ConnectAbortedError,
  DEFAULT_ATTEMPT_TIMEOUT_MS,
  DEFAULT_JITTER_RATIO,
} from './connect-with-retry';
export type { ConnectRetryOptions, ConnectWithRetryParams, ConnectResult, RetryLogger } from './connect-with-retry';

export { isTransientNetworkError } from './transient-network-error';

export { connectRetrySchema, DEFAULT_CONNECT_RETRY } from './connect-retry.schema';
export type { ConnectRetryConfig } from './connect-retry.schema';

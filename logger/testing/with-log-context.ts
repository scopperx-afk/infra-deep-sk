/**
 * withLogContext() — a testing utility in the same spirit as Config's
 * `staticSource` and Tracing's `withTraceContext`: binds a synthetic
 * `LogContext` for the duration of `fn`, so a test can assert on what a piece
 * of code under test logs (via `getLogContext()`-driven fields like `userId`)
 * without standing up real HTTP middleware.
 */
import { runWithLogContext } from '../context/log-context.store';
import type { LogContext } from '../logger.port';

export function withLogContext<T>(
  context: Partial<LogContext>,
  fn: () => T,
): T {
  return runWithLogContext({ ...context }, fn);
}

/**
 * LogContext's own AsyncLocalStorage — Logger spec §8. Entirely internal; the
 * store itself is never exported outside this module (not even outward from
 * `logger/index.ts`) — NOT a shared "Context" module (§2, §43 #2). The one
 * narrow exception is `enrichLogContext()`, the single additive write function
 * this file exports outward, for exactly the `userId`-after-a-Guard case §8
 * describes.
 *
 * Unlike Tracing's `TraceContext` (Tracing spec §15.3 — small, frozen, replaced
 * wholesale on every nested bind), `LogContext` is deliberately a single MUTABLE
 * object per request: `LoggerMiddleware` establishes it once with the fields
 * available at request start (§31), and `enrichLogContext()` — called later, in
 * the interceptor phase, once a Guard has resolved identity (§8) — needs that
 * same object still reachable and writable, not a second nested context the
 * original one can't see. `store.run()` therefore holds a plain object;
 * `enrichLogContext()` mutates it in place via `Object.assign`, which is safe
 * because everything downstream in the SAME async execution chain observes the
 * same reference `AsyncLocalStorage` handed out.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { LogContext } from '../logger.port';

const store = new AsyncLocalStorage<LogContext>();

/** Safe, non-throwing read — returns undefined outside any bound request. */
export function getLogContext(): LogContext | undefined {
  return store.getStore();
}

/** `LoggerMiddleware`'s own entry point (§31) — establishes every LogContext field
 *  EXCEPT userId in one call, at request start. */
export function runWithLogContext<T>(initial: LogContext, fn: () => T): T {
  return store.run({ ...initial }, fn);
}

/**
 * Logger spec §6, §8 — plain, no-DI function, mirroring `Tracing.getTraceContext()`'s
 * own no-DI shape (Tracing spec §4.2). A narrow, ADDITIVE write into the current
 * request's `LogContext` — not a general-purpose context-mutation API. Today's one
 * sanctioned caller is HTTP's own `LoggerAuthEnrichmentInterceptor` (§8, §31; HTTP
 * spec §13/§14), which calls it with `{ userId }` once a Guard has resolved identity.
 * A no-op outside any bound request, exactly like `getTraceContext()` is (never throws).
 */
export function enrichLogContext(partial: Partial<LogContext>): void {
  const current = store.getStore();
  if (current) Object.assign(current, partial);
}

/**
 * Owns the module-level AsyncLocalStorage<TraceContext> singleton itself, and
 * the plain getTraceContext()/runWithContext() read/write primitives — Tracing
 * spec §4.2, §16. No branching logic lives here, only ALS bookkeeping; the
 * §8.0 branching rule (which case applies, whether to create a span) lives in
 * tracing.propagation.ts, which calls back into this file for the actual
 * read/bind rather than duplicating it.
 *
 * This is real global mutable state — one singleton per process (§4.2's
 * stated trade-off) — deliberately, so that a plain function call from
 * anywhere (Logger's hot-path formatter, an error class's constructor, a
 * low-level utility with no constructor) reaches the same store a DI-injected
 * TracingService reaches, with no DI dependency required.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { TraceContext } from './tracing.port';

const store = new AsyncLocalStorage<TraceContext>();

/** Freezes a plain, small, four-field context object (§15.3) — never mutated
 *  in place, never grown, after this point. */
function freeze(ctx: TraceContext): TraceContext {
  return Object.freeze({ ...ctx });
}

/** Safe, non-throwing read of whatever context is active right now (§4.1).
 *  Returns undefined outside any bound context — never throws. */
export function getTraceContext(): TraceContext | undefined {
  return store.getStore();
}

/** Binds ctx for the duration of fn, across every await fn performs — exactly
 *  what AsyncLocalStorage.run() guarantees. Nested calls: the innermost bound
 *  context wins for its own callback; the outer one is restored afterward,
 *  including when fn throws (§4.1, §10, §13). */
export function runWithContext<T>(ctx: TraceContext, fn: () => T): T {
  return store.run(freeze(ctx), fn);
}

/**
 * HTTP's own `AsyncLocalStorage<RequestContext>` — spec §9. A plain
 * module-level singleton, the same pattern Tracing's `TraceContext` store
 * (`tracing.context.ts`) and Logger's `LogContext` store
 * (`context/log-context.store.ts`) both already use — `getRequestContext()`
 * is a plain, no-DI function specifically so Layer-1-or-above code deep in
 * domain logic can read `locale` without threading it through every call site
 * (§9's own stated rationale — an ergonomic convenience here, not the
 * cross-layer structural necessity Tracing's own no-DI form exists for).
 *
 * `REQUEST_CONTEXT_STORE` (internal token, http.tokens.ts) resolves to this
 * EXACT singleton via a trivial factory — never a second, separately
 * constructed `AsyncLocalStorage`, which would silently drift from what the
 * plain function reads.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestContext } from './request-context.port';

export const requestContextStore = new AsyncLocalStorage<RequestContext>();

/** Safe, non-throwing read — returns undefined outside any bound request,
 *  exactly like `getTraceContext()` does (Tracing spec §4.1). */
export function getRequestContext(): RequestContext | undefined {
  return requestContextStore.getStore();
}

/** `RequestContextMiddleware`'s own entry point (§9, §3 step 2). */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return requestContextStore.run(Object.freeze({ ...ctx }), fn);
}

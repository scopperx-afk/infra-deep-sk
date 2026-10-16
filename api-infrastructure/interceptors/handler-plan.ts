/**
 * Per-handler, per-class memoisation of metadata lookups — a small, deliberate hot-path
 * optimisation. Both global interceptors run on EVERY request of the whole API; their decisions
 * depend only on decorators (static after boot), so the `Reflect` lookups are done once per
 * `(controller class, handler)` pair and cached in `WeakMap`s (no leak: entries die with the class).
 *
 * The cache is keyed by BOTH class and handler because a handler inherited by two controller
 * subclasses can carry different class-level decorators in each.
 */
import type { ExecutionContext } from '@nestjs/common';

type AnyFn = (...args: never[]) => unknown;

export function memoisePerHandler<T>(compute: (ctx: ExecutionContext) => T): (ctx: ExecutionContext) => T {
  const byClass = new WeakMap<object, WeakMap<AnyFn, T>>();
  return (ctx) => {
    const cls = ctx.getClass() as unknown as object;
    const handler = ctx.getHandler() as unknown as AnyFn;
    let byHandler = byClass.get(cls);
    if (byHandler === undefined) {
      byHandler = new WeakMap();
      byClass.set(cls, byHandler);
    }
    if (byHandler.has(handler)) return byHandler.get(handler) as T;
    const value = compute(ctx);
    byHandler.set(handler, value);
    return value;
  };
}

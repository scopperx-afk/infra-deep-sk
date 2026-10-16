/**
 * `@LogMethod()` — Logger spec §32. Records method start/completion/duration/
 * error via a CHILD logger bound to `{ operation }` (§7) — never creates a
 * Tracing span itself (§32's own explicit anti-pattern: a method that also
 * needs a span calls `Tracing.startSpan()` separately, Tracing spec §4.1).
 *
 * Reads the logger off `this[loggerProperty]` (default `'logger'`, matching
 * §32's own worked example, which uses that exact property name for both
 * `@InjectLogger()` and the class `@LogMethod()` decorates) — a plain
 * TypeScript method decorator has no DI context of its own to reach into.
 *
 * §35's "no meaningful overhead when disabled": the expensive part (building
 * an entry, dispatching to transports) is already skipped by `ILogger`'s own
 * cheap level-filter check; this decorator's unconditional per-call cost is
 * bounded to one `child()` object-spread and a `Date.now()` read.
 */
import type { ILogger } from '../logger.port';

export interface LogMethodOptions {
  /** Property on `this` holding the `ILogger` — defaults to `'logger'` (§32). */
  loggerProperty?: string;
  /** Overrides the operation name used in log messages and the child binding —
   *  defaults to the decorated method's own name. */
  operation?: string;
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  );
}

export function LogMethod(options: LogMethodOptions = {}): MethodDecorator {
  return function decorate(
    _target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ): PropertyDescriptor {
    const original = descriptor.value as (...args: unknown[]) => unknown;
    const operation = options.operation ?? String(propertyKey);
    const loggerProperty = options.loggerProperty ?? 'logger';

    descriptor.value = function decorated(
      this: Record<string, unknown>,
      ...args: unknown[]
    ): unknown {
      const logger = this[loggerProperty] as ILogger | undefined;
      if (!logger) return original.apply(this, args); // no logger on this instance — call through, no decoration possible

      const child = logger.child({ operation });
      const start = Date.now();
      child.debug(`${operation} started`);

      const onError = (err: unknown): never => {
        child.error(`${operation} failed`, err, {
          durationMs: Date.now() - start,
        });
        throw err;
      };

      try {
        const result = original.apply(this, args);
        if (isPromiseLike(result)) {
          return result.then((value) => {
            child.debug(`${operation} completed`, {
              durationMs: Date.now() - start,
            });
            return value;
          }, onError);
        }
        child.debug(`${operation} completed`, {
          durationMs: Date.now() - start,
        });
        return result;
      } catch (err) {
        onError(err);
      }
    };

    return descriptor;
  };
}

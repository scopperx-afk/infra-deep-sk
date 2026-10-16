/**
 * `withApiRuntime()` — the API Infrastructure equivalent of Tracing's `withTraceContext()`
 * (Tracing spec §13) and Config's `staticSource`: scopes an override of the process-wide `api.*`
 * runtime snapshot (`runtime/api-runtime.ts`) around `fn`, then restores whatever was there
 * before — including when `fn` throws or its promise rejects. Exported from `index.ts` itself,
 * not a separate non-public entrypoint, exactly like its two siblings.
 */
import {
  configureApiRuntime,
  getApiRuntime,
  type ApiPaginationLimits,
  type ApiRuntime,
} from '../runtime/api-runtime';

export interface ApiRuntimeOverrides {
  readonly pagination?: Partial<ApiPaginationLimits>;
  readonly cursorSigningKeys?: readonly string[];
}

export function withApiRuntime<T>(overrides: ApiRuntimeOverrides, fn: () => T): T {
  const previous: ApiRuntime = getApiRuntime();
  configureApiRuntime({
    pagination: { ...previous.pagination, ...overrides.pagination },
    cursorSigningKeys: overrides.cursorSigningKeys ?? previous.cursorSigningKeys,
  });
  const restore = (): void => configureApiRuntime(previous);
  let result: T;
  try {
    result = fn();
  } catch (err) {
    restore();
    throw err;
  }
  if (result instanceof Promise) {
    return result.finally(restore) as T;
  }
  restore();
  return result;
}

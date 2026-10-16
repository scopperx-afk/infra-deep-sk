/**
 * The process-wide runtime snapshot of the `api.*` settings that the module's PLAIN FUNCTIONS
 * and STATIC SCHEMAS need — API Infrastructure spec §4.2-style (Tracing's plain-function
 * precedent), §5.3, §11.
 *
 * WHY a module-level holder and not DI: `CursorPaginationSchema` / `OffsetPaginationSchema`
 * (§5.3) are created at IMPORT time — `class ListUsersQuery extends createZodDto(...)` runs
 * long before Nest has loaded Config — and `encodeCursor()`/`decodeCursor()` (§5.1.3) are
 * plain functions with no constructor to inject into. Spec §5.3's own snippet hardcodes
 * `max(100)`/`default(20)` while §11 and Config §13.20 make both Config-driven; those two
 * statements cannot both be true for a static schema. The resolution (E-A2) is that the schemas
 * READ this holder at PARSE time, and `ApiInfrastructureModule` fills it once, during
 * bootstrap (`api.*` is not hot-reloadable, §11), so the schema stays an ordinary, `.extend()`-able
 * `z.object` while the numbers it enforces are the deployment's real ones.
 *
 * Trade-off, stated plainly (the same one Tracing §4.2 states for its ALS singleton): this is real
 * process-global state. Two Nest applications with DIFFERENT `api.*` values inside one process
 * would share the last-configured values. That never happens in production (one app per process);
 * in tests use `withApiRuntime()` (`testing/with-api-runtime.ts`) which scopes an override.
 *
 * Before any module has configured it, the defaults equal Config's catalog defaults (§13.20), so
 * a schema used in a bare unit test behaves exactly like a freshly booted app with default config.
 */
export interface ApiPaginationLimits {
  readonly defaultLimit: number;
  readonly maxLimit: number;
  readonly maxPage: number;
}

export interface ApiRuntime {
  readonly pagination: ApiPaginationLimits;
  /** Cursor-signing keys, newest first; `[]` = cursors are unsigned (§5.1.3 default). */
  readonly cursorSigningKeys: readonly string[];
}

export const DEFAULT_API_RUNTIME: ApiRuntime = Object.freeze({
  pagination: Object.freeze({ defaultLimit: 20, maxLimit: 100, maxPage: 1_000 }),
  cursorSigningKeys: Object.freeze([] as string[]),
});

let current: ApiRuntime = DEFAULT_API_RUNTIME;

export function configureApiRuntime(next: ApiRuntime): void {
  current = Object.freeze({
    pagination: Object.freeze({ ...next.pagination }),
    cursorSigningKeys: Object.freeze([...next.cursorSigningKeys]),
  });
}

export function getApiRuntime(): ApiRuntime {
  return current;
}

export function resetApiRuntime(): void {
  current = DEFAULT_API_RUNTIME;
}

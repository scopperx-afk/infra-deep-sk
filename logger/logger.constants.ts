/**
 * Constants shared by two or more collaborators inside this module — kept in
 * one file so a change to a shared number can't accidentally drift between the
 * two places that must agree on it, mirroring Config's own single-`ORIGIN_RANK`
 * style consolidation.
 */

/**
 * §13/§14 — the ONE shared bound for both the error `cause` chain (§13) and
 * redaction recursion (§14). A single named constant, not two independently
 * drifting numbers: "an unbounded walk over possibly-cyclic or pathologically
 * deep data is exactly the unbounded-growth risk this project's governing
 * principle on backpressure/bounded growth exists to close off everywhere it
 * appears" (§13).
 */
export const MAX_DEPTH = 8;

/**
 * Hard bounds on ANY value that passes through redaction (§14) — a logger must not be an
 * unbounded-work or unbounded-output hazard just because a caller handed it a big object
 * graph (an ORM entity with relations, an HTTP client error carrying its whole request).
 * Exceeding a bound never drops the log line: the excess is replaced by an explicit marker.
 */
export const MAX_REDACT_NODES = 2_000;
export const MAX_OBJECT_KEYS = 200;
export const MAX_ARRAY_ITEMS = 200;
export const MAX_STRING_CHARS = 8 * 1024;
/** Cap on the log `message` itself, and on `error.message` / `error.stack` text. */
export const MAX_MESSAGE_CHARS = 8 * 1024;
export const MAX_STACK_CHARS = 32 * 1024;

/** §15 — default metadata size limit, in bytes. */
export const DEFAULT_METADATA_SIZE_LIMIT_BYTES = 16 * 1024;

/** §22 — priority-aware backpressure drop order, TRACE dropped first. Reflects
 *  `logger.port.ts`'s own `LOG_LEVEL_ORDER`, WITH AUDIT folded into WARN's tier
 *  rather than listed as its own entry — §22's table never mentions AUDIT at
 *  all, and `priority-buffer.ts`'s own `PRIORITY` map gives it WARN's priority
 *  for exactly that reason (E-L4). This is NOT simply `LOG_LEVEL_ORDER` with
 *  one level missing by accident; kept as one literal here to make the §22
 *  table directly traceable in this file, but `priority-buffer.ts`'s
 *  `PRIORITY` map (not this array) is what the buffer actually reads at
 *  runtime — this constant is documentation, not consumed code. */
export const BACKPRESSURE_DROP_ORDER = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
] as const;

/** §21 — HTTP transport defaults (documented here even though the HTTP transport
 *  itself is deferred, §42, so the numbers have one home when it's built). */
export const DEFAULT_HTTP_BATCH_SIZE = 50;
export const DEFAULT_HTTP_FLUSH_INTERVAL_MS = 5000;
export const DEFAULT_HTTP_RETRIES = 3;

/**
 * §20 — File transport defaults (E-L9). Expressed in MB/file-count, not raw
 * bytes: `logging.file.*` (config/logging.schema.ts) and the operator-facing
 * `.env` are both MB-denominated (`LOGGING__FILE__MAX_SIZE_MB`), so the
 * constant that seeds their default should be too — converting once, in
 * `file.transport.ts`, at the one point bytes are actually needed, rather
 * than forcing every reader of this file to divide by 1024*1024 to sanity-
 * check the number. Supersedes the old byte-denominated
 * `DEFAULT_FILE_ROTATION_BYTES` (dropped — nothing outside this module
 * referenced it).
 */
export const DEFAULT_FILE_MAX_SIZE_MB = 20;
export const DEFAULT_FILE_MAX_FILES = 14;

/** §24 — Sentry transport default sample rate for performance traces (E-L10).
 *  Deliberately conservative — full tracing on every request is a cost/volume
 *  decision each project should opt INTO via `logging.sentry.tracesSampleRate`,
 *  not inherit by accident from a permissive default. */
export const DEFAULT_SENTRY_TRACES_SAMPLE_RATE = 0.1;

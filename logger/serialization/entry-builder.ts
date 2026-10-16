/**
 * Assembles one final `LogEntry` from every field's single owning source (§3's
 * table) — the one place §11's field order and §15's size limit are enforced.
 */
import type {
  LogContext,
  LogEntry,
  LogLevel,
  LogMetadata,
  LoggerContext,
} from '../logger.port';
import { MAX_MESSAGE_CHARS } from '../logger.constants';
import type { LogRedactor } from '../redaction/log-redactor';
import { serializeError } from './error-serializer';

export interface ServiceIdentity {
  service?: string;
  environment?: string;
  instanceId?: string;
}

/** The four fields Tracing owns (Tracing spec §3) — never re-derived, only read. */
export interface TraceFields {
  correlationId?: string;
  causationId?: string;
  traceId?: string;
  spanId?: string;
}

export interface MetadataLimit {
  sizeLimitBytes: number;
  sizeLimitPolicy: 'truncate' | 'reject';
}

export interface BuildEntryArgs {
  level: LogLevel;
  message: string;
  /** Child-logger static bindings (§7) — already merged across the whole child chain. */
  staticContext: LoggerContext;
  identity: ServiceIdentity;
  trace: TraceFields | undefined;
  logContext: LogContext | undefined;
  metadata: LogMetadata | undefined;
  /** Only set for error()/fatal() calls (§6) — the raw, unserialized value. */
  rawError?: unknown;
  redactor: LogRedactor;
  limit: MetadataLimit;
  now: () => string;
  onMetadataOversized?: (level: LogLevel) => void;
}

const STATIC_NAMED_KEYS = new Set([
  'module',
  'operation',
  'entityType',
  'entityId',
]);

/**
 * Fields this builder OWNS. A caller-supplied key of the same name (`logger.info('x', { level: 3 })`,
 * a child-logger binding `{ message: … }`, an attacker-influenced `{ correlationId: … }`) must never
 * replace one — the original code merged metadata AFTER the owned fields, so it silently did:
 * `level: 3` crashed the console transport, `message`/`correlationId` could be forged.
 * A colliding key is kept, losslessly, as `meta.<key>`.
 */
const OWNED_KEYS: ReadonlySet<string> = new Set([
  'timestamp',
  'level',
  'message',
  'service',
  'environment',
  'instanceId',
  'module',
  'operation',
  'entityType',
  'entityId',
  'correlationId',
  'causationId',
  'traceId',
  'spanId',
  'userId',
]);
/** Fields that are ALWAYS owned — populated unconditionally, or identity/trace fields that must
 *  never be caller-writable even when this entry happens to have none (forging a `traceId` /
 *  `correlationId` would corrupt incident correlation). Every other owned field is renamed only
 *  when it actually collides with a value already set — so the very common
 *  `logger.info('x', { userId })` in a context with no authenticated user still lands in `userId`. */
const ALWAYS_OWNED_KEYS: ReadonlySet<string> = new Set([
  'timestamp',
  'level',
  'message',
  'correlationId',
  'causationId',
  'traceId',
  'spanId',
]);
/** `error` is owned only when this call actually carries an error argument. */
const OWNED_KEYS_WITH_ERROR: ReadonlySet<string> = new Set([...OWNED_KEYS, 'error']);
const ALWAYS_OWNED_WITH_ERROR: ReadonlySet<string> = new Set([...ALWAYS_OWNED_KEYS, 'error']);

function assignField(
  entry: LogEntry,
  key: string,
  value: unknown,
  withError: boolean,
): void {
  if (key === '__proto__') return; // would re-parent the entry instead of adding a field
  const owned = withError ? OWNED_KEYS_WITH_ERROR : OWNED_KEYS;
  const always = withError ? ALWAYS_OWNED_WITH_ERROR : ALWAYS_OWNED_KEYS;
  const collides =
    owned.has(key) &&
    (always.has(key) || Object.prototype.hasOwnProperty.call(entry, key));
  entry[collides ? `meta.${key}` : key] = value;
}

const truncateText = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max)}…[truncated ${s.length - max} chars]` : s;

/** §11's recommended field order, in full — including keys this builder always fills in
 *  before any caller-supplied metadata is merged in, so a metadata key of the same name
 *  can never silently reorder or shadow an owned field. */
export function buildLogEntry(args: BuildEntryArgs): LogEntry {
  const {
    level,
    message,
    staticContext,
    identity,
    trace,
    logContext,
    redactor,
    limit,
  } = args;

  const withError = args.rawError !== undefined;
  const entry = {} as LogEntry;
  entry.timestamp = args.now();
  entry.level = level;
  // The message is free text too (`\`login failed password=${pw}\``) and can be arbitrarily
  // long: redacted like every other string, and capped.
  entry.message = redactor.redactText(
    truncateText(typeof message === 'string' ? message : String(message), MAX_MESSAGE_CHARS),
  );

  if (identity.service !== undefined) entry.service = identity.service;
  if (identity.environment !== undefined)
    entry.environment = identity.environment;
  if (identity.instanceId !== undefined) entry.instanceId = identity.instanceId;

  if (staticContext.module !== undefined) entry.module = staticContext.module;
  if (staticContext.operation !== undefined)
    entry.operation = staticContext.operation;
  if (staticContext.entityType !== undefined)
    entry.entityType = staticContext.entityType;
  if (staticContext.entityId !== undefined)
    entry.entityId = staticContext.entityId;

  if (trace?.correlationId !== undefined)
    entry.correlationId = trace.correlationId;
  if (trace?.causationId !== undefined) entry.causationId = trace.causationId;
  if (trace?.traceId !== undefined) entry.traceId = trace.traceId; // omitted, never "undefined" (Tracing spec §3, §12)
  if (trace?.spanId !== undefined) entry.spanId = trace.spanId;

  if (logContext?.userId !== undefined) entry.userId = logContext.userId;

  // Extra static bindings beyond the four named ones (LoggerContext's own index
  // signature, §7) — e.g. a project-specific field a child logger was given.
  for (const [k, v] of Object.entries(staticContext)) {
    if (!STATIC_NAMED_KEYS.has(k) && v !== undefined)
      assignField(entry, k, redactor.matchesName(k) ? '[REDACTED]' : redactor.redact(v), withError);
  }

  if (args.metadata) {
    // Redact FIRST (the walk is bounded in nodes/keys/string length), THEN measure: the size
    // limit applies to what would actually be written.
    const { accepted, oversized } = enforceLimit(
      redactor.redact(args.metadata),
      limit,
    );
    if (oversized) args.onMetadataOversized?.(level);
    for (const [k, v] of Object.entries(accepted)) assignField(entry, k, v, withError);
  }

  // Error last (§11 — "often the largest field").
  if (args.rawError !== undefined)
    entry.error = serializeError(args.rawError, redactor);

  return entry;
}

/** Room reserved for the marker fields a truncation itself adds. */
const TRUNCATION_MARKER_RESERVE_BYTES = 256;
const MAX_OMITTED_KEYS_LISTED = 20;

const jsonBytes = (v: unknown): number | undefined => {
  try {
    return Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8');
  } catch {
    return undefined; // unserializable — size unknown
  }
};

/**
 * §15 — checked against the (already redacted) metadata payload specifically, not the whole
 * entry: context/identity fields are fixed-shape, and `error` text is capped by the serializer.
 *
 * `truncate` really truncates: fields are kept, in order, while they fit; those that do not are
 * omitted and NAMED in `metadataOmittedKeys`. (The first implementation replaced the ENTIRE
 * metadata with a marker, so one 20 KB `payload` also discarded `orderId` and `userId` — the
 * fields you most need to find the failing request.) `reject` keeps its all-or-nothing marker.
 */
function enforceLimit(
  metadata: LogMetadata,
  limit: MetadataLimit,
): { accepted: LogMetadata; oversized: boolean } {
  const bytes = jsonBytes(metadata);
  // Unmeasurable: let it through rather than reject a log line over a measurement failure
  // (the redactor already removed cycles/BigInt, so this is a last-resort branch).
  if (bytes === undefined || bytes <= limit.sizeLimitBytes)
    return { accepted: metadata, oversized: false };

  if (limit.sizeLimitPolicy === 'reject')
    return {
      accepted: { metadataRejected: true, metadataSizeBytes: bytes },
      oversized: true,
    };

  let budget = Math.max(0, limit.sizeLimitBytes - TRUNCATION_MARKER_RESERVE_BYTES);
  const kept: LogMetadata = {};
  const omitted: string[] = [];
  for (const [k, v] of Object.entries(metadata)) {
    const size = (jsonBytes(k) ?? k.length + 2) + 1 + (jsonBytes(v) ?? Number.POSITIVE_INFINITY);
    if (size <= budget) {
      kept[k] = v;
      budget -= size;
    } else omitted.push(k);
  }
  return {
    accepted: {
      ...kept,
      metadataTruncated: true,
      metadataSizeBytes: bytes,
      metadataLimitBytes: limit.sizeLimitBytes,
      ...(omitted.length > 0
        ? { metadataOmittedKeys: omitted.slice(0, MAX_OMITTED_KEYS_LISTED) }
        : {}),
    },
    oversized: true,
  };
}

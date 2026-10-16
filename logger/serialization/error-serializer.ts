/**
 * Error serialization — Logger spec §13. Depth bound shared with redaction (§14),
 * imported from logger.constants.ts, not redeclared here.
 */
import type { SerializedError } from '../logger.port';
import {
  MAX_DEPTH,
  MAX_MESSAGE_CHARS,
  MAX_STACK_CHARS,
} from '../logger.constants';
import type { LogRedactor } from '../redaction/log-redactor';

const RESERVED_ERROR_KEYS = new Set(['name', 'message', 'stack', 'cause']);

/**
 * A non-`Error` value passed where an error was expected (a thrown string, a plain
 * object, `undefined`) is serialized best-effort into the same shape rather than
 * crashing the logger call itself (§13) — a bad value here must never prevent the
 * log line, and any real error information alongside it, from being written at all.
 */
export function serializeError(
  value: unknown,
  redactor?: LogRedactor,
): SerializedError {
  return walk(value, 0, redactor);
}

/**
 * `depth` counts nodes already emitted (0-indexed): depths 0..MAX_DEPTH-1 (8 nodes) are
 * walked normally. Reaching for a 9th node (depth would become MAX_DEPTH) instead marks
 * the LAST included node with `causeTruncated: true` and stops — no synthetic placeholder
 * node, no further `cause` key at all — matching §13's "truncated with an explicit
 * marker," not "one extra fabricated leaf."
 *
 * Only the native `Error.cause` (ES2022) is followed. §13 allows for "an adapter's own
 * equivalent" (a library using e.g. `.innerError` instead) — not implemented here; a
 * project adopting such a library adds its property name to this one check.
 */
function walk(
  value: unknown,
  depth: number,
  redactor?: LogRedactor,
): SerializedError {
  if (!(value instanceof Error)) return serializeNonError(value, redactor);

  // Every read goes through `safe()`: an Error with a throwing getter (`message`, `stack`, an
  // extra prop) must still produce a log line — the error being logged is exactly when the
  // logger can least afford to throw.
  const message = cap(safe(() => String(value.message), '(unreadable message)'), MAX_MESSAGE_CHARS);
  const out: SerializedError = {
    name: safe(() => value.name, 'Error') || 'Error',
    message: redactor ? redactor.redactText(message) : message,
  };
  const rawStack = safe(() => value.stack, undefined);
  if (typeof rawStack === 'string') {
    const stack = cap(rawStack, MAX_STACK_CHARS);
    out.stack = redactor ? redactor.redactText(stack) : stack;
  }

  const extra = extraEnumerableProps(value);
  if (extra) {
    const redactedExtra = redactor ? redactor.redact(extra) : extra;
    Object.assign(out, redactedExtra); // never overwrites name/message/stack/cause — see extraEnumerableProps
  }

  const cause = safe(() => (value as { cause?: unknown }).cause, undefined);
  if (cause !== undefined) {
    if (depth + 1 >= MAX_DEPTH) out.causeTruncated = true;
    else out.cause = walk(cause, depth + 1, redactor);
  }
  return out;
}

function serializeNonError(
  value: unknown,
  redactor?: LogRedactor,
): SerializedError {
  if (value === undefined) return { name: 'NonError', message: 'undefined' };
  if (value === null) return { name: 'NonError', message: 'null' };
  if (typeof value === 'string')
    return {
      name: 'NonError',
      message: redactor ? redactor.redactText(value) : value,
    };
  // A thrown plain object (`throw { code: 'E_X', detail }`) used to become "[object Object]" —
  // the one case where the actual information is the whole point of the log line. Redact it
  // (bounded) and render it as JSON instead.
  if (typeof value === 'object' && redactor) {
    try {
      return {
        name: 'NonError',
        message: cap(JSON.stringify(redactor.redact(value)) ?? '[object]', MAX_MESSAGE_CHARS),
      };
    } catch {
      /* fall through to the String() path below */
    }
  }
  try {
    return { name: 'NonError', message: String(value) };
  } catch {
    return { name: 'NonError', message: '(unserializable value)' };
  }
}

const cap = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max)}…[truncated ${s.length - max} chars]` : s;

/** An error subclass's own extra fields (`DatabaseError.query`, `HttpError.statusCode`, …) —
 *  never re-derives or overwrites the four reserved keys. `undefined` when there are none, so
 *  callers don't spread an empty object into every serialized error for nothing. */
function extraEnumerableProps(err: Error): Record<string, unknown> | undefined {
  const keys = safe(() => Object.keys(err), [] as string[]).filter(
    (k) => !RESERVED_ERROR_KEYS.has(k) && k !== '__proto__',
  );
  if (keys.length === 0) return undefined;
  const out: Record<string, unknown> = {};
  for (const k of keys)
    out[k] = safe(() => (err as unknown as Record<string, unknown>)[k], '[UNREADABLE]');
  return out;
}

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

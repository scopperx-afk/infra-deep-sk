/**
 * Key-name pattern redaction — Logger spec §14.
 *
 * Independent of, and unrelated to, Config's own `secretPaths` mechanism (Config
 * spec §7.5, §9.3) — that protects Config's own resolved values from appearing in
 * a Config VALIDATION error message; this is a general-purpose scrubber for
 * whatever metadata a call site happens to log, a completely different surface
 * with a completely different threat model (§14's own distinction).
 *
 * ── Two mechanisms, because the spec asks for two things ───────────────────────
 * §14: "applied recursively across objects, arrays, nested metadata, AND error
 * objects (including inside error.message/error.stack ...)". A key-NAME match
 * (`redact`) is what structured data needs — walk the object graph, redact any
 * VALUE whose OWN KEY matches. `redactText` is a best-effort SECOND mechanism for
 * free text (messages, stacks, string values): `key=value` / `key: value` /
 * `"key":"value"` shapes, `Bearer <token>` credentials and `scheme://user:pass@host`
 * URL credentials. It is heuristic, never exhaustive.
 *
 * ── What changed vs. the first implementation (review findings) ───────────────
 *  1. CLASS INSTANCES ARE WALKED. They used to be returned untouched "rather than
 *     guessed at" — which leaked every password in a DTO/entity class and every
 *     `Authorization` header an Error subclass carries (`AxiosError.config`).
 *     Own enumerable props are now walked like a plain object.
 *  2. Errors, Maps, Sets, `toJSON()` objects, Buffers and EventEmitters
 *     (sockets, streams, ClientRequest…) get dedicated handling.
 *  3. Key matching is SEPARATOR/CASE-INSENSITIVE: `api_key`, `x-api-key`, `apiKey`
 *     are one thing. Short, collision-prone words (`pin`, `ssn`, `otp`, `cvv`)
 *     match the WHOLE key only — substring matching would redact `shipping`,
 *     `mapping`, `classNames`, `footprint`.
 *  4. `Authorization: Bearer <jwt>` now redacts the credential (the old behaviour
 *     — and a test — kept the token visible); URL credentials are redacted.
 *  5. Everything is BOUNDED (nodes, keys, array items, string length): exceeding a
 *     bound yields a marker, never an unbounded walk or an unbounded line.
 *  6. BigInt becomes a string (JSON.stringify throws on it).
 */
import { EventEmitter } from 'node:events';
import {
  MAX_ARRAY_ITEMS,
  MAX_DEPTH,
  MAX_OBJECT_KEYS,
  MAX_REDACT_NODES,
  MAX_STACK_CHARS,
  MAX_STRING_CHARS,
} from '../logger.constants';

/** Case-insensitive SUBSTRING match against a normalized key (separators removed), so
 *  `userPassword`, `PASSWORD_HASH`, `access_token`, `x-api-key`, `private_key`,
 *  `Authorization`, `credit_card_number` all match. */
export const DEFAULT_REDACT_PATTERNS: readonly string[] = [
  'password',
  'passwd',
  'token',
  'authorization',
  'cookie',
  'secret',
  'apiKey',
  'privateKey',
  'accessKey',
  'credential',
  'creditCard',
  'cardNumber',
];

/** Short / collision-prone names — matched against the WHOLE normalized key only. */
export const DEFAULT_REDACT_EXACT_KEYS: readonly string[] = [
  'otp',
  'pin',
  'ssn',
  'cvv',
  'cvc',
  'jwt',
  'pwd',
];

export const REDACTED = '[REDACTED]';
const CIRCULAR = '[CIRCULAR]';
const MAX_DEPTH_MARKER = '[MAX_DEPTH]';
const TRUNCATED_MARKER = '[TRUNCATED]';
const UNREADABLE = '[UNREADABLE]';

const normalizeKey = (k: string): string =>
  k.toLowerCase().replace(/[^a-z0-9]/g, '');

/** `key=value`, `key: value`, `"key":"value"` — the generic shape; whether a given `key`
 *  is sensitive is decided in the replacer via `matchesName`, so ONE pass covers every
 *  configured name in every spelling. `:` followed by `//` is a URL scheme, not a
 *  separator (otherwise `https://x?access_token=…` would be swallowed whole and never
 *  inspected). An auth scheme word before the credential is consumed with it. */
const KEY_VALUE_RE =
  /([A-Za-z][A-Za-z0-9_.-]{0,63})("?\s*(?:=|:(?!\/\/))\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|(?:(?:Bearer|Basic|Digest|Negotiate)\s+)?\S+)/gi;
const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]{8,}=*/gi;
const URL_CREDENTIALS_RE =
  /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi;
const TEXT_HINT_RE = /[:=@]|bearer|basic/i;

interface WalkState {
  nodes: number;
  readonly seen: Set<object>;
}

export class LogRedactor {
  private readonly substrings: string[];
  private readonly exact: Set<string>;

  /** `extra` is `logging.redact.paths` (Config spec §13.11) — each entry is one more KEY-NAME
   *  pattern (substring, normalized), the same kind as `DEFAULT_REDACT_PATTERNS`. */
  constructor(extra: readonly string[] = []) {
    this.substrings = [...DEFAULT_REDACT_PATTERNS, ...extra]
      .filter((p) => p.trim().length > 0)
      .map(normalizeKey)
      .filter((p) => p.length > 0);
    this.exact = new Set(DEFAULT_REDACT_EXACT_KEYS.map(normalizeKey));
  }

  matchesName(key: string): boolean {
    const n = normalizeKey(key);
    if (n.length === 0) return false;
    if (this.exact.has(n)) return true;
    return this.substrings.some((p) => n.includes(p));
  }

  /** Redacts credentials embedded in free text. Heuristic — see the file header. */
  redactText(text: string): string {
    if (typeof text !== 'string' || text.length < 6) return text;
    let out = text;
    if (out.includes('://'))
      out = out.replace(URL_CREDENTIALS_RE, `$1$2:${REDACTED}@`);
    if (/bearer|basic/i.test(out))
      out = out.replace(BEARER_RE, `$1 ${REDACTED}`);
    out = out.replace(
      KEY_VALUE_RE,
      (match: string, key: string, sep: string) =>
        this.matchesName(key) ? `${key}${sep}${REDACTED}` : match,
    );
    return out;
  }

  /** Recursive, depth-, cycle- and size-bounded redaction of a metadata value or graph. */
  redact<T>(value: T): T {
    return this.walk(value, 0, { nodes: 0, seen: new Set() }) as T;
  }

  private walkString(s: string): string {
    let out = s;
    if (out.length > MAX_STRING_CHARS)
      out = `${out.slice(0, MAX_STRING_CHARS)}…[truncated ${s.length - MAX_STRING_CHARS} chars]`;
    return TEXT_HINT_RE.test(out) ? this.redactText(out) : out;
  }

  private walk(value: unknown, depth: number, state: WalkState): unknown {
    switch (typeof value) {
      case 'string':
        return this.walkString(value);
      case 'bigint':
        return value.toString();
      case 'function':
        return '[Function]';
      case 'symbol':
        return value.toString();
      case 'object':
        break;
      default:
        return value; // number, boolean, undefined
    }
    if (value === null) return null;
    const obj = value as object;

    if (state.seen.has(obj)) return CIRCULAR;
    if (++state.nodes > MAX_REDACT_NODES) return TRUNCATED_MARKER;
    if (depth >= MAX_DEPTH) return MAX_DEPTH_MARKER;

    if (obj instanceof Date || obj instanceof RegExp) return obj;
    if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer)
      return `[Binary ${(obj as ArrayBufferView).byteLength} bytes]`;
    // Sockets, streams, servers, ClientRequest/IncomingMessage… — never useful in a log,
    // enormous and cyclic, and they carry raw headers (credentials).
    if (obj instanceof EventEmitter) return `[${obj.constructor?.name ?? 'EventEmitter'}]`;

    state.seen.add(obj);
    try {
      if (Array.isArray(obj)) return this.walkArray(obj, depth, state);
      if (obj instanceof Map)
        return this.walkEntries(obj.entries(), depth, state, obj.size);
      if (obj instanceof Set)
        return this.walkArray([...obj].slice(0, MAX_ARRAY_ITEMS + 1), depth, state);
      if (obj instanceof Error) return this.walkError(obj, depth, state);
      if (obj instanceof URL) return this.walkString(obj.toString());

      const toJSON = (obj as { toJSON?: unknown }).toJSON;
      if (typeof toJSON === 'function' && !isPlainObject(obj)) {
        let json: unknown;
        try {
          json = (toJSON as () => unknown).call(obj);
        } catch {
          return UNREADABLE;
        }
        if (json !== obj) return this.walk(json, depth + 1, state);
      }
      return this.walkObject(obj as Record<string, unknown>, depth, state);
    } finally {
      state.seen.delete(obj);
    }
  }

  private walkArray(arr: unknown[], depth: number, state: WalkState): unknown[] {
    const out: unknown[] = [];
    const limit = Math.min(arr.length, MAX_ARRAY_ITEMS);
    for (let i = 0; i < limit; i++) out.push(this.walk(arr[i], depth + 1, state));
    if (arr.length > limit)
      out.push(`[${arr.length - limit} more items truncated]`);
    return out;
  }

  private walkEntries(
    entries: IterableIterator<[unknown, unknown]>,
    depth: number,
    state: WalkState,
    total: number,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [k, v] of entries) {
      if (count++ >= MAX_OBJECT_KEYS) break;
      const key = String(k);
      out[key] = this.matchesName(key)
        ? REDACTED
        : this.walk(v, depth + 1, state);
    }
    if (total > MAX_OBJECT_KEYS)
      out['[truncated]'] = `${total - MAX_OBJECT_KEYS} more entries`;
    return out;
  }

  private walkObject(
    obj: Record<string, unknown>,
    depth: number,
    state: WalkState,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    let keys: string[];
    try {
      keys = Object.keys(obj);
    } catch {
      return { '[unreadable]': true };
    }
    const limit = Math.min(keys.length, MAX_OBJECT_KEYS);
    for (let i = 0; i < limit; i++) {
      const k = keys[i];
      if (k === '__proto__') continue;
      if (this.matchesName(k)) {
        out[k] = REDACTED;
        continue;
      }
      let v: unknown;
      try {
        v = obj[k]; // a getter may throw — one bad property must not lose the whole line
      } catch {
        out[k] = UNREADABLE;
        continue;
      }
      out[k] = this.walk(v, depth + 1, state);
    }
    if (keys.length > limit)
      out['[truncated]'] = `${keys.length - limit} more keys`;
    return out;
  }

  /** Same shape `serializeError` produces (`name`, `message`, `stack`, extras, `cause`), but
   *  walked with THIS traversal's shared state — so cycles/budgets hold across nested errors. */
  private walkError(err: Error, depth: number, state: WalkState): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const safe = <T>(read: () => T, fallback: T): T => {
      try {
        return read();
      } catch {
        return fallback;
      }
    };
    out.name = safe(() => String(err.name || 'Error'), 'Error');
    out.message = this.redactText(
      this.cap(safe(() => String(err.message), UNREADABLE), MAX_STRING_CHARS),
    );
    const stack = safe(() => err.stack, undefined);
    if (typeof stack === 'string')
      out.stack = this.redactText(this.cap(stack, MAX_STACK_CHARS));
    for (const k of safe(() => Object.keys(err), [] as string[])) {
      if (k === 'name' || k === 'message' || k === 'stack' || k === 'cause' || k === '__proto__')
        continue;
      if (this.matchesName(k)) {
        out[k] = REDACTED;
        continue;
      }
      out[k] = this.walk(safe(() => (err as unknown as Record<string, unknown>)[k], UNREADABLE), depth + 1, state);
    }
    const cause = safe(() => (err as { cause?: unknown }).cause, undefined);
    if (cause !== undefined) {
      if (depth + 1 >= MAX_DEPTH) out.causeTruncated = true;
      else out.cause = this.walk(cause, depth + 1, state);
    }
    return out;
  }

  private cap(s: string, max: number): string {
    return s.length > max ? `${s.slice(0, max)}…[truncated ${s.length - max} chars]` : s;
  }
}

function isPlainObject(v: unknown): boolean {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

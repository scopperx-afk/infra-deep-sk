/**
 * Cursor codec — API Infrastructure spec §5.1.3. Cursors are OPAQUE to the client; the domain's
 * repository decides what a payload contains. This module only owns the codec.
 *
 * Wire format
 *   unsigned (default):  base64url(JSON(payload))
 *   signed  (opt-in):    base64url(JSON(payload)) "." base64url(HMAC-SHA256(...)[0..16))
 *
 * Signing is enabled by configuring `api.cursor.signingKeys` (E-A13). Spec §5.1.3 left integrity
 * to "the domain"; at platform scale that means every team re-deciding whether a tampered
 * `{"id":"u-1"}` cursor is acceptable. Signing makes a client-forged or edited cursor decode to
 * `null` (→ first page, or a 400 under `@CursorParams({ onInvalidCursor: 'reject' })`) instead of
 * reaching a repository query. Keys rotate newest-first: the first key signs, every key verifies,
 * so a rotation never invalidates cursors minted under the previous key within its lifetime.
 * Verification is constant-time (`crypto.timingSafeEqual`).
 *
 * Hardening beyond the spec's "malformed → null" (E-A13):
 *   • length cap (`MAX_CURSOR_LENGTH`) BEFORE any decoding work;
 *   • strict base64url alphabet — `Buffer.from(x, 'base64url')` silently skips junk characters,
 *     which would let many different strings alias one cursor;
 *   • payload must be a plain JSON object (not `null`, an array, a number);
 *   • any `__proto__`/`constructor`/`prototype` key at ANY depth is rejected — a domain that later
 *     does `Object.assign(query, cursor)` or a lodash-style merge must not be one step from
 *     prototype pollution because a client supplied the cursor.
 *
 * `encodeCursor()` is the one function here that CAN throw — on a non-object payload or a payload
 * that would encode past `MAX_CURSOR_LENGTH`. That is a programmer error caught in development;
 * silently minting a cursor the decoder will later reject would be far worse (every client would
 * be quietly reset to page 1 on its second request).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  CURSOR_SIGNATURE_BYTES,
  MAX_CURSOR_LENGTH,
} from '../api-infrastructure.constants';
import { getApiRuntime } from '../runtime/api-runtime';

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype ||
    Object.getPrototypeOf(v) === null);

const sign = (body: string, key: string): Buffer =>
  createHmac('sha256', key).update(body).digest().subarray(0, CURSOR_SIGNATURE_BYTES);

/**
 * Encodes a domain-supplied cursor payload into an opaque, URL-safe token. The payload shape is
 * domain-chosen but must be JSON-safe: a `Date` becomes its ISO string (decode it back yourself).
 */
export function encodeCursor(payload: Record<string, unknown>): string {
  if (!isPlainObject(payload)) {
    throw new TypeError('encodeCursor: payload must be a plain object');
  }
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const [signingKey] = getApiRuntime().cursorSigningKeys;
  const token =
    signingKey === undefined
      ? body
      : `${body}.${sign(body, signingKey).toString('base64url')}`;
  if (token.length > MAX_CURSOR_LENGTH) {
    throw new RangeError(
      `encodeCursor: encoded cursor is ${token.length} chars, over the ${MAX_CURSOR_LENGTH}-char limit — put a compact reference (an id, a sort key), not a record, in the cursor`,
    );
  }
  return token;
}

function verifiedBody(cursor: string, keys: readonly string[]): string | null {
  if (keys.length === 0) {
    // Unsigned mode: the unsigned alphabet has no '.', so a dot means a signed cursor was
    // presented to a deployment that no longer signs — reject rather than guess.
    return cursor.includes('.') ? null : cursor;
  }
  const dot = cursor.lastIndexOf('.');
  if (dot <= 0 || dot === cursor.length - 1) return null;
  const body = cursor.slice(0, dot);
  const sigText = cursor.slice(dot + 1);
  if (!BASE64URL.test(sigText)) return null;
  const given = Buffer.from(sigText, 'base64url');
  if (given.length !== CURSOR_SIGNATURE_BYTES) return null;
  let ok = false;
  // Every key is checked (no early exit on success) so verification time does not reveal
  // which key index matched.
  for (const key of keys) {
    if (timingSafeEqual(given, sign(body, key))) ok = true;
  }
  return ok ? body : null;
}

/**
 * Decodes a cursor token. Returns `null` on ANY malformed, oversized, tampered or unrecognised
 * input — never throws (Validation spec §8's failure contract, applied here). Callers treat `null`
 * as "no usable cursor".
 */
export function decodeCursor(cursor: string): Record<string, unknown> | null {
  if (
    typeof cursor !== 'string' ||
    cursor.length === 0 ||
    cursor.length > MAX_CURSOR_LENGTH
  ) {
    return null;
  }
  const body = verifiedBody(cursor, getApiRuntime().cursorSigningKeys);
  if (body === null || body.length === 0 || !BASE64URL.test(body)) return null;

  let poisoned = false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8'),
      (key, value: unknown) => {
        if (FORBIDDEN_KEYS.has(key)) poisoned = true;
        return value;
      },
    );
  } catch {
    return null;
  }
  if (poisoned || !isPlainObject(parsed)) return null;
  return parsed;
}

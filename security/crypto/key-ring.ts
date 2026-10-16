/**
 * Encryption key ring — Security spec §15.2.
 *
 * Holds the CURRENT key (used for every new `encrypt()`) and the RETIRED keys (kept for
 * `decrypt()` only — never for new encryption). This is what lets a key rotate forward
 * without a flag-day migration of every previously-encrypted record.
 *
 * Populated once at boot by `SecurityModule` from `security.crypto.*` (Config), which has
 * already validated the shapes below. Until configured, the ring is empty and `encrypt()`
 * throws — "present before any encrypt() path is reachable" (§27).
 */
import { SecurityCryptoError } from './crypto.errors';

/** Ciphertext format is `${keyId}:${iv}:${ciphertext}:${authTag}` — `:` must not appear in an id. */
export const KEY_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

const HEX_KEY_RE = /^[0-9a-fA-F]{64}$/;
const BASE64_KEY_RE = /^[A-Za-z0-9+/_-]{43}={0,1}$/; // 32 bytes → 43 chars (+ optional '='), std or url-safe

/**
 * Accepts a 32-byte AES-256 key as 64 hex chars OR 43/44-char base64 / base64url.
 * Anything else throws — notably a passphrase, which is NOT a key (derive one with a KDF
 * and store the result).
 */
export function decodeKeyMaterial(encoded: string): Buffer {
  if (typeof encoded !== 'string') throw new SecurityCryptoError('key material must be a string');
  const v = encoded.trim();
  let key: Buffer | undefined;
  if (HEX_KEY_RE.test(v)) key = Buffer.from(v, 'hex');
  else if (BASE64_KEY_RE.test(v)) key = Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (!key || key.length !== 32) {
    throw new SecurityCryptoError(
      'key material must be exactly 32 bytes, encoded as 64 hex characters or base64 (e.g. `openssl rand -hex 32`)',
    );
  }
  return key;
}

export interface KeyRingEntry {
  readonly id: string;
  readonly key: Buffer;
}

export interface KeyRing {
  readonly current: KeyRingEntry | undefined;
  readonly retired: ReadonlyMap<string, Buffer>;
}

export interface KeyRingInput {
  readonly currentKeyId?: string | undefined;
  readonly currentKeyRef?: string | undefined;
  readonly retiredKeys?: ReadonlyArray<{ readonly id: string; readonly keyRef: string }> | undefined;
}

const EMPTY_RING: KeyRing = Object.freeze({ current: undefined, retired: new Map<string, Buffer>() });
let ring: KeyRing = EMPTY_RING;

export function buildKeyRing(input: KeyRingInput): KeyRing {
  const hasId = input.currentKeyId !== undefined;
  const hasKey = input.currentKeyRef !== undefined;
  if (hasId !== hasKey) {
    throw new SecurityCryptoError('security.crypto.currentKeyId and currentKeyRef must be set together');
  }
  let current: KeyRingEntry | undefined;
  if (hasId && hasKey) {
    const id = input.currentKeyId as string;
    if (!KEY_ID_RE.test(id)) throw new SecurityCryptoError(`invalid current key id "${id}"`);
    current = Object.freeze({ id, key: decodeKeyMaterial(input.currentKeyRef as string) });
  }
  const retired = new Map<string, Buffer>();
  for (const r of input.retiredKeys ?? []) {
    if (!KEY_ID_RE.test(r.id)) throw new SecurityCryptoError(`invalid retired key id "${r.id}"`);
    if (retired.has(r.id) || r.id === current?.id) {
      throw new SecurityCryptoError(`duplicate key id "${r.id}" in the key ring`);
    }
    retired.set(r.id, decodeKeyMaterial(r.keyRef));
  }
  return Object.freeze({ current, retired });
}

export function configureKeyRing(input: KeyRingInput): void {
  ring = buildKeyRing(input);
}

export function getKeyRing(): KeyRing {
  return ring;
}

/** Test utility. */
export function resetKeyRing(): void {
  ring = EMPTY_RING;
}

/**
 * HMAC — Security spec §15.7.
 *
 * No `security.crypto.hmacSecretRef` Config key exists (v4 had one, nothing read it):
 * both functions take `secret` as an explicit argument, so a caller with its own
 * Config-sourced (or any other) secret passes it directly.
 */
import { createHmac } from 'node:crypto';
import { constantTimeEquals } from './compare.util';

const HEX_SHA256_RE = /^[0-9a-f]{64}$/;

function assertSecret(secret: unknown): asserts secret is string {
  if (typeof secret !== 'string' || secret.length === 0) {
    // An empty HMAC key is always a bug (an unset env var), never a valid key.
    throw new TypeError('hmac: secret must be a non-empty string');
  }
}

/** HMAC-SHA256 of `payload`, lower-case hex. */
export function hmacSign(payload: string, secret: string): string {
  assertSecret(secret);
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

/** Constant-time check of a hex HMAC-SHA256 signature. Never throws on a malformed signature. */
export function hmacVerify(payload: string, signature: string, secret: string): boolean {
  assertSecret(secret);
  if (typeof signature !== 'string') return false;
  const candidate = signature.trim().toLowerCase();
  if (!HEX_SHA256_RE.test(candidate)) return false;
  return constantTimeEquals(candidate, hmacSign(payload, secret));
}

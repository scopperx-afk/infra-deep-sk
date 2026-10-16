/**
 * Constant-time comparison — Security spec §15.6.
 *
 * **Every secret comparison in the codebase uses this — never `===`** (enforced by a
 * source-scanning test, boundary.spec.ts, §24).
 *
 * `crypto.timingSafeEqual` alone throws on unequal lengths, which forces callers to
 * length-check first — and that early return leaks the secret's LENGTH through timing.
 * Both operands are therefore first reduced to a fixed-size HMAC-SHA256 digest under a
 * per-process random key; the digests (always 32 bytes) are what get compared. The
 * result is independent of both operands' content AND length, and an attacker cannot
 * precompute digests because the key never leaves this process.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const COMPARE_KEY = randomBytes(32);

const isComparable = (v: unknown): v is string | Buffer =>
  typeof v === 'string' || Buffer.isBuffer(v);

const digest = (v: string | Buffer): Buffer =>
  createHmac('sha256', COMPARE_KEY).update(v).digest();

/** Never throws: a non-string/Buffer operand (a missing header, `undefined`) simply does not match. */
export function constantTimeEquals(a: string | Buffer, b: string | Buffer): boolean {
  if (!isComparable(a) || !isComparable(b)) return false;
  return timingSafeEqual(digest(a), digest(b));
}

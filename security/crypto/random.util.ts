/**
 * Secure randomness — Security spec §15.5. Never `Math.random()` (anti-pattern #11).
 */
import { randomBytes, randomInt as nodeRandomInt } from 'node:crypto';

const MIN_TOKEN_BYTES = 16;
const MAX_TOKEN_BYTES = 1024;
const DEFAULT_TOKEN_BYTES = 32;

/**
 * Cryptographically secure hex token. Default 32 bytes (256 bits → 64 hex chars).
 * Fewer than 16 bytes is rejected: a "token" with under 128 bits of entropy is a
 * brute-forceable identifier, and the caller almost certainly meant something else.
 */
export function randomToken(bytes: number = DEFAULT_TOKEN_BYTES): string {
  if (!Number.isInteger(bytes) || bytes < MIN_TOKEN_BYTES || bytes > MAX_TOKEN_BYTES) {
    throw new RangeError(
      `randomToken(): bytes must be an integer between ${MIN_TOKEN_BYTES} and ${MAX_TOKEN_BYTES}`,
    );
  }
  return randomBytes(bytes).toString('hex');
}

/**
 * Uniformly distributed integer in `[min, max)` — `max` is EXCLUSIVE, matching
 * `crypto.randomInt` (rejection sampling, no modulo bias). Both bounds must be safe
 * integers and `max > min`.
 */
export function randomInt(min: number, max: number): number {
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max <= min) {
    throw new RangeError('randomInt(): min and max must be safe integers with max > min');
  }
  return nodeRandomInt(min, max);
}

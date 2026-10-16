/**
 * Idempotency-Key SHAPE validation — Security spec §18.3.
 *
 * Shape only: the dedup store / response caching is the Idempotency module's (Layer 3)
 * job; this module never owns that store.
 */
import { randomUUID } from 'node:crypto';

/** 16–255 chars from a conservative, header-safe, log-safe alphabet; must start alphanumeric. */
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_\-:.]{15,254}$/;

export function validateIdempotencyKey(key: string): boolean {
  return typeof key === 'string' && IDEMPOTENCY_KEY_RE.test(key);
}

/** A random RFC 4122 v4 UUID — 122 bits of entropy, always passes `validateIdempotencyKey`. */
export function generateIdempotencyKey(): string {
  return randomUUID();
}

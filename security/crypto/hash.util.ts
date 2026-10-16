/**
 * Password / secret hashing — Security spec §15.1. Algorithm PINNED to argon2id, cost
 * parameters fixed in code (§15 preamble: "no lever an attacker or a careless change can
 * pull to downgrade") — deliberately NOT read from Config.
 *
 * ── SPEC-ERRATA E-S2 ────────────────────────────────────────────────────────────────
 * The spec sketches `hash(): string` / `verifyHash(): boolean` (synchronous). argon2id
 * in Node is only available asynchronously (the `argon2` package runs on libuv's thread
 * pool; `crypto.argon2` does not exist before Node 24.7 and this project targets Node 22).
 * A synchronous argon2id call would block the event loop for ~50–100 ms per login, which
 * is exactly what a Layer 1 primitive must never do. Both functions therefore return
 * Promises. The call-sites in the spec's own mapping appendix (§30: `PasswordService`)
 * are already async.
 *
 * Parameters: m = 64 MiB, t = 3, p = 1 — at or above the OWASP Password Storage Cheat
 * Sheet's argon2id minimums (m=19 MiB/t=2/p=1) and RFC 9106's second recommended profile
 * trimmed to p=1 (a server wants one lane per hash, not four threads per login).
 */
import { argon2id, hash as argon2Hash, verify as argon2Verify } from 'argon2';

const ARGON2_OPTIONS = Object.freeze({
  type: argon2id,
  memoryCost: 65_536, // KiB → 64 MiB
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
  saltLength: 16,
});

/** Bound on what is fed to the KDF: an unbounded password field is a CPU/memory DoS lever. */
const MAX_INPUT_BYTES = 4096;

/** argon2id hash, salt embedded in the PHC-format output (`$argon2id$v=19$m=65536,t=3,p=1$…`). */
export async function hash(value: string): Promise<string> {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('hash(): value must be a non-empty string');
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_INPUT_BYTES) {
    throw new RangeError(`hash(): value exceeds ${MAX_INPUT_BYTES} bytes`);
  }
  return argon2Hash(value, ARGON2_OPTIONS);
}

/**
 * Constant-time verification (argon2's own verify). Never throws: a malformed stored
 * hash, an oversized input or a non-string is simply "does not match" — so a corrupt
 * row cannot be distinguished from a wrong password by a thrown error.
 */
export async function verifyHash(storedHash: string, value: string): Promise<boolean> {
  if (typeof storedHash !== 'string' || typeof value !== 'string' || value.length === 0) {
    return false;
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_INPUT_BYTES) return false;
  try {
    return await argon2Verify(storedHash, value);
  } catch {
    return false;
  }
}

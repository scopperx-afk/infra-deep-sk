/**
 * Device fingerprint — Security spec §15.4.
 *
 * Defense-in-depth ONLY — never an authentication primitive: a User-Agent string is
 * attacker-controlled. Fixed algorithm: SHA-256 (not configurable, §15 preamble).
 */
import { createHash } from 'node:crypto';

const MAX_FIELD_CHARS = 512;

const normalize = (v: string | undefined): string =>
  typeof v === 'string' ? v.trim().slice(0, MAX_FIELD_CHARS) : '';

/**
 * Deterministic hex digest of user-agent + device id; `undefined` when neither carries
 * any information (so "no fingerprint" is distinguishable from "the fingerprint of
 * nothing"). Fields are length-capped and NUL-separated, so `("ab","c")` and
 * `("a","bc")` can never collide.
 */
export function computeFingerprint(input: {
  userAgent?: string;
  deviceId?: string;
}): string | undefined {
  const userAgent = normalize(input.userAgent);
  const deviceId = normalize(input.deviceId);
  if (userAgent === '' && deviceId === '') return undefined;
  return createHash('sha256').update(userAgent).update('\u0000').update(deviceId).digest('hex');
}

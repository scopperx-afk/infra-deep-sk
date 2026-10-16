/**
 * Multi-profile JWT (HS256) verification — Security spec §5.1.
 *
 * Security-critical, so it is deliberately small and dependency-free (node:crypto only):
 * HS256 is the ONLY accepted algorithm, which makes a hand-rolled verifier a few dozen
 * auditable lines instead of a general-purpose JOSE library with a wide algorithm surface
 * (the source of the `alg: none` and RS256→HS256 confusion CVEs). SPEC-ERRATA E-S7.
 *
 * Defences, each covered by a test:
 *  - algorithm allow-list: the header's `alg` must be in `opts.algorithms` AND be one this
 *    implementation can verify — `none`, `HS384/512`, `RS*`, `ES*`, `PS*` all fail;
 *  - `crit` header rejected (RFC 7515 §4.1.11: unknown critical extensions must fail);
 *  - the profile is chosen by SIGNATURE, never by unverified claims: every profile's secret
 *    is tried against the signature and the claims are only parsed after one matches;
 *  - constant-time signature compare (timingSafeEqual over equal-length digests);
 *  - `exp` REQUIRED (a non-expiring token is not accepted), `nbf`/`iat` not in the future,
 *    `sub` a non-empty string, `iss`/`aud` enforced when the profile configures them;
 *  - a profile whose secret is shorter than 32 bytes is skipped — never "verifies" with a
 *    trivially guessable key;
 *  - bounded token size, strict base64url alphabet, no padding games.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { systemClock, type Clock } from '../util/clock';
import type {
  JwtClaims,
  TokenFailureReason,
  TokenProfile,
  TokenVerification,
} from './token.types';

export const MAX_TOKEN_LENGTH = 8192;
export const DEFAULT_CLOCK_TOLERANCE_SECONDS = 30;
const MIN_SECRET_BYTES = 32;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const MAX_SUB_LENGTH = 256;

export interface VerifyOptions {
  /** Explicit allow-list — REQUIRED on every call (anti-pattern: a default here is how `none` sneaks in). */
  readonly algorithms: readonly string[];
  /** Skew allowance for exp/nbf/iat. Default 30. */
  readonly clockToleranceSeconds?: number;
  /** Time source. Default: system clock. */
  readonly clock?: Clock;
}

const fail = (failure: TokenFailureReason): TokenVerification => ({ failure });

function decodeJson(segment: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function audienceMatches(claim: unknown, expected: string): boolean {
  if (typeof claim === 'string') return claim === expected;
  return Array.isArray(claim) && claim.some((a) => a === expected);
}

function checkClaims(
  payload: Record<string, unknown>,
  profile: TokenProfile,
  nowSeconds: number,
  tolerance: number,
): TokenFailureReason | undefined {
  const { sub, exp, nbf, iat, iss, aud } = payload;
  if (typeof sub !== 'string' || sub === '' || sub.length > MAX_SUB_LENGTH) return 'invalid_claims';
  if (!isFiniteNumber(exp)) return 'invalid_claims';
  if (exp + tolerance <= nowSeconds) return 'expired';
  if (nbf !== undefined && (!isFiniteNumber(nbf) || nbf - tolerance > nowSeconds)) {
    return isFiniteNumber(nbf) ? 'not_yet_valid' : 'invalid_claims';
  }
  if (iat !== undefined && (!isFiniteNumber(iat) || iat - tolerance > nowSeconds)) return 'invalid_claims';
  if (profile.issuer !== undefined && iss !== profile.issuer) return 'issuer_mismatch';
  if (profile.audience !== undefined && !audienceMatches(aud, profile.audience)) return 'audience_mismatch';
  return undefined;
}

/**
 * Verifies `token` against every profile in order and returns the first that fully accepts
 * it. Never throws (a malformed token is `{ failure: 'malformed' }`).
 */
export function verifyAgainstAnyProfile(
  token: string,
  profiles: readonly TokenProfile[],
  opts: VerifyOptions,
): TokenVerification {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return fail('malformed');
  if (profiles.length === 0) return fail('no_profiles');

  const segments = token.split('.');
  if (segments.length !== 3) return fail('malformed');
  const [headerB64, payloadB64, signatureB64] = segments as [string, string, string];
  if (!B64URL_RE.test(headerB64) || !B64URL_RE.test(payloadB64) || !B64URL_RE.test(signatureB64)) {
    return fail('malformed');
  }

  const header = decodeJson(headerB64);
  if (!header) return fail('malformed');
  if (typeof header['alg'] !== 'string' || !opts.algorithms.includes(header['alg'])) {
    return fail('algorithm_not_allowed');
  }
  if (header['alg'] !== 'HS256') return fail('algorithm_not_allowed'); // the only one implemented
  if (header['crit'] !== undefined) return fail('malformed');

  const signature = Buffer.from(signatureB64, 'base64url');
  if (signature.length !== 32) return fail('bad_signature');

  const signingInput = `${headerB64}.${payloadB64}`;
  const clock = opts.clock ?? systemClock;
  const nowSeconds = Math.floor(clock.nowMs() / 1000);
  const tolerance = opts.clockToleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS;

  let firstFailure: TokenFailureReason = 'bad_signature';
  let payload: Record<string, unknown> | undefined;
  for (const profile of profiles) {
    if (Buffer.byteLength(profile.secretRef, 'utf8') < MIN_SECRET_BYTES) continue;
    const expected = createHmac('sha256', profile.secretRef).update(signingInput).digest();
    if (!timingSafeEqual(expected, signature)) continue;

    // Signature is genuine for THIS profile — only now is the payload parsed.
    payload ??= decodeJson(payloadB64);
    if (!payload) return fail('invalid_claims');
    const claimFailure = checkClaims(payload, profile, nowSeconds, tolerance);
    if (claimFailure === undefined) {
      return { profile, claims: Object.freeze({ ...payload }) as JwtClaims };
    }
    if (firstFailure === 'bad_signature') firstFailure = claimFailure; // report the first genuine rejection
  }
  return fail(firstFailure);
}

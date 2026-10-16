/**
 * Token types — Security spec §5.1. The shapes Realtime's `TokenVerifier` port mirrors
 * (realtime spec §4.1: `VerifiedToken { profile: TokenProfile; claims: JwtClaims }`).
 */

/** The ONLY algorithm accepted — pinned in code, never read from a token header (§5.1). */
export const ALLOWED_ALGORITHMS = ['HS256'] as const;
export type AllowedAlgorithm = (typeof ALLOWED_ALGORITHMS)[number];

/** Mirrors one element of `tokens.profiles` after Config validation/secret resolution. */
export interface TokenProfile {
  readonly name: string;
  /** HS256 verification key (resolved secret). */
  readonly secretRef: string;
  readonly refreshSecretRef?: string | undefined;
  readonly issuer?: string | undefined;
  readonly audience?: string | undefined;
  /** Seconds. */
  readonly accessTtl?: number | undefined;
  readonly refreshTtl?: number | undefined;
}

export interface JwtClaims {
  /** Subject — becomes `AuthPrincipal.id`. Always a non-empty string on a verified token. */
  readonly sub: string;
  readonly exp: number;
  readonly iss?: string;
  readonly aud?: string | readonly string[];
  readonly nbf?: number;
  readonly iat?: number;
  readonly jti?: string;
  readonly [claim: string]: unknown;
}

/** Why a token was rejected — for DEBUG logging only; never sent to the client (no oracle). */
export type TokenFailureReason =
  | 'malformed'
  | 'algorithm_not_allowed'
  | 'bad_signature'
  | 'invalid_claims'
  | 'expired'
  | 'not_yet_valid'
  | 'issuer_mismatch'
  | 'audience_mismatch'
  | 'no_profiles';

export type TokenVerification =
  | { readonly profile: TokenProfile; readonly claims: JwtClaims; readonly failure?: undefined }
  | { readonly profile?: undefined; readonly claims?: undefined; readonly failure: TokenFailureReason };

export interface VerifiedToken {
  readonly profile: TokenProfile;
  readonly claims: JwtClaims;
}

/** Realtime spec §4.1 contract: returns `null` on ANY failure, NEVER throws. */
export interface TokenVerifier {
  verify(token: string): VerifiedToken | null;
}

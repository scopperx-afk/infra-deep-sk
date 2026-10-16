/**
 * security/index.ts — the ONLY public surface of the Security module (spec §22), mirroring
 * config/index.ts's, logger/index.ts's and http/index.ts's own role. Everything else is
 * unreachable from outside `security/`, enforced by the same ESLint boundary rule its
 * siblings use.
 *
 * No rate-limit exports (§7 — Resilience's) and no CORS exports (§10 — HTTP's).
 *
 * Plain functions (§13/§15/§16 utilities) are importable by ANY sibling without importing
 * `SecurityModule` — the pattern HTTP's `WebhookVerificationGuard` already uses
 * (`import { verifySignature } from '../security'`).
 */

// ── Module ───────────────────────────────────────────────────────────────────
export { SecurityModule } from './security.module';
export type { PortOverride, SecurityModuleOptions } from './security.module';

// ── Identity & authorization (§5, §6) ────────────────────────────────────────
export { AuthGuard } from './guards/auth.guard';
export { Public, IS_PUBLIC_KEY } from './decorators/public.decorator';
export { AbstractRoleGuard } from './guards/abstract-role.guard';
export { CsrfGuard } from './guards/csrf.guard';
export type { AuthPrincipal } from './principal/auth-principal.port';
export type { ProfileValidator, ProfileValidatorRegistry } from './principal/profile-validator.port';
export { DefaultProfileValidator } from './principal/default-profile.validator';
export { PROFILE_VALIDATORS } from './security.tokens';

// ── Token verification (§5.1; consumed by Realtime's TOKEN_VERIFIER, realtime spec §4.1) ──
export { createTokenVerifier } from './token/token-verifier.factory';
export { verifyAgainstAnyProfile } from './token/jwt.util';
export { ALLOWED_ALGORITHMS } from './token/token.types';
export type {
  JwtClaims,
  TokenProfile,
  TokenVerifier,
  VerifiedToken,
  TokenVerification,
  TokenFailureReason,
} from './token/token.types';

// ── Audit, alerts, anomaly, protocol, distributed (§17–§20) ──────────────────
export { AuditLog } from './decorators/audit-log.decorator';
export type { AuditMetadata } from './decorators/audit-log.decorator';
export type { SecurityAlert, SecurityAlertEmitter, AlertSeverity } from './alerts/security-alert.port';
export { LoggerAlertEmitter } from './alerts/logger-alert.emitter';
export { SECURITY_ALERT_EMITTER } from './security.tokens';
export type { AnomalyDetector } from './anomaly/anomaly-detector.port';
export { InMemoryAnomalyDetector } from './anomaly/in-memory-anomaly.detector';
export { ANOMALY_DETECTOR } from './security.tokens';
export type { ReplayProtectionStore } from './protocol/replay-protection.port';
export { InMemoryReplayProtectionStore } from './protocol/in-memory-replay-protection.store';
export { REPLAY_PROTECTION_STORE } from './security.tokens';
export type { CacheInvalidationBus } from './cache/cache-invalidation-bus.port';
export { InMemoryCacheInvalidationBus } from './cache/in-memory-cache-invalidation.bus';
export { CACHE_INVALIDATION_BUS } from './security.tokens';
export { validateIdempotencyKey, generateIdempotencyKey } from './protocol/idempotency-key.util';

// ── Crypto primitives (§15) ──────────────────────────────────────────────────
export { hash, verifyHash } from './crypto/hash.util';
export { encrypt, decrypt } from './crypto/encrypt.util';
export { verifySignature } from './crypto/signature.util';
export type { RawRequest, VerifySignatureOptions } from './crypto/signature.util';
export { computeFingerprint } from './crypto/fingerprint.util';
export { randomToken, randomInt } from './crypto/random.util';
export { constantTimeEquals } from './crypto/compare.util';
export { hmacSign, hmacVerify } from './crypto/hmac.util';

// ── Sanitization (§13) & injection prevention (§14) ──────────────────────────
export {
  sanitizeHtml,
  sanitizeMarkdown,
  sanitizeUrl,
  isSsrfSafeUrl,
  sanitizePathSegment,
  isPathWithin,
  sanitizeHeaderValue,
  normalizeUnicode,
  stripInvisibleChars,
  sanitizeFilename,
} from './sanitize';
export type { HtmlSanitizeProfile, SanitizeFilenameOptions, SanitizeUrlOptions } from './sanitize';
export {
  isPrototypeSafe,
  safeMerge,
  sanitizeObjectKeys,
  isRegexSafe,
  safeRegex,
  checkJsonDepth,
  MAX_JSON_DEPTH,
  createSafeXmlParser,
} from './injection';

// ── Network, transport, cookies, headers (§8, §9, §11, §12, §16) ─────────────
export { getClientIp } from './ip/ip.utils'; // no isIpMismatch (v5 — §16.1)
export { isIpAllowed, createIpFilterMiddleware, configureTrustProxy } from './network';
export type { IpPolicy } from './network';
export { setSecureCookie, clearSecureCookie, setHostCookie, setSecurePrefixedCookie } from './cookies/secure-cookie.util';
export type { SecureCookieOptions } from './cookies/secure-cookie.util';
export { generateNonce, getCspNonce } from './headers/csp-nonce.util';
export { CsrfTokenMiddleware, generateCsrfToken } from './csrf/csrf-token.middleware';

// ── Malware scanning (§19) ───────────────────────────────────────────────────
export { scanForMalware } from './scan/malware.util';
export type { MalwareScanResult } from './scan/malware.util';

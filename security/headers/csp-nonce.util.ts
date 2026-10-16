/**
 * CSP nonce — Security spec §9.2.
 *
 * `SecurityHeadersMiddleware` generates one nonce per request (when
 * `security.headers.csp.useNonce` is on), puts it in the CSP header and runs the rest of
 * the request inside this AsyncLocalStorage, so any code that renders HTML for THAT request
 * (SSR, an HTML e-mail body) can read it back with `getCspNonce()` and stamp
 * `<script nonce="…">`. It is also mirrored on `res.locals.cspNonce` for template engines.
 *
 * 128 bits from the CSPRNG, base64 — W3C CSP3 requires ≥ 128 bits of entropy. A nonce must
 * never be reused across requests (it would turn the CSP into an allowlist the attacker has
 * already seen); a fresh one per request is what makes it unguessable.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

const nonceStorage = new AsyncLocalStorage<{ readonly nonce: string }>();

export function generateNonce(): string {
  return randomBytes(16).toString('base64');
}

/** The current request's nonce, or `undefined` outside a request / when nonces are disabled. */
export function getCspNonce(): string | undefined {
  return nonceStorage.getStore()?.nonce;
}

/** @internal — used by `SecurityHeadersMiddleware` only; deliberately not exported from index.ts. */
export function runWithCspNonce<T>(nonce: string, fn: () => T): T {
  return nonceStorage.run({ nonce }, fn);
}

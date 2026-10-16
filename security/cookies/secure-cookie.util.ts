/**
 * Secure cookie helpers — Security spec §11.
 *
 * Defaults (secure by default, SPEC-ERRATA E-S1 for where the Config-driven ones come from):
 * `HttpOnly: true`, `Secure` / `SameSite` from `security.cookies.default*` (restrictive
 * until `SecurityModule` pushes the real values), `Path=/`. Built on Express's own
 * `res.cookie()` serialiser (`cookie` package: validated name/value, percent-encoded
 * value) — no hand-rolled `Set-Cookie` string.
 *
 * `maxAge` is in SECONDS (the unit of the `Max-Age` attribute itself, not Express's
 * milliseconds — one fewer way to ship a cookie that lives 1000× longer than intended).
 * Capped at 400 days, the maximum browsers honour (RFC 6265bis §5.5).
 *
 * Cookie-name prefixes (browser-enforced, defence-in-depth against cookie tossing):
 *  - `__Host-`   Secure + Path=/ + NO Domain      → `setHostCookie` (adds the prefix)
 *  - `__Secure-` Secure                           → `setSecurePrefixedCookie` (adds the prefix)
 * Whatever the entry point, a name that already carries a prefix has its constraints
 * ENFORCED here: a violating call throws instead of emitting a cookie the browser will
 * silently drop.
 */
import type { Response } from 'express';
import { getSecurityRuntime, type SameSite } from '../runtime/security-runtime';

export interface SecureCookieOptions {
  /** Default `true`. */
  readonly httpOnly?: boolean;
  /** Default: `security.cookies.defaultSecure`. */
  readonly secure?: boolean;
  /** Default: `security.cookies.defaultSameSite`. */
  readonly sameSite?: SameSite;
  /** Seconds. Omitted ⇒ session cookie. */
  readonly maxAge?: number;
  /** Default `/`. */
  readonly path?: string;
  readonly domain?: string;
}

const HOST_PREFIX = '__Host-';
const SECURE_PREFIX = '__Secure-';
const COOKIE_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const DOMAIN_RE = /^\.?[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const PATH_RE = /^\/[\u0021-\u003A\u003C-\u007E]*$/; // no ';', no whitespace/control
const MAX_AGE_CEILING_SECONDS = 34_560_000; // 400 days

interface ResolvedCookie {
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSite: SameSite;
  readonly maxAgeMs: number | undefined;
  readonly path: string;
  readonly domain: string | undefined;
}

function resolve(name: string, options: SecureCookieOptions): ResolvedCookie {
  if (typeof name !== 'string' || !COOKIE_NAME_RE.test(name)) {
    throw new TypeError('cookie: invalid cookie name');
  }
  const defaults = getSecurityRuntime().cookies;
  const path = options.path ?? '/';
  if (!PATH_RE.test(path)) throw new TypeError('cookie: invalid path');
  if (options.domain !== undefined && !DOMAIN_RE.test(options.domain)) throw new TypeError('cookie: invalid domain');
  if (options.maxAge !== undefined) {
    if (!Number.isFinite(options.maxAge) || options.maxAge < 0 || options.maxAge > MAX_AGE_CEILING_SECONDS) {
      throw new RangeError(`cookie: maxAge is in SECONDS and must be between 0 and ${MAX_AGE_CEILING_SECONDS}`);
    }
  }
  const sameSite = options.sameSite ?? defaults.defaultSameSite;
  const secure = options.secure ?? defaults.defaultSecure;

  if (sameSite === 'none' && !secure) throw new TypeError('cookie: SameSite=None requires Secure');
  if (name.startsWith(HOST_PREFIX)) {
    if (!secure) throw new TypeError(`cookie: "${HOST_PREFIX}" cookies must be Secure`);
    if (options.domain !== undefined) throw new TypeError(`cookie: "${HOST_PREFIX}" cookies must not set a Domain`);
    if (path !== '/') throw new TypeError(`cookie: "${HOST_PREFIX}" cookies must have Path=/`);
  } else if (name.startsWith(SECURE_PREFIX) && !secure) {
    throw new TypeError(`cookie: "${SECURE_PREFIX}" cookies must be Secure`);
  }
  return {
    httpOnly: options.httpOnly ?? true,
    secure,
    sameSite,
    maxAgeMs: options.maxAge === undefined ? undefined : Math.floor(options.maxAge) * 1000,
    path,
    domain: options.domain,
  };
}

export function setSecureCookie(res: Response, name: string, value: string, options: SecureCookieOptions = {}): void {
  const c = resolve(name, options);
  res.cookie(name, value, {
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite,
    path: c.path,
    ...(c.domain !== undefined ? { domain: c.domain } : {}),
    ...(c.maxAgeMs !== undefined ? { maxAge: c.maxAgeMs } : {}),
  });
}

/**
 * Clears a cookie. `path`/`domain` MUST match those it was set with (the browser keys a
 * cookie on name+domain+path). Prefixed names are cleared with `Secure` (browsers refuse a
 * deleting `Set-Cookie` for `__Host-`/`__Secure-` names that lacks it).
 */
export function clearSecureCookie(
  res: Response,
  name: string,
  options: Pick<SecureCookieOptions, 'path' | 'domain'> = {},
): void {
  if (typeof name !== 'string' || !COOKIE_NAME_RE.test(name)) throw new TypeError('cookie: invalid cookie name');
  const path = options.path ?? '/';
  if (!PATH_RE.test(path)) throw new TypeError('cookie: invalid path');
  if (options.domain !== undefined && !DOMAIN_RE.test(options.domain)) throw new TypeError('cookie: invalid domain');
  const prefixed = name.startsWith(HOST_PREFIX) || name.startsWith(SECURE_PREFIX);
  if (name.startsWith(HOST_PREFIX) && (options.domain !== undefined || path !== '/')) {
    throw new TypeError(`cookie: "${HOST_PREFIX}" cookies have no Domain and Path=/`);
  }
  res.clearCookie(name, {
    path,
    ...(options.domain !== undefined ? { domain: options.domain } : {}),
    ...(prefixed ? { secure: true } : {}),
  });
}

const withPrefix = (prefix: string, name: string): string => (name.startsWith(prefix) ? name : `${prefix}${name}`);

/** `__Host-<name>`: Secure, Path=/, no Domain. A `domain`, a non-`/` path, or `secure: false` THROWS. */
export function setHostCookie(res: Response, name: string, value: string, options: SecureCookieOptions = {}): void {
  setSecureCookie(res, withPrefix(HOST_PREFIX, name), value, { ...options, secure: options.secure ?? true });
}

/** `__Secure-<name>`: Secure. `secure: false` THROWS. */
export function setSecurePrefixedCookie(res: Response, name: string, value: string, options: SecureCookieOptions = {}): void {
  setSecureCookie(res, withPrefix(SECURE_PREFIX, name), value, { ...options, secure: options.secure ?? true });
}

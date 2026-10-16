/**
 * Request cookie reading — SPEC-ERRATA E-S8.
 *
 * The spec's `CsrfGuard`/`CsrfTokenMiddleware` read `req.cookies`, which exists only if a
 * `cookie-parser` middleware ran. HTTP's `platform.adapter.ts` installs none (and Security
 * may not edit it), so on the real pipeline `req.cookies` is `undefined` and the sketch's
 * guard would reject EVERY request. These helpers use `req.cookies` when a parser did run
 * and otherwise parse the `Cookie` header themselves — safely:
 *  - header length and cookie count are bounded;
 *  - the FIRST occurrence of a name wins (a later duplicate cannot override it);
 *  - a malformed percent-escape leaves the raw value instead of throwing;
 *  - names are RFC 7230 tokens only; results live in a `Map`, so a cookie named
 *    `__proto__` is just a key.
 */
const MAX_COOKIE_HEADER_LENGTH = 8192;
const MAX_COOKIES = 100;
const COOKIE_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

export function parseCookieHeader(header: string | undefined): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  if (typeof header !== 'string' || header === '' || header.length > MAX_COOKIE_HEADER_LENGTH) return out;
  for (const pair of header.split(';')) {
    if (out.size >= MAX_COOKIES) break;
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    if (!COOKIE_NAME_RE.test(name) || out.has(name)) continue;
    let value = pair.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      value = decodeURIComponent(value);
    } catch {
      /* keep the raw value */
    }
    out.set(name, value);
  }
  return out;
}

export interface CookieCarrier {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly cookies?: unknown;
}

export function readCookie(req: CookieCarrier, name: string): string | undefined {
  const parsed = req.cookies;
  if (typeof parsed === 'object' && parsed !== null && Object.prototype.hasOwnProperty.call(parsed, name)) {
    const value = (parsed as Record<string, unknown>)[name];
    if (typeof value === 'string') return value;
  }
  const header = req.headers['cookie'];
  return parseCookieHeader(typeof header === 'string' ? header : undefined).get(name);
}

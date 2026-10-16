/**
 * `@Deprecated()` — API Infrastructure spec §8.3.
 *
 * Marks a handler (or a whole controller) deprecated; `DeprecationInterceptor` then sets the
 * standard response headers. Everything is validated and PRECOMPUTED here, at decoration time
 * (boot), so a malformed `sunsetAt` fails startup instead of producing a bad header at 3 a.m.
 *
 * Deviation E-A3 (header formats). The spec says "`Sunset: <ISO-8601 date>`" and cites RFC 8594 for
 * both `Deprecation` and `Sunset`. RFC 8594 defines only `Sunset`, and its value is an HTTP-date
 * (`Sat, 31 Dec 2026 23:59:59 GMT`) — an ISO string in that header is ignored by conforming
 * clients, which defeats the point. `Deprecation` is RFC 9745: a structured-field date
 * (`@1688169599`). So:
 *   • `sunsetAt`     (ISO-8601, input) → `Sunset: <HTTP-date>`
 *   • `deprecatedAt` (ISO-8601, OPTIONAL) → `Deprecation: @<unix-seconds>`
 *   • no `deprecatedAt` → `Deprecation: true` — the spec's own value, kept as the fallback because
 *     "this endpoint is deprecated, since an unknown moment" is a legitimate thing to say, and
 *     many existing clients still recognise `true`.
 *   • `successorUrl` → `Link: <url>; rel="successor-version"` (RFC 8288). The URL is checked for
 *     characters that would break out of the `<...>` or the header line (CR/LF injection).
 */
import { SetMetadata } from '@nestjs/common';

export interface DeprecationOptions {
  /** ISO-8601 instant at which the endpoint will be removed. */
  readonly sunsetAt: string;
  /** ISO-8601 instant at which it became deprecated (enables the RFC 9745 date form). */
  readonly deprecatedAt?: string;
  /** URL of the replacement endpoint, when one exists. */
  readonly successorUrl?: string;
}

export interface PreparedDeprecationHeaders {
  readonly Deprecation: string;
  readonly Sunset: string;
  readonly Link?: string;
}

export const DEPRECATION_KEY = 'api:deprecation';

const SAFE_URL = /^[^\s<>"\\\u0000-\u001f\u007f]+$/;

function parseInstant(label: string, value: string): Date {
  const d = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(d.getTime())) {
    throw new TypeError(`@Deprecated: ${label} must be an ISO-8601 date, got ${JSON.stringify(value)}`);
  }
  return d;
}

export function prepareDeprecationHeaders(options: DeprecationOptions): PreparedDeprecationHeaders {
  const sunset = parseInstant('sunsetAt', options.sunsetAt);
  const deprecation =
    options.deprecatedAt === undefined
      ? 'true'
      : `@${Math.floor(parseInstant('deprecatedAt', options.deprecatedAt).getTime() / 1000)}`;
  let link: string | undefined;
  if (options.successorUrl !== undefined) {
    if (!SAFE_URL.test(options.successorUrl)) {
      throw new TypeError('@Deprecated: successorUrl contains characters that are not allowed in a Link header');
    }
    link = `<${options.successorUrl}>; rel="successor-version"`;
  }
  return Object.freeze({
    Deprecation: deprecation,
    Sunset: sunset.toUTCString(),
    ...(link !== undefined ? { Link: link } : {}),
  });
}

export const Deprecated = (options: DeprecationOptions) =>
  SetMetadata(DEPRECATION_KEY, prepareDeprecationHeaders(options));

/**
 * HTTP header value sanitiser — Security spec §13 (CRLF injection / response splitting).
 *
 * Removes every character that can terminate or split a header line: CR, LF, NUL and the
 * other C0 controls (HTAB is kept — it is legal inside a field value), DEL, NEL and the
 * Unicode line/paragraph separators. Node's own `setHeader` already throws on CR/LF; this
 * exists for values that are logged, forwarded to a proxy, or written by a lower layer
 * that does not.
 */
const HEADER_UNSAFE_RE = /[\u0000-\u0008\u000A-\u001F\u007F\u0085\u2028\u2029]/g;

export function sanitizeHeaderValue(value: string): string {
  return String(value).replace(HEADER_UNSAFE_RE, '');
}

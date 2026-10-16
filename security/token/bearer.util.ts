/**
 * `Authorization: Bearer <token>` extraction — Security spec §5.1.
 *
 * Header only. A token in a query string lands in access logs, proxies' logs and the
 * `Referer` header; a cookie is ambient credentials (CSRF). Neither is accepted here.
 * Anything ambiguous (a duplicated header, a non-Bearer scheme, whitespace tricks, an
 * oversize value) yields `undefined`, which the guard answers with the same generic 401.
 */
import { MAX_TOKEN_LENGTH } from './jwt.util';

const BEARER_RE = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i;

export function extractBearerToken(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): string | undefined {
  const value = headers['authorization'];
  if (typeof value !== 'string' || value.length > MAX_TOKEN_LENGTH + 16) return undefined;
  return BEARER_RE.exec(value)?.[1];
}

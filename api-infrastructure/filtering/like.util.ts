/**
 * `escapeLikePattern()` — E-A9. A `like` filter's value is user text, not a pattern: a client
 * sending `?nameLike=100%25` means the literal "100%", but `%` and `_` are SQL `LIKE` wildcards.
 * Applying a `ParsedFilter` of operator `like` to a database query is the domain's job (§6.3);
 * this is the one escaping rule every domain would otherwise reimplement slightly differently.
 *
 *   `WHERE name ILIKE '%' || $1 || '%' ESCAPE '\'`   with   $1 = escapeLikePattern(filter.value)
 */
export function escapeLikePattern(value: string, escapeChar = '\\'): string {
  if (escapeChar.length !== 1) {
    throw new TypeError('escapeLikePattern: escapeChar must be a single character');
  }
  let out = '';
  for (const ch of value) {
    out += ch === '%' || ch === '_' || ch === escapeChar ? escapeChar + ch : ch;
  }
  return out;
}

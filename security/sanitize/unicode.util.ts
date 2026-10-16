/**
 * Unicode hygiene — Security spec §13 (homoglyph / RTL-override attacks).
 *
 *  - `stripInvisibleChars` removes what a human reader cannot see but a parser can act on:
 *    C0/C1 control characters (except TAB, LF, CR), zero-width and joiner characters,
 *    BIDI embedding/override/isolate controls (the "Trojan Source" class: U+202A–202E,
 *    U+2066–2069), the BOM, soft hyphen, Unicode line/paragraph separators, and the
 *    invisible TAG block U+E0000–E007F (used to smuggle hidden instructions/payloads).
 *    The emoji presentation selector U+FE0F is kept — stripping it breaks emoji.
 *  - `normalizeUnicode` = strip → NFKC → strip. NFKC folds compatibility forms (full-width
 *    Latin, ligatures, superscripts) to their canonical equivalents, which defuses the
 *    full-width-`＜script＞` class. It does NOT map cross-script confusables (Cyrillic `а`
 *    vs Latin `a`) — that needs a confusables table and a policy about which scripts a
 *    given field may mix, which is a domain decision, not a generic primitive.
 */
const INVISIBLE_RE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0E\uFEFF\uFFA0\uFFF9-\uFFFB]|[\u{E0000}-\u{E007F}]|[\u{1BCA0}-\u{1BCA3}]|[\u{1D173}-\u{1D17A}]/gu;

export function stripInvisibleChars(input: string): string {
  return String(input).replace(INVISIBLE_RE, '');
}

export function normalizeUnicode(input: string): string {
  return stripInvisibleChars(stripInvisibleChars(String(input)).normalize('NFKC'));
}

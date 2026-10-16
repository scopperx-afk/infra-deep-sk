/**
 * Ambiguous-`#` detection for `.env` files — Config spec §5.2 ("Parsing rules").
 *
 * PROBLEM. dotenv (verified on the pinned 16.6.1) treats the FIRST `#` in an UNQUOTED value as
 * the start of a comment and silently drops the rest of the line — with or without a space in
 * front of it:
 *
 *     DB__URL=postgres://user:pa#ss@host/db   →  "postgres://user:pa"
 *     LINK=http://h/page#frag                 →  "http://h/page"
 *     COLOR=#fff                              →  ""
 *
 * §5.2 says inline comments are NOT supported precisely so that "a trailing `#` silently
 * becomes part of a URL or secret" can't happen. dotenv's behavior is the mirror image of that
 * (the `#` and everything after it silently VANISHES), which is worse for secrets: the value
 * that reaches the schema is a valid-looking truncation.
 *
 * DECISION (see SPEC-ERRATA.md E-5). Rather than depend on which dotenv version happens to be
 * installed, an unquoted value containing `#` is REJECTED with a precise message. The fix is
 * trivial and unambiguous for the author: quote the value, or move the comment to its own line.
 * Quoted values are untouched (a `#` inside quotes is literal, and a comment after the closing
 * quote is unambiguous), and comment-only lines are untouched.
 *
 * IMPLEMENTATION. The regex below is dotenv 16's own LINE regex, so this tokenizes the file
 * exactly the way dotenv will — including multi-line quoted values — with no second parser of
 * our own to get wrong. It is coupled to the pinned dotenv version on purpose; the pinning test
 * in sources.spec.ts fails if a dotenv bump changes the behavior this relies on.
 */
const DOTENV_LINE =
  /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;

// `[^\S\n]` = any whitespace EXCEPT newline. Using plain `\s` here was a bug:
// for an EMPTY value (`FOO=`), the greedy `\s*` after `=` would eat the
// newline and pull the *next* line's comment into the match, so a legit
// empty value followed by a comment got flagged as "unquoted value contains #".
const AFTER_SEPARATOR =
  /^\s*(?:export\s+)?[\w.-]+(?:[^\S\n]*=[^\S\n]*|:[^\S\n]+)/;
const STARTS_QUOTED = /^\s*['"`]/;

export interface AmbiguousHash {
  /** Variable NAME only — never the value (it may be a secret). */
  key: string;
  line: number;
}

export function findAmbiguousInlineComments(source: string): AmbiguousHash[] {
  const text = source.replace(/\r\n?/g, '\n'); // dotenv normalizes line endings before matching
  const found: AmbiguousHash[] = [];
  for (const match of text.matchAll(DOTENV_LINE)) {
    const [full, key] = match;
    const rest = full.replace(AFTER_SEPARATOR, '');
    if (STARTS_QUOTED.test(rest)) continue; // quoted: `#` inside is literal
    // dotenv's trailing `\s*(?:#.*)?` can swallow a comment-only line that FOLLOWS this
    // assignment — an unquoted value never spans lines, so only the first line is ours.
    if (!rest.split('\n')[0].includes('#')) continue;
    // The match may start with blank lines (`\s*`); the line that counts is the KEY's.
    const lead = /^\s*(?:export\s+)?/.exec(full)![0].length;
    const line = text.slice(0, (match.index ?? 0) + lead).split('\n').length;
    found.push({ key, line });
  }
  return found;
}

export function describeAmbiguousHashes(
  fileName: string,
  hits: readonly AmbiguousHash[],
): string {
  return (
    hits
      .map(
        (h) =>
          `${fileName} line ${h.line} (${h.key}): unquoted value contains "#"`,
      )
      .join('; ') +
    ' — dotenv would silently drop everything from the "#" on (a password or URL fragment would be truncated). ' +
    'Quote the value ("…") or put the comment on its own line; inline comments are not supported (spec §5.2)'
  );
}

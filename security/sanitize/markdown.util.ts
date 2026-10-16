/**
 * Markdown SOURCE sanitiser — Security spec §13.
 *
 * Rewrites the Markdown text so that a downstream renderer cannot be made to emit active
 * content, WITHOUT parsing Markdown into HTML (no renderer dependency — rendering is the
 * consumer's job, and it should still escape; this is defence in depth, not a substitute):
 *
 *  1. invisible / control / BIDI characters stripped (`stripInvisibleChars`);
 *  2. raw HTML neutralised — every `<` that opens a tag, comment, declaration or
 *     processing instruction becomes `&lt;` (so `<script>`, `<img onerror=…>`, `<!-- -->`
 *     render as visible text); well-formed http(s)/mailto autolinks (`<https://x.y>`) survive;
 *  3. link / image / reference-definition destinations are checked: anything that is not
 *     http(s)/mailto/relative (`javascript:`, `data:`, `vbscript:`, entity- or
 *     whitespace-obfuscated variants of them) is replaced by `#`.
 *
 * Fenced and inline code are passed through untouched (a renderer escapes them).
 */
import { stripInvisibleChars } from './unicode.util';

const PLACEHOLDER = '\u0000';
const SAFE_AUTOLINK_RE = /<((?:https?:\/\/|mailto:)[^\s<>\u0000]+)>/gi;
const FENCED_CODE_RE = /(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\2[`~]*[^\n]*(?=\n|$)|$)/g;
const INLINE_CODE_RE = /(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g;
const REFERENCE_DEF_RE = /^(\s{0,3}\[[^\]\n]+\]:[ \t]*)(<[^>\n]*>|\S+)/gm;
const ENTITY_RE = /&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i;

/** http(s)/mailto, or a relative reference with no scheme and no entity that could hide one. */
function isSafeDestination(raw: string): boolean {
  const dest = raw.replace(/^<|>$/g, '');
  const compact = dest.replace(/[\s\u0000-\u001F\u007F]+/g, '').toLowerCase();
  if (/^(?:https?:\/\/|mailto:)/.test(compact)) return true;
  if (ENTITY_RE.test(compact) || compact.includes('\\')) return false;
  const firstDelimiter = compact.search(/[/?#]/);
  const head = firstDelimiter === -1 ? compact : compact.slice(0, firstDelimiter);
  return !head.includes(':'); // a colon before the first / ? # is a scheme
}

/** Rewrites inline `](dest …)` destinations, honouring one level of balanced parentheses. */
function rewriteInlineDestinations(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('](', i);
    if (open === -1) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, open + 2);
    let j = open + 2;
    while (j < text.length && /[ \t]/.test(text[j] as string)) j++;
    let end = j;
    if (text[j] === '<') {
      const close = text.indexOf('>', j);
      end = close === -1 ? text.length : close + 1;
    } else {
      let depth = 0;
      while (end < text.length) {
        const ch = text[end] as string;
        if (/\s/.test(ch)) break;
        if (ch === '(') depth++;
        else if (ch === ')') {
          if (depth === 0) break;
          depth--;
        }
        end++;
      }
    }
    // Whitespace INSIDE the parentheses is how `java<TAB>script:` hides from a destination
    // check that stops at the first space: CommonMark treats it as plain text, but a lenient
    // renderer may emit it as an href, and browsers strip TAB/LF inside a URL. So the whole
    // parenthesised run (minus a quoted title) is checked with whitespace removed.
    let closeIdx = -1;
    let depth = 0;
    for (let k = j; k < text.length; k++) {
      const ch = text[k] as string;
      if (ch === '\n') break;
      if (ch === '(') depth++;
      else if (ch === ')') {
        if (depth === 0) {
          closeIdx = k;
          break;
        }
        depth--;
      }
    }
    if (closeIdx !== -1) {
      const inside = text.slice(j, closeIdx);
      if (!isSafeDestination(inside.split(/["']/)[0] ?? '')) {
        out += `${text.slice(open + 2, j)}#`;
        i = closeIdx; // the ")" is emitted by the next iteration
        continue;
      }
    }
    const destination = text.slice(j, end);
    out += text.slice(open + 2, j) + (destination === '' || isSafeDestination(destination) ? destination : '#');
    i = end;
  }
  return out;
}

export function sanitizeMarkdown(input: string): string {
  if (typeof input !== 'string') return '';
  let text = stripInvisibleChars(input); // also guarantees no PLACEHOLDER in the source

  const stash: string[] = [];
  const protect = (match: string): string => {
    stash.push(match);
    return `${PLACEHOLDER}${stash.length - 1}${PLACEHOLDER}`;
  };

  text = text.replace(FENCED_CODE_RE, protect).replace(INLINE_CODE_RE, protect);
  text = text.replace(SAFE_AUTOLINK_RE, protect);
  text = text.replace(/<(?=[A-Za-z/!?])/g, '&lt;');
  text = rewriteInlineDestinations(text);
  text = text.replace(REFERENCE_DEF_RE, (_m, prefix: string, dest: string) =>
    `${prefix}${isSafeDestination(dest) ? dest : '#'}`,
  );

  return text.replace(new RegExp(`${PLACEHOLDER}(\\d+)${PLACEHOLDER}`, 'g'), (_m, n: string) => stash[Number(n)] ?? '');
}

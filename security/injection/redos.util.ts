/**
 * ReDoS (catastrophic-backtracking) defence — Security spec §14.
 *
 * `isRegexSafe` is for validating a PATTERN that is not fully under the developer's control
 * (an admin-defined filter, a user-supplied search regex) — it is a pre-flight check, not
 * something to run per request: it can block the event loop for up to `probes × timeoutMs`.
 *
 * Two independent layers (either one flags the pattern):
 *  1. STATIC — a structural scan for the classic exponential shapes: a quantified group that
 *     itself contains an unbounded quantifier (`(a+)+`, `(a*)*`, `(\w+\s?)*`, `(.*a){5,}`),
 *     and a quantified alternation whose branches are identical or share a prefix
 *     (`(a|a)*`, `(a|ab)+`).
 *  2. DYNAMIC — the pattern is executed inside a `vm` context with a hard `timeout` against
 *     adversarial probes (long runs of each literal/class character in the pattern followed
 *     by a guaranteed-mismatch tail). V8 aborts the match when the watchdog fires, so a
 *     genuinely catastrophic pattern costs `timeoutMs`, not forever.
 *
 * No heuristic can prove a regex safe — this reduces risk, it does not eliminate it. For
 * untrusted patterns the robust answer is a linear-time engine (RE2).
 */
import vm from 'node:vm';
import { getSecurityRuntime } from '../runtime/security-runtime';

const MAX_PATTERN_LENGTH = 1000;
const PROBE_LENGTH = 40;
const MAX_PROBES = 6;
const FALLBACK_PROBE_CHARS = ['a', '0', ' ', 'x'];

/** Static scan — true if the pattern source has a known-dangerous structure. */
export function hasDangerousStructure(source: string): boolean {
  // Walk the source tracking, per open group, whether it contains an unbounded quantifier
  // or an alternation; when a group closes and is itself followed by an unbounded
  // quantifier, that is the nested-quantifier shape.
  interface Frame { hasUnbounded: boolean; branches: string[]; current: string }
  const stack: Frame[] = [];
  let top: Frame = { hasUnbounded: false, branches: [], current: '' };
  let inClass = false;

  const isUnboundedQuantAt = (i: number): boolean => {
    const c = source[i];
    if (c === '*' || c === '+') return true;
    if (c === '{') {
      const m = /^\{(\d+),(\d*)\}/.exec(source.slice(i));
      return !!m && (m[2] === '' || Number(m[2]) - Number(m[1]) > 1000);
    }
    return false;
  };

  for (let i = 0; i < source.length; i++) {
    const ch = source[i] as string;
    if (ch === '\\') {
      top.current += source.slice(i, i + 2);
      i++;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      top.current += ch;
      continue;
    }
    if (ch === '[') { inClass = true; top.current += ch; continue; }
    if (ch === '(') {
      stack.push(top);
      top = { hasUnbounded: false, branches: [], current: '' };
      if (source.startsWith('?:', i + 1)) i += 2;
      else if (source.startsWith('?=', i + 1) || source.startsWith('?!', i + 1)) i += 2;
      else if (source.startsWith('?<=', i + 1) || source.startsWith('?<!', i + 1)) i += 3;
      else if (source.startsWith('?<', i + 1)) { const close = source.indexOf('>', i); if (close !== -1) i = close; }
      continue;
    }
    if (ch === '|') {
      top.branches.push(top.current);
      top.current = '';
      continue;
    }
    if (ch === ')') {
      const closed = top;
      closed.branches.push(closed.current);
      const parent = stack.pop();
      if (!parent) return false; // unbalanced — let RegExp construction report it
      const quantified = isUnboundedQuantAt(i + 1);
      if (quantified && closed.hasUnbounded) return true; // (a+)+ family
      if (quantified && closed.branches.length > 1) {
        const b = closed.branches;
        for (let x = 0; x < b.length; x++) {
          for (let y = x + 1; y < b.length; y++) {
            const p = b[x] as string;
            const q = b[y] as string;
            if (p !== '' && q !== '' && (p === q || p.startsWith(q) || q.startsWith(p))) return true; // (a|a)* / (a|ab)+
          }
        }
      }
      parent.current += `(${closed.current})`;
      if (quantified || closed.hasUnbounded) parent.hasUnbounded = true;
      top = parent;
      continue;
    }
    if (isUnboundedQuantAt(i)) top.hasUnbounded = true;
    top.current += ch;
  }
  return false;
}

/** Characters worth repeating in a probe: the pattern's own literals plus common class shorthands. */
function probeAlphabet(source: string): string[] {
  const set = new Set<string>();
  if (/\\w|\\W|\./.test(source)) set.add('a');
  if (/\\d/.test(source)) set.add('1');
  if (/\\s/.test(source)) set.add(' ');
  for (const m of source.matchAll(/(?<!\\)([A-Za-z0-9])/g)) {
    set.add(m[1] as string);
    if (set.size >= MAX_PROBES) break;
  }
  const list = [...set];
  return (list.length > 0 ? list : FALLBACK_PROBE_CHARS).slice(0, MAX_PROBES);
}

function executesWithin(pattern: RegExp, input: string, timeoutMs: number): boolean {
  try {
    vm.runInNewContext('p.test(s)', { p: new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, '')), s: input }, { timeout: timeoutMs });
    return true;
  } catch {
    return false; // watchdog fired (ERR_SCRIPT_EXECUTION_TIMEOUT) or any engine failure → unsafe
  }
}

export function isRegexSafe(pattern: RegExp, timeoutMs?: number): boolean {
  if (!(pattern instanceof RegExp)) return false;
  if (pattern.source.length > MAX_PATTERN_LENGTH) return false;
  if (hasDangerousStructure(pattern.source)) return false;
  const timeout = timeoutMs ?? getSecurityRuntime().injection.redosTimeoutMs;
  for (const c of probeAlphabet(pattern.source)) {
    // Both a pure-run probe and one ending in a mismatching tail: the tail forces full backtracking.
    if (!executesWithin(pattern, `${c.repeat(PROBE_LENGTH)}\u0001`, timeout)) return false;
    if (!executesWithin(pattern, `${c.repeat(PROBE_LENGTH)}!\n`, timeout)) return false;
  }
  return true;
}

/** Compiles a user-supplied pattern; throws a plain `Error` (caller maps it) if it is too long, invalid or dangerous. */
export function safeRegex(pattern: string, flags?: string): RegExp {
  if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error(`safeRegex(): pattern must be 1–${MAX_PATTERN_LENGTH} characters`);
  }
  const compiled = new RegExp(pattern, flags);
  if (!isRegexSafe(compiled)) throw new Error('safeRegex(): pattern is susceptible to catastrophic backtracking');
  return compiled;
}

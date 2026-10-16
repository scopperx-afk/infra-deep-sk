/**
 * Prototype-pollution defences — Security spec §14.
 *
 * The attack: `JSON.parse('{"__proto__":{"isAdmin":true}}')` creates an OWN property
 * literally named `__proto__`; a naive recursive merge then assigns through it and
 * mutates `Object.prototype`, flipping a flag on EVERY object in the process.
 *
 * Dangerous keys: `__proto__`, `constructor`, `prototype`. All traversals here are
 * ITERATIVE (explicit stack, depth-bounded) so a hostile deeply-nested payload cannot
 * overflow the call stack, and cycle-safe.
 *
 * `security.injection.stripPrototypeKeys` (default true) selects the policy of
 * `sanitizeObjectKeys`: true → silently drop the keys; false → reject the payload (400).
 */
import { BadRequestException } from '@nestjs/common';
import { getSecurityRuntime } from '../runtime/security-runtime';

const DANGEROUS_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const TRAVERSAL_DEPTH_LIMIT = 64; // beyond this a payload is hostile or broken either way

export const isDangerousKey = (key: string): boolean => DANGEROUS_KEYS.has(key);

const isTraversable = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;

const isPlainObjectLike = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/** true iff no OWN key at any depth is `__proto__`/`constructor`/`prototype`. */
export function isPrototypeSafe(obj: unknown): boolean {
  if (!isTraversable(obj)) return true;
  const stack: Array<{ node: Record<string, unknown>; depth: number }> = [{ node: obj, depth: 0 }];
  const seen = new WeakSet<object>();
  while (stack.length > 0) {
    const { node, depth } = stack.pop() as { node: Record<string, unknown>; depth: number };
    if (seen.has(node)) continue;
    seen.add(node);
    if (depth > TRAVERSAL_DEPTH_LIMIT) return false;
    // getOwnPropertyNames (not Object.keys): also sees non-enumerable own keys.
    for (const key of Object.getOwnPropertyNames(node)) {
      if (DANGEROUS_KEYS.has(key)) return false;
      const child = (node as Record<string, unknown>)[key];
      if (isTraversable(child)) stack.push({ node: child, depth: depth + 1 });
    }
  }
  return true;
}

/**
 * Deep merge of PLAIN objects/arrays that refuses dangerous keys. Mutates and returns
 * `target`; never reads or writes through `__proto__`. Non-plain values (Dates, Maps,
 * class instances, Buffers) are assigned by reference, not recursed into.
 */
export function safeMerge<T extends object>(target: T, ...sources: object[]): T {
  const work: Array<{ into: Record<string, unknown>; from: Record<string, unknown>; depth: number }> = [];
  for (const source of sources) {
    if (!isTraversable(source)) continue;
    work.push({ into: target as Record<string, unknown>, from: source as Record<string, unknown>, depth: 0 });
    while (work.length > 0) {
      const { into, from, depth } = work.pop() as (typeof work)[number];
      if (depth > TRAVERSAL_DEPTH_LIMIT) {
        throw new BadRequestException('Object nesting exceeds the maximum depth');
      }
      for (const key of Object.keys(from)) {
        if (DANGEROUS_KEYS.has(key)) continue;
        const value = from[key];
        if (isPlainObjectLike(value)) {
          const existing = Object.prototype.hasOwnProperty.call(into, key) ? into[key] : undefined;
          const next = isPlainObjectLike(existing) ? existing : {};
          into[key] = next;
          work.push({ into: next, from: value, depth: depth + 1 });
        } else if (Array.isArray(value)) {
          into[key] = sanitizeValue(value, 0);
        } else {
          into[key] = value;
        }
      }
    }
  }
  return target;
}

/** Deep copy of arrays/plain objects with dangerous keys removed (used for array members in merges). */
function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > TRAVERSAL_DEPTH_LIMIT) throw new BadRequestException('Object nesting exceeds the maximum depth');
  if (Array.isArray(value)) return value.map((v) => sanitizeValue(v, depth + 1));
  if (isPlainObjectLike(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      if (!DANGEROUS_KEYS.has(key)) out[key] = sanitizeValue(value[key], depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Returns a deep copy with dangerous keys removed (`stripPrototypeKeys: true`, default) or
 * throws 400 if any are present (`false`). The input is never mutated.
 */
export function sanitizeObjectKeys<T>(obj: T, options?: { readonly strip?: boolean }): T {
  const strip = options?.strip ?? getSecurityRuntime().injection.stripPrototypeKeys;
  if (!strip && !isPrototypeSafe(obj)) {
    throw new BadRequestException('Payload contains a forbidden key');
  }
  return sanitizeValue(obj, 0) as T;
}

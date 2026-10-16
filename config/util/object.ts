/** Small, dependency-free object helpers shared across the pipeline. */

export type PlainObject = Record<string, unknown>;

export function isPlainObject(v: unknown): v is PlainObject {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function getDeep(obj: unknown, segments: readonly string[]): unknown {
  let cur: unknown = obj;
  for (const seg of segments) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
    if (cur === undefined) return undefined;
  }
  return cur;
}

export function hasDeep(obj: unknown, segments: readonly string[]): boolean {
  return getDeep(obj, segments) !== undefined;
}

export class PathConflictError extends Error {
  constructor(public readonly conflictAt: string) {
    super(`conflicting keys at "${conflictAt}"`);
    this.name = 'PathConflictError';
  }
}

/** Sets a nested value, creating intermediate objects. Throws on scalar/object conflicts. */
export function setDeep(
  obj: PlainObject,
  segments: readonly string[],
  value: unknown,
): void {
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const next = cur[seg];
    if (next === undefined) {
      const created: PlainObject = {};
      cur[seg] = created;
      cur = created;
    } else if (next !== null && typeof next === 'object') {
      cur = next as Record<string, unknown>;
    } else {
      throw new PathConflictError(segments.slice(0, i + 1).join('.'));
    }
  }
  const last = segments[segments.length - 1];
  if (
    cur[last] !== undefined &&
    typeof cur[last] === 'object' &&
    cur[last] !== null
  ) {
    throw new PathConflictError(segments.join('.'));
  }
  cur[last] = value;
}

export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value))
    return value;
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  }
  return Object.freeze(value);
}

/** Structural clone of plain JSON-like config data (objects, arrays, primitives). */
export function cloneData<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneData) as unknown as T;
  if (isPlainObject(value)) {
    const out: PlainObject = {};
    for (const [k, v] of Object.entries(value)) out[k] = cloneData(v);
    return out as T;
  }
  return value;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== typeof b ||
    a === null ||
    b === null ||
    typeof a !== 'object'
  )
    return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (
      !deepEqual(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
      )
    )
      return false;
  }
  return true;
}

/** Dotted paths of every leaf. Arrays are leaves (their contents are one value). */
export function flattenLeafPaths(obj: unknown, prefix = ''): string[] {
  if (!isPlainObject(obj)) return prefix ? [prefix] : [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v) && Object.keys(v).length > 0)
      out.push(...flattenLeafPaths(v, p));
    else out.push(p);
  }
  return out;
}

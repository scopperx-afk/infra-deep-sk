/**
 * Best-effort enumeration of the dotted paths a Zod schema declares.
 *
 * WHY this exists: get(path, default) must tell "registered but currently absent"
 * (→ default) from "never registered" (→ throw, §3/§8), and an absent optional
 * field leaves no trace in the validated tree.
 *
 * WHY this is not the reflection Anti-Pattern #11 forbids: that rule is about
 * classifying SECRETS by reflection, where a miss silently disables a security
 * control. Here a miss is benign — ConfigService also treats any path that
 * currently HAS a value as registered, so the worst case for an exotic wrapper
 * this walker doesn't understand is that an absent optional field throws
 * instead of returning the caller's default. Secret-ness still comes only from
 * `RegisterOptions.secretPaths`.
 */
import type { ZodTypeAny } from 'zod';

interface AnyDef {
  typeName?: string;
  shape?: () => Record<string, ZodTypeAny>;
  innerType?: ZodTypeAny;
  schema?: ZodTypeAny;
  out?: ZodTypeAny;
  type?: ZodTypeAny;
  getter?: () => ZodTypeAny;
  options?: ZodTypeAny[] | Map<unknown, ZodTypeAny>;
  left?: ZodTypeAny;
  right?: ZodTypeAny;
}

const MAX_DEPTH = 24;

export function enumerateSchemaPaths(schema: ZodTypeAny): Set<string> {
  const out = new Set<string>();
  walk(schema, [], out, 0);
  return out;
}

function walk(
  schema: ZodTypeAny,
  prefix: string[],
  out: Set<string>,
  depth: number,
): void {
  if (depth > MAX_DEPTH) return;
  const def = (schema as unknown as { _def: AnyDef })._def;
  switch (def.typeName) {
    case 'ZodObject': {
      const shape = def.shape?.() ?? {};
      for (const [key, child] of Object.entries(shape)) {
        const next = [...prefix, key];
        out.add(next.join('.'));
        walk(child, next, out, depth + 1);
      }
      return;
    }
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
    case 'ZodCatch':
    case 'ZodReadonly':
      if (def.innerType) walk(def.innerType, prefix, out, depth + 1);
      return;
    case 'ZodEffects':
      if (def.schema) walk(def.schema, prefix, out, depth + 1);
      return;
    case 'ZodPipeline':
      // Follow the OUTPUT side: that is the shape get() will actually return.
      if (def.out) walk(def.out, prefix, out, depth + 1);
      return;
    case 'ZodBranded':
      if (def.type) walk(def.type, prefix, out, depth + 1);
      return;
    case 'ZodLazy':
      if (def.getter) walk(def.getter(), prefix, out, depth + 1);
      return;
    case 'ZodDiscriminatedUnion':
    case 'ZodUnion': {
      const options = Array.isArray(def.options)
        ? def.options
        : [...(def.options?.values() ?? [])];
      for (const opt of options) walk(opt, prefix, out, depth + 1);
      return;
    }
    case 'ZodIntersection':
      if (def.left) walk(def.left, prefix, out, depth + 1);
      if (def.right) walk(def.right, prefix, out, depth + 1);
      return;
    default:
      return; // leaf: arrays, records, primitives, …
  }
}

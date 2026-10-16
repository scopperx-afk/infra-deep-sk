/**
 * Resolves `RegisterOptions.secretPaths` patterns (§7.5) against a validated tree.
 *
 * A pattern is `url` or `profiles[].secretRef` — `[]` marks "every element of this
 * array". Detection is ALWAYS explicit metadata; nothing here inspects Zod (§16 #11).
 */

export interface SecretLeaf {
  /** Full dotted path incl. array indices, e.g. `tokens.profiles.0.secretRef`. */
  path: string;
  segments: string[];
  value: unknown;
  /**
   * The raw merged-map key this leaf's provenance comes from: for a plain path it is
   * the path itself; for an array pattern it is the key holding the JSON blob
   * (`tokens.profiles`), because a blob arrives as ONE env var (§7.6).
   */
  rawKey: string;
  /** True when the leaf sits inside an array (i.e. inside a JSON blob). */
  insideArray: boolean;
}

export function collectSecretLeaves(
  namespace: string,
  tree: unknown,
  pattern: string,
): SecretLeaf[] {
  const parts = pattern.split('.');
  const arrayAt = pattern.indexOf('[]');
  const rawKey = `${namespace}.${arrayAt === -1 ? pattern : pattern.slice(0, arrayAt)}`;
  const out: SecretLeaf[] = [];

  const walk = (
    node: unknown,
    idx: number,
    segs: string[],
    inArray: boolean,
  ): void => {
    if (node === null || typeof node !== 'object') return;
    const part = parts[idx];
    const isArr = part.endsWith('[]');
    const key = isArr ? part.slice(0, -2) : part;
    const child = (node as Record<string, unknown>)[key];
    if (child === undefined) return;
    const last = idx === parts.length - 1;

    if (isArr) {
      if (!Array.isArray(child)) return;
      child.forEach((el, i) => {
        const next = [...segs, key, String(i)];
        if (last)
          out.push({
            path: [namespace, ...next].join('.'),
            segments: next,
            value: el,
            rawKey,
            insideArray: true,
          });
        else walk(el, idx + 1, next, true);
      });
    } else {
      const next = [...segs, key];
      if (last)
        out.push({
          path: [namespace, ...next].join('.'),
          segments: next,
          value: child,
          rawKey,
          insideArray: inArray,
        });
      else walk(child, idx + 1, next, inArray);
    }
  };

  walk(tree, 0, [], false);
  return out;
}

/** Every string secret value in a validated snapshot — used to scrub messages (§11.5). */
export function collectSecretValues(
  snapshot: Readonly<Record<string, unknown>>,
  namespaces: ReadonlyArray<{
    name: string;
    secretPatterns: readonly string[];
  }>,
): string[] {
  const values: string[] = [];
  for (const ns of namespaces) {
    for (const pattern of ns.secretPatterns) {
      for (const leaf of collectSecretLeaves(
        ns.name,
        snapshot[ns.name],
        pattern,
      )) {
        if (typeof leaf.value === 'string' && leaf.value.length > 0)
          values.push(leaf.value);
      }
    }
  }
  return values;
}

/** Replaces every occurrence of a known secret value in `text` with [REDACTED]. */
export function scrub(
  text: string,
  secretValues: readonly string[],
  minLength = 4,
): string {
  let out = text;
  // Longest first so a secret that contains another secret is fully replaced.
  for (const s of [...secretValues]
    .filter((v) => v.length >= minLength)
    .sort((a, b) => b.length - a.length)) {
    out = out.split(s).join('[REDACTED]');
  }
  return out;
}

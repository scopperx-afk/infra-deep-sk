/**
 * Pipeline step 4 — Config spec §6, §7. ZERO network calls.
 *
 *  4a. Per-namespace schema validation (Zod) — every namespace, collect every
 *      error. This is where value-level transforms run (csvArray, JSON blobs,
 *      durations) and where schema `.default()`s are applied.
 *  4b. Cross-field validation within a namespace — expressed inside the schema via
 *      `.superRefine()` (§7.3), so it runs in the same parse as 4a.
 *  4c. Cross-namespace validation (§7.4) — runs ONLY once every namespace has
 *      individually passed, so a cross-validation function may assume every
 *      namespace it reads is structurally valid. Every registered function runs;
 *      one throwing does not stop the others.
 */
import {
  ConfigValidationError,
  type CrossValidationContext,
} from '../config.port';
import type {
  ConfigRegistryImpl,
  RegisteredNamespace,
} from '../schema/registry';
import {
  collectSecretLeaves,
  collectSecretValues,
  scrub,
} from '../schema/secret-paths';
import type { MergedEntry } from '../store/config.store';
import {
  PathConflictError,
  cloneData,
  deepFreeze,
  getDeep,
  isPlainObject,
  setDeep,
} from '../util/object';
import { pathToEnvName } from '../util/env-name';
import { formatZodIssues } from './config.error-format';

export type NamespaceValidation =
  { ok: true; value: unknown } | { ok: false; errors: string[] };

export type ValidationOutcome =
  | {
      ok: true;
      /** Namespace name → validated, defaulted, typed value (NOT yet frozen). */
      snapshot: Record<string, unknown>;
      /** Leaves that came from a schema default rather than any source (§7.9). */
      defaultedPaths: string[];
      /** Merged entries no registered schema consumed (candidates for the "unused var" warning). */
      unknownEntries: MergedEntry[];
    }
  | { ok: false; errors: string[] };

/** "Did some source actually supply this value, or is it purely a Zod default?" (§7.4) */
export function makeWasSupplied(
  merged: ReadonlyMap<string, MergedEntry>,
): (path: string) => boolean {
  const prefixes = new Set<string>();
  for (const key of merged.keys()) {
    const parts = key.split('.');
    for (let i = 1; i <= parts.length; i++)
      prefixes.add(parts.slice(0, i).join('.'));
  }
  return (path: string): boolean => {
    if (prefixes.has(path)) return true; // exact key, or an ancestor of a supplied key
    const parts = path.split('.');
    for (let i = 1; i < parts.length; i++) {
      if (merged.has(parts.slice(0, i).join('.'))) return true; // inside a supplied JSON blob
    }
    return false;
  };
}

/**
 * Raw secret values known BEFORE validation succeeds (so failed-validation messages
 * can be scrubbed): plain secret leaves straight from the merged map, plus the
 * string leaves inside JSON blobs that carry `profiles[].secretRef`-style secrets.
 */
export function collectRawSecretValues(
  registry: ConfigRegistryImpl,
  merged: ReadonlyMap<string, MergedEntry>,
): string[] {
  const out: string[] = [];
  for (const ns of registry.all()) {
    for (const pattern of ns.secretPatterns) {
      const arrayAt = pattern.indexOf('[]');
      if (arrayAt === -1) {
        const v = merged.get(`${ns.name}.${pattern}`)?.value;
        if (v) out.push(v);
        continue;
      }
      const rel = pattern.slice(0, arrayAt);
      const blob = merged.get(`${ns.name}.${rel}`)?.value;
      if (!blob) continue;
      try {
        const tree: Record<string, unknown> = {};
        setDeep(tree, rel.split('.'), JSON.parse(blob));
        for (const leaf of collectSecretLeaves(ns.name, tree, pattern)) {
          if (typeof leaf.value === 'string' && leaf.value)
            out.push(leaf.value);
        }
      } catch {
        /* malformed blob: reported as its own validation error */
      }
    }
  }
  return out;
}

export class ConfigValidator {
  /** 4a + 4b for ONE namespace — also what hot-reload re-runs for the owning namespace (§10.3). */
  validateNamespace(
    registry: ConfigRegistryImpl,
    ns: RegisteredNamespace,
    merged: ReadonlyMap<string, MergedEntry>,
    secretValues: readonly string[],
  ): NamespaceValidation {
    const built = buildNamespaceRaw(ns.name, merged);
    if (built.conflicts.length > 0)
      return {
        ok: false,
        errors: built.conflicts.map((c) => scrub(c, secretValues)),
      };

    try {
      const parsed = ns.schema.safeParse(built.raw);
      if (parsed.success) return { ok: true, value: parsed.data };
      return {
        ok: false,
        errors: formatZodIssues({
          namespace: ns.name,
          issues: parsed.error.issues,
          registry,
          merged,
          secretValues,
        }),
      };
    } catch (err) {
      // A transform/refine that throws instead of adding an issue.
      return {
        ok: false,
        errors: [
          scrub(
            `${pathToEnvName([ns.name])}: schema threw unexpectedly: ${(err as Error).message}`,
            secretValues,
          ),
        ],
      };
    }
  }

  validate(
    registry: ConfigRegistryImpl,
    merged: ReadonlyMap<string, MergedEntry>,
  ): ValidationOutcome {
    const errors: string[] = [];
    const snapshot: Record<string, unknown> = {};
    const rawSecrets = collectRawSecretValues(registry, merged);

    // 4a + 4b — every namespace, every error.
    for (const ns of registry.all()) {
      const result = this.validateNamespace(registry, ns, merged, rawSecrets);
      if (result.ok) snapshot[ns.name] = result.value;
      else errors.push(...result.errors);
    }
    if (errors.length > 0) return { ok: false, errors };

    // 4c — only now; every function runs, failures are collected (§7.4, §7.9).
    const secretValues = collectSecretValues(snapshot, registry.all());
    const ctx: CrossValidationContext = {
      config: deepFreeze(cloneData(snapshot)),
      wasSupplied: makeWasSupplied(merged),
    };
    for (const fn of registry.crossValidations()) {
      try {
        fn(ctx);
      } catch (err) {
        const message =
          err instanceof ConfigValidationError
            ? err.message
            : `a cross-validation function threw unexpectedly: ${(err as Error).message}`;
        // Cross-validation authors are told never to interpolate a value (§7.4); if one
        // did anyway, the formatter still refuses to leak a secret.
        errors.push(scrub(message, secretValues));
      }
    }
    if (errors.length > 0) return { ok: false, errors };

    const wasSupplied = makeWasSupplied(merged);
    return {
      ok: true,
      snapshot,
      defaultedPaths: findDefaultedPaths(snapshot, wasSupplied),
      unknownEntries: findUnknownEntries(registry, snapshot, merged),
    };
  }
}

/** Nested raw object for one namespace, built from the dotted-path merged map. */
function buildNamespaceRaw(
  namespace: string,
  merged: ReadonlyMap<string, MergedEntry>,
): { raw: Record<string, unknown>; conflicts: string[] } {
  const raw: Record<string, unknown> = {};
  const conflicts: string[] = [];
  const prefix = `${namespace}.`;
  for (const entry of merged.values()) {
    if (!entry.path.startsWith(prefix)) continue;
    try {
      setDeep(raw, entry.path.slice(prefix.length).split('.'), entry.value);
    } catch (err) {
      if (err instanceof PathConflictError) {
        conflicts.push(
          `${entry.envName}: conflicts with another variable at "${err.conflictAt}" (a key can't be both a value and a group)`,
        );
      } else throw err;
    }
  }
  return { raw, conflicts };
}

function findUnknownEntries(
  registry: ConfigRegistryImpl,
  snapshot: Record<string, unknown>,
  merged: ReadonlyMap<string, MergedEntry>,
): MergedEntry[] {
  const unknown: MergedEntry[] = [];
  for (const entry of merged.values()) {
    const [nsName, ...rest] = entry.path.split('.');
    // A raw key is "consumed" iff it survives into the validated output (Zod strips
    // keys the schema doesn't declare — typos, other union branches, …).
    if (
      !registry.hasNamespace(nsName) ||
      rest.length === 0 ||
      getDeep(snapshot[nsName], rest) === undefined
    ) {
      unknown.push(entry);
    }
  }
  return unknown;
}

function findDefaultedPaths(
  snapshot: Record<string, unknown>,
  wasSupplied: (p: string) => boolean,
): string[] {
  const out: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (isPlainObject(node) && Object.keys(node).length > 0) {
      for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
    } else if (!wasSupplied(path)) {
      out.push(path); // arrays / blobs are leaves: judged as a whole
    }
  };
  for (const [ns, value] of Object.entries(snapshot)) walk(value, ns);
  return out;
}

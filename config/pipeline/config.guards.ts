/**
 * Pipeline step 5 — the production secret guard. Config spec §9.2, §5.2.
 *
 * Runs against the RAW value's provenance (recorded in steps 1–3), after validation
 * and BEFORE any secret is resolved: resolution (and defaulting) would otherwise erase
 * the difference between "a real secret came from an env-injected source" and
 * "someone hardcoded a password into a committed file".
 *
 * Messages name the variable and the rule — never the value.
 */
import type { Environment } from '../config.port';
import type { ConfigRegistryImpl } from '../schema/registry';
import { collectSecretLeaves } from '../schema/secret-paths';
import { secretReferenceScheme } from '../secrets/secret.resolver.port';
import type { MergedEntry } from '../store/config.store';
import { pathToEnvName } from '../util/env-name';

export interface GuardInput {
  registry: ConfigRegistryImpl;
  merged: ReadonlyMap<string, MergedEntry>;
  snapshot: Readonly<Record<string, unknown>>;
  env: Environment;
  /** Schemes of registered resolvers (e.g. ['vault']). Empty until a resolver ships. */
  resolverSchemes: readonly string[];
}

export function runProductionGuards(input: GuardInput): string[] {
  const { registry, merged, snapshot, env, resolverSchemes } = input;
  const strict = env === 'production' || env === 'staging';
  const errors: string[] = [];

  for (const ns of registry.all()) {
    for (const pattern of ns.secretPatterns) {
      for (const leaf of collectSecretLeaves(
        ns.name,
        snapshot[ns.name],
        pattern,
      )) {
        if (typeof leaf.value !== 'string') continue;
        const entry = merged.get(leaf.rawKey);
        const label = leaf.insideArray
          ? pathToEnvName([
              ns.name,
              ...leaf.segments.map((s) => (/^\d+$/.test(s) ? Number(s) : s)),
            ])
          : (entry?.envName ?? pathToEnvName([ns.name, ...leaf.segments]));

        const scheme = secretReferenceScheme(leaf.value, resolverSchemes);
        if (scheme !== null) {
          // A reference with no matching resolver: fail fast, never a silent pass-through.
          if (!resolverSchemes.includes(scheme)) {
            errors.push(
              `${label}: secret reference "${scheme}://…" but no SecretResolver for "${scheme}" is registered ` +
                `(deliver the literal via process.env until one ships — §5.4, §9.2)`,
            );
          }
          continue; // a reference is allowed in any origin
        }

        // ── literal value ──
        if (
          strict &&
          entry &&
          (entry.origin === 'committed-file' || entry.origin === 'local-file')
        ) {
          errors.push(
            `${label}: a literal secret was read from ${entry.origin === 'local-file' ? 'a .local file' : 'a committed file'} ` +
              `(${entry.sourceName}) — in ${env} secrets must be injected via process.env by the orchestrator, ` +
              `or given as a vault:// / aws-secrets:// reference (§9.2)`,
          );
        }

        // §5.2: multiline secrets are delivered by KEY_FILE only. Applies to direct env
        // values; a JSON blob is one env var and has no _FILE form.
        if (
          !leaf.insideArray &&
          entry &&
          !entry.viaFile &&
          (/[\r\n]/.test(leaf.value) || leaf.value.includes('\\n'))
        ) {
          errors.push(
            `${label}: secret contains a raw newline or an escaped "\\n" sequence — deliver multiline secrets ` +
              `via ${entry.envName}_FILE only (§5.2)`,
          );
        }
      }
    }
  }
  return errors;
}

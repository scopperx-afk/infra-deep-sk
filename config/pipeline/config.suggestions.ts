/**
 * "Did you mean …?" for unused variables — Config spec §7.9, §11.5, §14.
 *
 * WHY: the §5.1.1 algorithm is not invertible for camelCase keys whose words a human
 * would write as one (`redis.pubSubDb` ⇄ `REDIS__PUB_SUB_DB`, but the catalog and
 * Appendix A write `REDIS__PUBSUB_DB`). The mistyped variable maps to a path no schema
 * declares, Zod strips it, and — for an optional field with no default — nothing fails:
 * the setting is silently treated as unset. The "unused var" warning is then the only
 * signal, so it should say WHICH variable was meant.
 *
 * Matching is deliberately narrow (same `__` nesting, same letters, underscores aside)
 * so a suggestion is never a guess: no edit-distance fuzziness.
 */
import type { ConfigRegistryImpl } from '../schema/registry';
import { pathToEnvName } from '../util/env-name';

const squashSegments = (envName: string): string =>
  envName
    .split('__')
    .map((segment) => segment.replace(/_/g, ''))
    .join('__');

export function buildEnvNameSuggester(
  registry: ConfigRegistryImpl,
): (unknownEnvName: string) => string | undefined {
  let index: Map<string, string> | undefined;
  const build = (): Map<string, string> => {
    const map = new Map<string, string>();
    for (const ns of registry.all()) {
      for (const rel of ns.knownPaths) {
        const envName = pathToEnvName([ns.name, ...rel.split('.')]);
        const key = squashSegments(envName);
        if (!map.has(key)) map.set(key, envName);
      }
    }
    return map;
  };
  return (unknownEnvName) => {
    index ??= build();
    const candidate = index.get(squashSegments(unknownEnvName));
    return candidate !== undefined && candidate !== unknownEnvName
      ? candidate
      : undefined;
  };
}

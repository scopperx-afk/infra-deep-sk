/**
 * Pipeline step 6 — resolve secret references. Config spec §5.5, §6.
 *
 * Only runs at all once a SecretResolver is registered (none ships yet — OPEN-05).
 * Network calls happen here and ONLY here, at startup, never per request. Every
 * resolution is bounded by a timeout (architecture rule 17).
 */
import type { ConfigObservation } from '../observation/config.observation';
import type { ConfigRegistryImpl } from '../schema/registry';
import { collectSecretLeaves } from '../schema/secret-paths';
import { nowMs } from '../util/clock';
import { cloneData, setDeep } from '../util/object';
import { pathToEnvName } from '../util/env-name';
import {
  secretReferenceScheme,
  type SecretResolver,
} from './secret.resolver.port';

const DEFAULT_RESOLVE_TIMEOUT_MS = 10_000;

export interface ResolutionResult {
  snapshot: Record<string, unknown>;
  secretRefs: Array<{ path: string; ref: string }>;
  errors: string[];
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} timed out after ${ms}ms`)),
      ms,
    );
    timer.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export async function resolveSecretReferences(args: {
  snapshot: Record<string, unknown>;
  registry: ConfigRegistryImpl;
  resolver: SecretResolver | null;
  observation: ConfigObservation;
  timeoutMs?: number;
}): Promise<ResolutionResult> {
  const { registry, resolver, observation } = args;
  if (!resolver) return { snapshot: args.snapshot, secretRefs: [], errors: [] };

  const snapshot = cloneData(args.snapshot);
  const secretRefs: Array<{ path: string; ref: string }> = [];
  const errors: string[] = [];

  for (const ns of registry.all()) {
    for (const pattern of ns.secretPatterns) {
      for (const leaf of collectSecretLeaves(
        ns.name,
        snapshot[ns.name],
        pattern,
      )) {
        if (
          typeof leaf.value !== 'string' ||
          secretReferenceScheme(leaf.value, [resolver.prefix]) !==
            resolver.prefix
        )
          continue;
        const started = nowMs();
        try {
          const resolved = await withTimeout(
            resolver.resolve(leaf.value),
            args.timeoutMs ?? DEFAULT_RESOLVE_TIMEOUT_MS,
            `resolving ${resolver.prefix}:// reference`,
          );
          setDeep(
            snapshot[ns.name] as Record<string, unknown>,
            leaf.segments,
            resolved,
          );
          secretRefs.push({ path: leaf.path, ref: leaf.value }); // the reference, never the resolved value
          observation.incCounter('config_secret_resolutions_total', {
            provider: resolver.prefix,
            status: 'success',
          });
        } catch (err) {
          observation.incCounter('config_secret_resolutions_total', {
            provider: resolver.prefix,
            status: 'failure',
          });
          const label = pathToEnvName([
            ns.name,
            ...leaf.segments.map((s) => (/^\d+$/.test(s) ? Number(s) : s)),
          ]);
          errors.push(
            `${label}: could not resolve secret reference via "${resolver.prefix}": ${(err as Error).message}`,
          );
        } finally {
          observation.observe(
            'config_secret_resolution_duration_seconds',
            { provider: resolver.prefix },
            (nowMs() - started) / 1000,
          );
        }
      }
    }
  }
  return { snapshot, secretRefs, errors };
}

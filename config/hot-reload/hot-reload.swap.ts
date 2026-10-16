/**
 * Atomic snapshot swap planning — Config spec §10.3.
 *
 * Hot-reload never mutates the live tree. On a whitelisted change:
 *  1. Re-validate ONLY the owning namespace (steps 4a/4b). Step 4c is deliberately
 *     NOT re-run: neither whitelist entry participates in a cross-namespace rule
 *     (§10.3 — any future whitelist addition must re-confirm that).
 *  2. Build a new, fully-frozen snapshot (unchanged namespaces are shared: they are
 *     already frozen).
 *  3. The caller then atomically swaps the snapshot reference.
 *
 * Only the UPDATED whitelisted leaves are copied from the re-validated namespace onto
 * the previous namespace value. Copying the whole re-parsed namespace would re-derive
 * every other field from RAW values — and would put an unresolved secret reference
 * back over a resolved one for any namespace that also carries secrets.
 */
import type { ConfigRegistryImpl } from '../schema/registry';
import {
  collectRawSecretValues,
  type ConfigValidator,
} from '../pipeline/config.validator';
import type { ConfigStore, MergedEntry, Snapshot } from '../store/config.store';
import { cloneData, deepFreeze, getDeep, setDeep } from '../util/object';

export interface SwapPlan {
  nextSnapshot: Snapshot;
  acceptedEntries: MergedEntry[];
  rejections: string[];
}

export function planSwap(args: {
  registry: ConfigRegistryImpl;
  validator: ConfigValidator;
  store: ConfigStore;
  entries: readonly MergedEntry[];
}): SwapPlan | null {
  const { registry, validator, store, entries } = args;
  const byNamespace = new Map<string, MergedEntry[]>();
  for (const e of entries) {
    const ns = e.path.split('.')[0];
    byNamespace.set(ns, [...(byNamespace.get(ns) ?? []), e]);
  }

  const nextNamespaces: Record<string, unknown> = {};
  const acceptedEntries: MergedEntry[] = [];
  const rejections: string[] = [];

  for (const [nsName, nsEntries] of byNamespace) {
    const reg = registry.getNamespace(nsName);
    if (!reg) {
      rejections.push(
        ...nsEntries.map(
          (e) =>
            `${e.envName}: namespace "${nsName}" is not registered — ignored`,
        ),
      );
      continue;
    }

    const candidate = new Map(store.raw);
    for (const e of nsEntries) candidate.set(e.path, e);

    const result = validator.validateNamespace(
      registry,
      reg,
      candidate,
      collectRawSecretValues(registry, candidate),
    );
    if (!result.ok) {
      // The old value stays active; the failure is reported (§10.2).
      rejections.push(...result.errors);
      continue;
    }

    const patched = cloneData(store.snapshot[nsName]) as Record<
      string,
      unknown
    >;
    let touched = false;
    for (const e of nsEntries) {
      const rel = e.path.split('.').slice(1);
      const value = getDeep(result.value, rel);
      if (value === undefined) {
        rejections.push(
          `${e.envName}: not declared by the "${nsName}" schema — ignored`,
        );
        continue;
      }
      setDeep(patched, rel, cloneData(value));
      acceptedEntries.push(e);
      touched = true;
    }
    if (touched) nextNamespaces[nsName] = deepFreeze(patched);
  }

  if (acceptedEntries.length === 0)
    return rejections.length > 0
      ? { nextSnapshot: store.snapshot, acceptedEntries, rejections }
      : null;
  return {
    nextSnapshot: Object.freeze({ ...store.snapshot, ...nextNamespaces }),
    acceptedEntries,
    rejections,
  };
}

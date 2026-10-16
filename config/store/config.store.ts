/**
 * The frozen configuration tree + its bookkeeping (Config spec §3.1, §10.3, §11.1).
 *
 * There is no public mutator: the ONLY paths that change state are the initializer's
 * one-time commit and the hot-reload swap (`swap()`), which replaces the snapshot
 * REFERENCE atomically — the previous snapshot object is never mutated in place, so a
 * concurrent reader sees fully-old or fully-new, never half-applied.
 */
import type { ConfigValueOrigin } from '../sources/config-source.port';

/** One winning raw value per dotted path (§6 step 3), with its provenance. */
export interface MergedEntry {
  path: string;
  value: string;
  origin: ConfigValueOrigin;
  /** The original variable name — used to name env vars in error messages (§11.5). */
  envName: string;
  sourceName: string;
  viaFile: boolean;
}

export type Snapshot = Readonly<Record<string, unknown>>;

export class ConfigStore {
  private current: Snapshot = Object.freeze({});
  private versionCounter = 0;
  /** Winning raw values — kept so hot-reload can re-validate the owning namespace. */
  private rawEntries = new Map<string, MergedEntry>();
  private refs: ReadonlyArray<{ path: string; ref: string }> = [];

  get snapshot(): Snapshot {
    return this.current;
  }
  /** 0 until the first hot-reload swap; then +1 per successful swap (§11.1). */
  get version(): number {
    return this.versionCounter;
  }
  get raw(): ReadonlyMap<string, MergedEntry> {
    return this.rawEntries;
  }
  get secretRefs(): ReadonlyArray<{ path: string; ref: string }> {
    return this.refs;
  }

  /** Pipeline step 7→8: called exactly once by the initializer with an already-frozen tree. */
  commitInitial(
    snapshot: Snapshot,
    raw: Map<string, MergedEntry>,
    secretRefs: Array<{ path: string; ref: string }>,
  ): void {
    this.current = snapshot;
    this.rawEntries = raw;
    this.refs = Object.freeze([...secretRefs]);
  }

  /** §10.3 step 4: atomic reference swap + version bump. Returns the new version. */
  swap(next: Snapshot, acceptedRaw: readonly MergedEntry[]): number {
    for (const entry of acceptedRaw) this.rawEntries.set(entry.path, entry);
    this.current = next;
    this.versionCounter += 1;
    return this.versionCounter;
  }
}

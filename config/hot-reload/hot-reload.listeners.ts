/**
 * onChange / onNamespaceChange listener bookkeeping — Config spec §10.3 step 5.
 *
 * Listeners fire synchronously, in registration order, AFTER the atomic swap. A
 * listener throwing does not roll the swap back and does not stop the others: each
 * error is caught individually and reported.
 */
import { deepEqual, getDeep } from '../util/object';
import type { Snapshot } from '../store/config.store';
import type { Unsubscribe } from '../sources/config-source.port';

interface Listener {
  kind: 'path' | 'namespace';
  key: string;
  callback: (value: unknown) => void;
}

export class ListenerRegistry {
  private listeners: Listener[] = [];

  add<T>(
    kind: 'path' | 'namespace',
    key: string,
    callback: (value: T) => void,
  ): Unsubscribe {
    const listener: Listener = {
      kind,
      key,
      // Under strictFunctionTypes, function parameter positions are contravariant:
      // `(value: unknown) => void` is assignable to `(value: T) => void` — it accepts
      // more inputs — never the reverse. So storing a `(value: T) => void` as
      // `(value: unknown) => void` needs an explicit cast.
      //
      // The cast is sound because `fire()` only ever invokes the callback with a value
      // read from the SAME path (`key`) the caller registered on. The caller's `T` is
      // their own assertion about that path's shape — the same contract as
      // `ConfigService.get<T>(path)` (README §8.1).
      callback: callback as (value: unknown) => void,
    };
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i !== -1) this.listeners.splice(i, 1);
    };
  }

  fire(
    oldSnap: Snapshot,
    newSnap: Snapshot,
    onError: (key: string, err: unknown) => void,
  ): void {
    for (const l of [...this.listeners]) {
      const before =
        l.kind === 'namespace'
          ? oldSnap[l.key]
          : getDeep(oldSnap, l.key.split('.'));
      const after =
        l.kind === 'namespace'
          ? newSnap[l.key]
          : getDeep(newSnap, l.key.split('.'));
      if (deepEqual(before, after)) continue;
      try {
        l.callback(after);
      } catch (err) {
        onError(l.key, err);
      }
    }
  }

  get size(): number {
    return this.listeners.length;
  }
}

/**
 * ConfigService implementation — Config spec §3, §8.
 *
 * Reads are in-memory lookups on the CURRENT frozen snapshot — Config needs no caching
 * layer of its own; it is the cache (§11.4). There is intentionally no set(), no
 * dump() and no inspect() (§3.1, §9.3).
 *
 * `get()` / `getNamespace()` always read whichever snapshot is current AT CALL TIME.
 * The object returned is a frozen point-in-time value: a consumer that holds it across
 * a hot-reload keeps reading pre-swap values forever (§10.3 stale-reference contract).
 */
import {
  ConfigMissingError,
  ConfigRegistrationError,
  type ConfigHealth,
  type ConfigMetricsSnapshot,
  type ConfigReport,
  type ConfigService,
  type Environment,
  type Unsubscribe,
} from './config.port';
import { ListenerRegistry } from './hot-reload/hot-reload.listeners';
import {
  HOT_RELOAD_WHITELIST,
  matchesWhitelist,
  namespaceHasWhitelistedPath,
} from './hot-reload/hot-reload.whitelist';
import type { ConfigObservation } from './observation/config.observation';
import type { ConfigRegistryImpl } from './schema/registry';
import type { ConfigStore } from './store/config.store';
import { flattenLeafPaths, getDeep } from './util/object';

export class ConfigServiceImpl implements ConfigService {
  constructor(
    private readonly store: ConfigStore,
    private readonly registry: ConfigRegistryImpl,
    private readonly listeners: ListenerRegistry,
    private readonly observation: ConfigObservation,
  ) {}

  get<T = unknown>(path: string): T;
  get<T = unknown>(path: string, defaultValue: T): T;
  get<T = unknown>(path: string, ...rest: [] | [T]): T {
    const segments = this.segmentsOf(path);
    const value = getDeep(this.store.snapshot, segments);
    // "Registered" = declared by some schema, OR currently holding a value. The second
    // clause means an exotic schema wrapper the path enumerator doesn't understand can
    // never make a present value look unregistered (see schema-paths.ts).
    if (value === undefined && !this.registry.isKnownPath(segments.join('.'))) {
      throw new ConfigMissingError(path, 'unregistered'); // a default does NOT excuse an unregistered path
    }
    if (value === undefined) {
      if (rest.length > 0) return rest[0] as T;
      throw new ConfigMissingError(path, 'absent');
    }
    return value as T; // includes an explicit `null` — a present value, never replaced by the default
  }

  has(path: string): boolean {
    try {
      return getDeep(this.store.snapshot, this.segmentsOf(path)) !== undefined;
    } catch {
      return false; // has() never throws
    }
  }

  getNamespace<T>(namespace: string): T {
    if (!this.registry.hasNamespace(namespace))
      throw new ConfigMissingError(namespace, 'unregistered');
    const value = this.store.snapshot[namespace];
    if (value === undefined) throw new ConfigMissingError(namespace, 'absent');
    return value as T;
  }

  isProduction(): boolean {
    return this.getEnvironment() === 'production';
  }

  getEnvironment(): Environment {
    return this.getNamespace<{ env: Environment }>('app').env;
  }

  onChange<T>(path: string, callback: (value: T) => void): Unsubscribe {
    // Synchronous, at subscription time: a misconfigured listener is caught at boot
    // instead of being silently dead (§10.1).
    if (!matchesWhitelist(path)) {
      throw new ConfigRegistrationError(
        `onChange("${path}"): not a hot-reload whitelisted path (${HOT_RELOAD_WHITELIST.join(', ')}). ` +
          `Array-element paths never match, and a bare namespace needs onNamespaceChange().`,
      );
    }
    return this.listeners.add('path', path, callback);
  }

  onNamespaceChange<T>(
    namespace: string,
    callback: (config: T) => void,
  ): Unsubscribe {
    if (!namespaceHasWhitelistedPath(namespace)) {
      throw new ConfigRegistrationError(
        `onNamespaceChange("${namespace}"): no hot-reload whitelisted path lives in this namespace (${HOT_RELOAD_WHITELIST.join(', ')}).`,
      );
    }
    return this.listeners.add('namespace', namespace, callback);
  }

  getConfigReport(): ConfigReport {
    const report: ConfigReport = {
      namespaces: this.registry.namespaces(),
      keys: flattenLeafPaths(this.store.snapshot).sort(), // key NAMES only — never values (§9.3)
      secretRefs: this.store.secretRefs.map((r) => ({ ...r })),
    };
    if (this.store.version > 0) report.configVersion = this.store.version;
    return report;
  }

  getHealth(): ConfigHealth {
    return this.observation.getHealth(this.store.version);
  }

  getMetricsSnapshot(): ConfigMetricsSnapshot {
    return this.observation.getMetricsSnapshot(this.store.version);
  }

  private segmentsOf(path: string): string[] {
    if (
      typeof path !== 'string' ||
      path.length === 0 ||
      path.startsWith('.') ||
      path.endsWith('.') ||
      path.includes('..')
    ) {
      throw new ConfigMissingError(String(path), 'unregistered');
    }
    return path.split('.');
  }
}

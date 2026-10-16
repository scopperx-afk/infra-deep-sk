/**
 * Hot-reload wiring — Config spec §10.2.
 *
 * flow: a watched source reports a change → keep only WHITELISTED, non-secret paths →
 * re-validate the owning namespace → if validation fails the old value stays active and
 * the failure is reported → on success atomically swap the snapshot → fire listeners.
 *
 * Until RemoteConfigSource exists, the only watch-capable source is the dev-only dotenv
 * file watch, so in staging/production this manager starts nothing and
 * `ConfigHealth.hotReloadActive` is honestly `false` (§5.6, §11.2).
 */
import {
  ConfigRegistrationError,
  type ConfigNotice,
  type Environment,
  type HotReloadOptions,
} from '../config.port';
import type { ConfigNotifier } from '../notices/config.notice';
import type { ConfigObservation } from '../observation/config.observation';
import { sourceKeyToPath } from '../pipeline/config.loader';
import type { ConfigValidator } from '../pipeline/config.validator';
import type { ConfigRegistryImpl } from '../schema/registry';
import type {
  ConfigSource,
  RawValueWithProvenance,
  Unsubscribe,
} from '../sources/config-source.port';
import type { ConfigStore, MergedEntry } from '../store/config.store';
import { ListenerRegistry } from './hot-reload.listeners';
import {
  HOT_RELOAD_WHITELIST,
  assertWithinWhitelist,
  matchesWhitelist,
} from './hot-reload.whitelist';
import { planSwap } from './hot-reload.swap';

export interface HotReloadDeps {
  options: HotReloadOptions | undefined;
  registry: ConfigRegistryImpl;
  validator: ConfigValidator;
  store: ConfigStore;
  observation: ConfigObservation;
  notifier: ConfigNotifier;
  listeners: ListenerRegistry;
}

export class HotReloadManager {
  private readonly subscriptions: Unsubscribe[] = [];
  private readonly entries: readonly string[];

  constructor(private readonly deps: HotReloadDeps) {
    const paths = deps.options?.paths;
    if (paths) assertWithinWhitelist(paths);
    // Options can only NARROW the project whitelist.
    this.entries = paths && paths.length > 0 ? paths : HOT_RELOAD_WHITELIST;
  }

  start(sources: readonly ConfigSource[], env: Environment): void {
    const { options, notifier, observation } = this.deps;
    if (!options?.enabled) return;

    for (const source of sources) {
      if (typeof source.watch !== 'function') continue;
      if (source.watchEnvironments && !source.watchEnvironments.includes(env))
        continue;
      if (
        options.sources &&
        options.sources.length > 0 &&
        !(options.sources as string[]).includes(source.name)
      )
        continue;
      try {
        this.subscriptions.push(
          source.watch((updates) => this.handleUpdate(source, updates)),
        );
      } catch (err) {
        notifier.notify({
          level: 'warning',
          code: 'hot-reload-source-failed',
          message: `could not start watching config source "${source.name}": ${(err as Error).message}`,
        });
      }
    }
    observation.setHotReloadActive(this.subscriptions.length > 0);
  }

  stop(): void {
    for (const unsub of this.subscriptions.splice(0)) {
      try {
        unsub();
      } catch {
        /* shutting down */
      }
    }
    this.deps.observation.setHotReloadActive(false);
  }

  /** Entry point for every watched-source callback. Never throws. */
  handleUpdate(
    source: ConfigSource,
    updates: Record<string, RawValueWithProvenance>,
  ): void {
    const { registry, validator, store, observation, notifier, listeners } =
      this.deps;
    try {
      const accepted: MergedEntry[] = [];
      const rejected: string[] = [];
      const ignored: string[] = [];

      for (const [key, raw] of Object.entries(updates)) {
        const path = sourceKeyToPath(source, key);
        if (path === null) continue;

        // A secret-marked path can NEVER be hot-reloaded. The production guard (§9.2)
        // only runs at boot, so this is a hard invariant, not left to the whitelist.
        if (registry.isSecretOrSecretContainer(path)) {
          rejected.push(
            new ConfigRegistrationError(
              `${key}: hot-reload update on a secret-marked path is rejected outright (§10.2)`,
            ).message,
          );
          continue;
        }
        if (!matchesWhitelist(path, this.entries)) {
          ignored.push(key);
          continue;
        }
        accepted.push({
          path,
          value: raw.value.trim(),
          origin: raw.origin,
          envName: key,
          sourceName: source.name,
          viaFile: raw.viaFile === true,
        });
      }

      const plan =
        accepted.length > 0
          ? planSwap({ registry, validator, store, entries: accepted })
          : null;
      if (plan) rejected.push(...plan.rejections);

      if (rejected.length > 0) {
        notifier.notify(
          this.notice(
            'error',
            'hot-reload-rejected',
            `hot-reload update rejected; previous values stay active: ${rejected.join(' | ')}`,
          ),
        );
      }
      if (ignored.length > 0) {
        notifier.notify(
          this.notice(
            'warning',
            'hot-reload-ignored',
            `changed but not hot-reload whitelisted — restart required: ${ignored.join(', ')}`,
          ),
        );
      }
      if (!plan || plan.acceptedEntries.length === 0) return;

      const before = store.snapshot;
      store.swap(plan.nextSnapshot, plan.acceptedEntries); // atomic reference swap + version bump
      for (const e of plan.acceptedEntries)
        observation.incCounter('config_hot_reloads_total', { path: e.path });

      listeners.fire(before, plan.nextSnapshot, (key, err) => {
        // The swap already happened; a throwing listener neither rolls it back nor
        // stops the remaining listeners (§10.3).
        notifier.notify(
          this.notice(
            'error',
            'hot-reload-listener-error',
            `listener for "${key}" threw: ${(err as Error).message}`,
          ),
        );
      });
    } catch (err) {
      notifier.notify(
        this.notice(
          'error',
          'hot-reload-failed',
          `unexpected hot-reload failure: ${(err as Error).message}`,
        ),
      );
    }
  }

  private notice(
    level: ConfigNotice['level'],
    code: string,
    message: string,
  ): ConfigNotice {
    return { level, code, message };
  }
}

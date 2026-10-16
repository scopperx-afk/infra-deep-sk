/**
 * CONFIG_INITIALIZER — Config spec §6, §17.2, §17.7.
 *
 * Runs pipeline steps 1–7 (through Freeze); ConfigService itself is step 8 (Expose).
 * This file contains the ONE `process.exit(1)` call site in the module, gated by
 * `ConfigModuleOptions.exitOnValidationFailure` (default true) so tests can assert on
 * the thrown ConfigValidationError instead of spawning a subprocess.
 *
 * ── Registration ordering (spec §17.2 says Nest "handles this naturally") ────────
 * Nest instantiates providers of DIFFERENT modules concurrently; only DI dependencies
 * order them. `forFeature()` registrars depend on CONFIG_REGISTRY, not the other way
 * round, so nothing in the DI graph forces them to run before this factory. The
 * barrier below therefore yields one macrotask after Load (I/O) — enough for every
 * registrar (which needs only microtask progress) to have run — and then SEALS the
 * registry. If anything still tries to register afterwards it throws
 * ConfigRegistrationError at once: a timing assumption that fails LOUDLY at boot, never
 * as a namespace silently missing from validation.
 */
import {
  ConfigValidationError,
  type ConfigModuleOptions,
  type Environment,
} from './config.port';
import { HotReloadManager } from './hot-reload/hot-reload.manager';
import type { ListenerRegistry } from './hot-reload/hot-reload.listeners';
import type { ConfigNotifier } from './notices/config.notice';
import type { ConfigObservation } from './observation/config.observation';
import { formatFailureBanner } from './pipeline/config.error-format';
import { runProductionGuards } from './pipeline/config.guards';
import type { ConfigLoader } from './pipeline/config.loader';
import { buildEnvNameSuggester } from './pipeline/config.suggestions';
import type { ConfigValidator } from './pipeline/config.validator';
import type { ConfigRegistryImpl } from './schema/registry';
import { resolveSecretReferences } from './secrets/secret.resolution';
import type { SecretResolver } from './secrets/secret.resolver.port';
import type { ConfigSource } from './sources/config-source.port';
import type { ConfigStore, MergedEntry } from './store/config.store';
import { NODE_ENV_NAME } from './util/env-name';
import { deepFreeze } from './util/object';

export interface ConfigInitDeps {
  options: ConfigModuleOptions;
  sources: readonly ConfigSource[];
  registry: ConfigRegistryImpl;
  store: ConfigStore;
  loader: ConfigLoader;
  validator: ConfigValidator;
  observation: ConfigObservation;
  notifier: ConfigNotifier;
  listeners: ListenerRegistry;
  resolver: SecretResolver | null;
}

export interface ConfigInitResult {
  /** Stops any hot-reload watchers. Called from ConfigModule.onModuleDestroy(). */
  dispose(): void;
}

/** §11.5: a variable is only worth an "unused var" warning if it looks like ours. */
const NESTED_ENV_NAME_RE = /^[A-Z][A-Z0-9]*(__[A-Z0-9_]+)+$/;

function eligibleForUnusedWarning(
  entry: MergedEntry,
  legacy: ReadonlySet<string>,
): boolean {
  if (legacy.has(entry.envName)) return false; // Appendix B migration allowlist
  if (entry.origin === 'committed-file' || entry.origin === 'local-file')
    return true; // (a) any var in a loaded .env* file
  if (entry.envName === NODE_ENV_NAME) return true; // (c) NODE_ENV itself — spec §11.5. Unobservable today: it always maps
  //                                                     to `app.env`, which Config owns, so it can never be "unused".
  return NESTED_ENV_NAME_RE.test(entry.envName); // (b) process.env vars using the `__` nesting marker
}

export async function initializeConfig(
  deps: ConfigInitDeps,
): Promise<ConfigInitResult> {
  const {
    options,
    sources,
    registry,
    store,
    loader,
    validator,
    observation,
    notifier,
    listeners,
    resolver,
  } = deps;

  const fail = (errors: readonly string[]): never => {
    const banner = formatFailureBanner(errors);
    notifier.writeFatal(banner);
    if (options.exitOnValidationFailure !== false) process.exit(1); // the ONE call site (§17.7)
    throw new ConfigValidationError('config', banner, errors);
  };

  // ── Step 1: Load (parallel, provenance-tagged, no transformation) ────────────
  const { outcomes, errors: loadErrors } = await loader.loadSources(
    sources,
    observation,
    notifier,
  );
  for (const o of outcomes) {
    let health: { healthy: boolean; message?: string; latencyMs?: number } = {
      healthy: o.error === undefined,
    };
    try {
      health = await o.source.health();
    } catch (err) {
      health = { healthy: false, message: (err as Error).message };
    }
    observation.setSource({
      name: o.source.name,
      critical: o.source.critical,
      healthy: o.error === undefined && health.healthy,
      lastLoadAt: o.loadedAt,
      latencyMs: health.latencyMs ?? Math.round(o.durationSec * 1000),
      error: o.error ?? health.message,
      loadFailed: o.error !== undefined,
    });
  }
  observation.attachSources(sources);

  // ── Registration barrier (see header) ────────────────────────────────────────
  await new Promise<void>((resolve) => setImmediate(resolve));
  registry.seal();

  // ── Steps 2–3: Parse + Merge ─────────────────────────────────────────────────
  const merged = loader.parseAndMerge(outcomes, {
    isSecretRawPath: (p) => registry.isSecretRawPath(p),
    notifier,
  });

  // ── Step 4: Validate (4a/4b/4c) — every error at once ────────────────────────
  const validation = validator.validate(registry, merged);
  if (!validation.ok) return fail([...loadErrors, ...validation.errors]);
  if (loadErrors.length > 0) return fail(loadErrors); // a critical source failed even though the rest validated

  const env = (validation.snapshot['app'] as { env: Environment }).env;

  // ── Step 5: Production guards, on RAW provenance, before resolution ──────────
  const guardErrors = runProductionGuards({
    registry,
    merged,
    snapshot: validation.snapshot,
    env,
    resolverSchemes: resolver ? [resolver.prefix] : [],
  });
  if (guardErrors.length > 0) return fail(guardErrors);

  // ── Warnings (§7.9): unused vars, defaults used in production ────────────────
  const legacy = new Set(options.legacyEnvVars ?? []);
  const suggest = buildEnvNameSuggester(registry);
  for (const entry of validation.unknownEntries) {
    if (eligibleForUnusedWarning(entry, legacy)) {
      const didYouMean = suggest(entry.envName);
      notifier.notify({
        level: 'warning',
        code: 'unknown-var',
        message:
          `unused var: ${entry.envName}` +
          (didYouMean ? ` — did you mean ${didYouMean}?` : ''),
      });
    }
  }
  if (env === 'production' && validation.defaultedPaths.length > 0) {
    const shown = validation.defaultedPaths.slice(0, 20).join(', ');
    const more =
      validation.defaultedPaths.length > 20
        ? `, … (+${validation.defaultedPaths.length - 20} more)`
        : '';
    notifier.notify({
      level: 'warning',
      code: 'default-in-production',
      message: `${validation.defaultedPaths.length} value(s) fell back to schema defaults in production: ${shown}${more}`,
    });
  }

  // ── Step 6: Resolve secret references (only once a resolver exists) ──────────
  const resolved = await resolveSecretReferences({
    snapshot: validation.snapshot,
    registry,
    resolver,
    observation,
  });
  if (resolved.errors.length > 0) return fail(resolved.errors);

  // ── Step 7: Freeze, then commit (step 8 — Expose — is ConfigService) ─────────
  const frozen = deepFreeze(resolved.snapshot) as Readonly<
    Record<string, unknown>
  >;
  store.commitInitial(frozen, merged, resolved.secretRefs);
  observation.markLoaded(registry.namespaces().length);

  // ── Hot reload (dev/test dotenv watch only, until RemoteConfigSource ships) ──
  const hotReload = new HotReloadManager({
    options: options.hotReload,
    registry,
    validator,
    store,
    observation,
    notifier,
    listeners,
  });
  hotReload.start(sources, env);

  return { dispose: () => hotReload.stop() };
}

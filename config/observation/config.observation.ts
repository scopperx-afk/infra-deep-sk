/**
 * getHealth() / getMetricsSnapshot() state — Config spec §11.2, §11.3.
 *
 * Pull-based: Config never imports a Health or Metrics client, in either
 * direction. Health and Metrics (both permitted to depend on Layer 0) call the two
 * synchronous getters on ConfigService at their own cadence. No config VALUES ever
 * appear here — not in health, not in metric labels.
 */
import type {
  ConfigHealth,
  ConfigHistogramSample,
  ConfigMetricSample,
  ConfigMetricsSnapshot,
} from '../config.port';
import type { ConfigSource } from '../sources/config-source.port';

interface SourceState {
  name: string;
  critical: boolean;
  healthy: boolean;
  lastLoadAt?: string;
  latencyMs?: number;
  error?: string;
}

/** What the initializer records once per source, right after Load. */
export interface SourceLoadRecord extends SourceState {
  /** The last load() itself failed — sticky: a healthy watch can't paper over it. */
  loadFailed: boolean;
}

const labelKey = (name: string, labels: Record<string, string>): string =>
  `${name}|${Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(',')}`;

export class ConfigObservation {
  private readonly counters = new Map<string, ConfigMetricSample>();
  private readonly histograms = new Map<string, ConfigHistogramSample>();
  private readonly sourceStates = new Map<string, SourceState>();
  private readonly loadFailed = new Map<string, string | undefined>(); // name → load error, if the load failed
  private sources: readonly ConfigSource[] = [];
  private refreshing = false;
  private loaded = false;
  private schemaValid = false;
  private hotReloadActive = false;
  private namespacesRegistered = 0;

  // ── writers (internal) ──
  incCounter(name: string, labels: Record<string, string> = {}, by = 1): void {
    const key = labelKey(name, labels);
    const cur = this.counters.get(key);
    if (cur) cur.value += by;
    else this.counters.set(key, { name, labels, value: by });
  }

  observe(name: string, labels: Record<string, string>, seconds: number): void {
    const key = labelKey(name, labels);
    const cur = this.histograms.get(key);
    if (cur) {
      cur.count += 1;
      cur.sum += seconds;
    } else this.histograms.set(key, { name, labels, count: 1, sum: seconds });
  }

  setSource(record: SourceLoadRecord): void {
    const { loadFailed, ...state } = record;
    this.sourceStates.set(state.name, state);
    this.loadFailed.set(
      state.name,
      loadFailed ? (state.error ?? 'load failed') : undefined,
    );
  }

  /** Lets getHealth() keep source health current (see refreshInBackground). */
  attachSources(sources: readonly ConfigSource[]): void {
    this.sources = sources;
  }
  markLoaded(namespacesRegistered: number): void {
    this.loaded = true;
    this.schemaValid = true;
    this.namespacesRegistered = namespacesRegistered;
  }
  setHotReloadActive(active: boolean): void {
    this.hotReloadActive = active;
  }

  // ── readers (pull side) ──
  getHealth(configVersion: number): ConfigHealth {
    // getHealth() is synchronous (§11.2) but ConfigSource.health() is async. So each call
    // returns the last known state AND kicks off a non-blocking refresh: a watch connection
    // that dies is reported by "the next health() call" (§11.2) — exactly this contract.
    this.refreshInBackground();
    const health: ConfigHealth = {
      loaded: this.loaded,
      sources: [...this.sourceStates.values()].map((s) => ({ ...s })),
      schemaValid: this.schemaValid,
      hotReloadActive: this.hotReloadActive,
    };
    if (configVersion > 0) health.configVersion = configVersion;
    return health;
  }

  private refreshInBackground(): void {
    if (this.refreshing || this.sources.length === 0) return;
    this.refreshing = true;
    void Promise.all(
      this.sources.map(async (source) => {
        const current = this.sourceStates.get(source.name);
        if (!current) return;
        const loadError = this.loadFailed.get(source.name);
        try {
          const h = await source.health();
          this.sourceStates.set(source.name, {
            ...current,
            healthy: loadError === undefined && h.healthy,
            latencyMs: h.latencyMs ?? current.latencyMs,
            error: loadError ?? h.message,
          });
        } catch (err) {
          this.sourceStates.set(source.name, {
            ...current,
            healthy: false,
            error: (err as Error).message,
          });
        }
      }),
    ).finally(() => {
      this.refreshing = false;
    });
  }

  getMetricsSnapshot(configVersion: number): ConfigMetricsSnapshot {
    const gauges: ConfigMetricSample[] = [
      ...[...this.sourceStates.values()].map((s) => ({
        name: 'config_sources_healthy',
        labels: { source: s.name },
        value: s.healthy ? 1 : 0,
      })),
      {
        name: 'config_namespaces_registered',
        labels: {},
        value: this.namespacesRegistered,
      },
      { name: 'config_version', labels: {}, value: configVersion },
    ];
    return {
      counters: [...this.counters.values()].map((c) => ({
        ...c,
        labels: { ...c.labels },
      })),
      histograms: [...this.histograms.values()].map((h) => ({
        ...h,
        labels: { ...h.labels },
      })),
      gauges,
    };
  }
}

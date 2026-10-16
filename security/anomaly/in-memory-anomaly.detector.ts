/**
 * Default `AnomalyDetector` — Security spec §17.3: an in-memory sliding window.
 *
 * Per (principal, event) it keeps the timestamps of the last `threshold` occurrences; once
 * `threshold` events fall inside `windowMs`, `record()` returns `true` (and keeps returning
 * `true` while the burst continues). Memory is BOUNDED (architecture rule: no unbounded
 * buffer): at most `maxTrackedKeys` keys, least-recently-touched evicted first, and at most
 * `threshold` timestamps per key.
 *
 * Process-local by design — in a multi-instance deployment each instance sees only its own
 * share of a principal's traffic. Production wires a Redis-backed implementation through
 * `SecurityModule.forRoot({ anomalyDetector })` (§17.3), exactly like every other port.
 */
import type { Clock } from '../util/clock';
import { systemClock } from '../util/clock';
import type { AnomalyDetector } from './anomaly-detector.port';

export interface InMemoryAnomalyDetectorOptions {
  /** Default 5 events … */
  readonly threshold?: number;
  /** … within 60 seconds. */
  readonly windowMs?: number;
  readonly maxTrackedKeys?: number;
  readonly clock?: Clock;
}

export class InMemoryAnomalyDetector implements AnomalyDetector {
  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly maxTrackedKeys: number;
  private readonly clock: Clock;
  /** Insertion-ordered; re-inserted on touch, so the first key is always the least recently used. */
  private readonly windows = new Map<string, number[]>();
  private readonly keysByPrincipal = new Map<string, Set<string>>();

  constructor(options: InMemoryAnomalyDetectorOptions = {}) {
    this.threshold = options.threshold ?? 5;
    this.windowMs = options.windowMs ?? 60_000;
    this.maxTrackedKeys = options.maxTrackedKeys ?? 10_000;
    this.clock = options.clock ?? systemClock;
    if (!Number.isInteger(this.threshold) || this.threshold < 1) throw new RangeError('threshold must be a positive integer');
    if (!(this.windowMs > 0)) throw new RangeError('windowMs must be positive');
    if (!Number.isInteger(this.maxTrackedKeys) || this.maxTrackedKeys < 1) throw new RangeError('maxTrackedKeys must be a positive integer');
  }

  async record(principalId: string, event: string, _metadata?: Record<string, unknown>): Promise<boolean> {
    const key = `${principalId}\u0000${event}`;
    const now = this.clock.nowMs();
    const cutoff = now - this.windowMs;

    const previous = this.windows.get(key);
    const recent = previous ? previous.filter((t) => t > cutoff) : [];
    recent.push(now);
    if (recent.length > this.threshold) recent.splice(0, recent.length - this.threshold);

    this.windows.delete(key); // re-insert → most recently used
    this.windows.set(key, recent);
    let keys = this.keysByPrincipal.get(principalId);
    if (!keys) this.keysByPrincipal.set(principalId, (keys = new Set()));
    keys.add(key);

    this.evictIfNeeded();
    return recent.length >= this.threshold;
  }

  async reset(principalId: string): Promise<void> {
    const keys = this.keysByPrincipal.get(principalId);
    if (!keys) return;
    for (const key of keys) this.windows.delete(key);
    this.keysByPrincipal.delete(principalId);
  }

  private evictIfNeeded(): void {
    while (this.windows.size > this.maxTrackedKeys) {
      const oldest = this.windows.keys().next();
      if (oldest.done) return;
      const key = oldest.value;
      this.windows.delete(key);
      const principalId = key.slice(0, key.indexOf('\u0000'));
      const keys = this.keysByPrincipal.get(principalId);
      keys?.delete(key);
      if (keys && keys.size === 0) this.keysByPrincipal.delete(principalId);
    }
  }
}

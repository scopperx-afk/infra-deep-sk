/**
 * Default `ReplayProtectionStore` — an in-memory, TTL'd, size-bounded nonce set.
 *
 * `checkAndMark` is atomic here because it is fully synchronous inside one event-loop turn
 * (no `await` between the read and the write). Process-local: behind more than one instance a
 * replay can be accepted once PER INSTANCE — a production deployment overrides this with a
 * Redis `SET key NX EX ttl` backed store through `SecurityModule.forRoot({ replayProtectionStore })`.
 *
 * Bounded: when `maxEntries` is reached, expired entries are purged first and, only if still
 * full, the oldest entries are evicted (insertion order ≈ expiry order for uniform TTLs).
 * Eviction trades a sliver of replay protection for bounded memory — the alternative,
 * rejecting new legitimate nonces, is a self-inflicted outage.
 */
import { systemClock, type Clock } from '../util/clock';
import type { ReplayProtectionStore } from './replay-protection.port';

const MAX_TTL_SECONDS = 7 * 24 * 3600;

export class InMemoryReplayProtectionStore implements ReplayProtectionStore {
  private readonly entries = new Map<string, number>(); // nonce → expiry (epoch ms)

  constructor(
    private readonly options: { readonly maxEntries?: number; readonly clock?: Clock } = {},
  ) {}

  private get clock(): Clock {
    return this.options.clock ?? systemClock;
  }

  private get maxEntries(): number {
    return this.options.maxEntries ?? 100_000;
  }

  async checkAndMark(nonce: string, ttlSeconds: number): Promise<boolean> {
    if (typeof nonce !== 'string' || nonce === '') throw new TypeError('nonce must be a non-empty string');
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > MAX_TTL_SECONDS) {
      throw new RangeError(`ttlSeconds must be between 1 and ${MAX_TTL_SECONDS}`);
    }
    const now = this.clock.nowMs();
    const expiry = this.entries.get(nonce);
    if (expiry !== undefined && expiry > now) return true; // replay
    this.entries.delete(nonce); // an expired mark is a fresh sighting; re-insert at the tail
    if (this.entries.size >= this.maxEntries) this.makeRoom(now);
    this.entries.set(nonce, now + ttlSeconds * 1000);
    return false;
  }

  async clear(nonce: string): Promise<void> {
    this.entries.delete(nonce);
  }

  private makeRoom(now: number): void {
    for (const [nonce, expiry] of this.entries) {
      if (expiry <= now) this.entries.delete(nonce);
    }
    for (const nonce of this.entries.keys()) {
      if (this.entries.size < this.maxEntries) return;
      this.entries.delete(nonce);
    }
  }
}

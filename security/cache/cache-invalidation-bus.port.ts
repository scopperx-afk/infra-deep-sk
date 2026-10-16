/**
 * `CacheInvalidationBus` — Security spec §20.
 *
 * Borderline placement (the spec says so itself): arguably a Cache-module concern, defined
 * here as a stable contract so `ProfileValidator` implementations have something to
 * invalidate against today. The future Cache module implements it over Redis pub/sub with
 * this exact shape (cache spec §10) and the composition root swaps it in — this module's
 * public surface does not change.
 */
export interface CacheInvalidationBus {
  publish(channel: string, payload: unknown): Promise<void>;
  /** Resolves to an unsubscribe function. */
  subscribe(channel: string, handler: (payload: unknown) => void | Promise<void>): Promise<() => void>;
}

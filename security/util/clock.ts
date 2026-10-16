/**
 * Injectable time source. Architecture rule: nothing in this module reads
 * `Date.now()` directly in code that has a time-dependent decision (token expiry,
 * replay windows, anomaly windows) — it asks a `Clock`, so tests are deterministic.
 *
 * Config/Logger each carry their own tiny clock for the same reason; modules never
 * import each other's internals, so this one is Security's own.
 */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  nowMs(): number;
}

export const systemClock: Clock = Object.freeze({
  nowMs: (): number => Date.now(),
});

export const nowSeconds = (clock: Clock): number => Math.floor(clock.nowMs() / 1000);

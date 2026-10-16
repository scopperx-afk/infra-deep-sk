/**
 * computeBackoff() — Resilience spec §6.2.
 *
 * ONE exponential-plus-jitter delay curve, shared by every module that retries:
 * Resilience's retry loop, Queue's BullMQ custom backoff strategy, Events' relay, and the
 * boot-time connection retry in Database/Redis/Storage (`connect-with-retry.ts`). A plain,
 * stateless function — not a module — so siblings that may not import one another (Layer 3
 * modules forbid lateral imports) can all import it, and a change to the curve cannot drift
 * between them. The file name is spec-mandated (`infrastructure/shared/computeBackoff.ts`,
 * referenced by the Resilience, Events and Queue specs) — do not rename it.
 *
 *     delay = min(backoffMs × 2^attempt, maxDelayMs)  ±  jitterRatio
 *
 * Jitter is not cosmetic: without it, every caller that failed at the same instant (a
 * brief shared network blip, a rolling deploy restarting a whole fleet) retries at the
 * same instant too, turning a recovering dependency's first seconds back online into a
 * self-inflicted spike. The ceiling is applied BEFORE jitter, so the worst-case delay is
 * `maxDelayMs × (1 + jitterRatio)` — that is the documented behaviour, not an off-by-ε.
 *
 * Differences from the spec's sketch (additive; every spec call-site still compiles):
 *  - `random` is injectable (third parameter), so tests are deterministic;
 *  - inputs are VALIDATED. A NaN `backoffMs` used to flow silently through `Math.min`/
 *    `Math.round` and come out as `NaN`, which `setTimeout` treats as 0 ms — a retry loop
 *    that suddenly spins hot. A configuration mistake now fails loudly with a `RangeError`
 *    naming the offending field instead.
 */
export interface BackoffOptions {
  /** Initial delay (attempt 0), milliseconds. */
  readonly backoffMs: number;
  /** Ceiling applied BEFORE jitter, milliseconds. */
  readonly maxDelayMs: number;
  /** e.g. 0.2 = ±20 %. Must be within [0, 1]. */
  readonly jitterRatio: number;
}

/** 2 ** 52 is still exactly representable; capping the exponent also keeps `2 ** n` finite for any `attempt`. */
const MAX_EXPONENT = 52;

/**
 * @param attempt zero-based: 0 → `backoffMs`, 1 → `2 × backoffMs`, … Callers whose attempt
 *                counter is one-based (BullMQ's `attemptsMade`) pass `attemptsMade - 1`.
 * @param random  must return a value in [0, 1). Defaults to `Math.random` — jitter needs
 *                de-correlation, not unpredictability, so a non-cryptographic source is correct.
 * @returns a whole number of milliseconds, ≥ 0.
 */
export function computeBackoff(
  attempt: number,
  opts: BackoffOptions,
  random: () => number = Math.random,
): number {
  if (!Number.isFinite(opts.backoffMs) || opts.backoffMs < 0) {
    throw new RangeError('computeBackoff(): backoffMs must be a finite number >= 0');
  }
  if (!Number.isFinite(opts.maxDelayMs) || opts.maxDelayMs < 0) {
    throw new RangeError('computeBackoff(): maxDelayMs must be a finite number >= 0');
  }
  if (!Number.isFinite(opts.jitterRatio) || opts.jitterRatio < 0 || opts.jitterRatio > 1) {
    throw new RangeError('computeBackoff(): jitterRatio must be a number within [0, 1]');
  }
  // A non-numeric attempt is a caller bug, but "retry immediately" is the safe reading of it.
  const exponent = Math.min(Math.max(0, Number.isFinite(attempt) ? Math.floor(attempt) : 0), MAX_EXPONENT);
  const raw = Math.min(opts.backoffMs * 2 ** exponent, opts.maxDelayMs);
  const sample = random();
  const unit = Number.isFinite(sample) ? Math.min(Math.max(sample, 0), 1) : 0.5; // a broken RNG degrades to "no jitter"
  const jitter = raw * opts.jitterRatio * (unit * 2 - 1);
  return Math.max(0, Math.round(raw + jitter));
}

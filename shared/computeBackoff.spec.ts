import { computeBackoff } from './computeBackoff';

const opts = { backoffMs: 500, maxDelayMs: 8000, jitterRatio: 0.2 };
const noJitter = () => 0.5; // jitter = raw × ratio × (0.5×2 − 1) = 0

describe('computeBackoff (Resilience spec §6.2)', () => {
  it('follows min(backoffMs × 2^attempt, maxDelayMs) when jitter is neutral', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((a) => computeBackoff(a, opts, noJitter))).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000]);
  });

  it('applies jitter symmetrically within ±jitterRatio of the raw delay', () => {
    expect(computeBackoff(1, opts, () => 0)).toBe(800); // 1000 − 20 %
    expect(computeBackoff(1, opts, () => 0.999999)).toBe(1200); // 1000 + ~20 %
    for (let i = 0; i < 2000; i++) {
      const d = computeBackoff(2, opts, Math.random);
      expect(d).toBeGreaterThanOrEqual(1600);
      expect(d).toBeLessThanOrEqual(2400);
    }
  });

  it('jitter really de-correlates callers: many samples are not all the same value', () => {
    const samples = new Set(Array.from({ length: 200 }, () => computeBackoff(3, opts)));
    expect(samples.size).toBeGreaterThan(20);
  });

  it('is centred on the raw delay (unbiased jitter)', () => {
    let sum = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) sum += computeBackoff(2, opts);
    expect(Math.abs(sum / n - 2000)).toBeLessThan(25);
  });

  it('applies the ceiling BEFORE jitter: the worst case is maxDelayMs × (1 + jitterRatio)', () => {
    expect(computeBackoff(50, opts, () => 0.999999)).toBe(9600);
    expect(computeBackoff(50, opts, () => 0)).toBe(6400);
  });

  it('jitterRatio 0 is exactly deterministic, whatever the RNG says', () => {
    const exact = { ...opts, jitterRatio: 0 };
    expect(computeBackoff(2, exact, () => 0)).toBe(2000);
    expect(computeBackoff(2, exact, () => 0.99)).toBe(2000);
  });

  it('returns a non-negative whole number of milliseconds', () => {
    for (const a of [0, 1, 7, 1000]) {
      const d = computeBackoff(a, { backoffMs: 3, maxDelayMs: 77, jitterRatio: 1 });
      expect(Number.isInteger(d)).toBe(true);
      expect(d).toBeGreaterThanOrEqual(0);
    }
    expect(computeBackoff(0, { backoffMs: 0, maxDelayMs: 0, jitterRatio: 0.5 })).toBe(0);
  });

  it('never overflows or goes NaN for absurd attempt numbers', () => {
    expect(computeBackoff(1e9, opts, noJitter)).toBe(8000);
    expect(computeBackoff(Number.MAX_SAFE_INTEGER, opts, noJitter)).toBe(8000);
    expect(computeBackoff(Infinity, opts, noJitter)).toBe(500); // a non-finite attempt is read as 0
    expect(computeBackoff(NaN, opts, noJitter)).toBe(500);
    expect(computeBackoff(-5, opts, noJitter)).toBe(500);
    expect(computeBackoff(1.9, opts, noJitter)).toBe(1000); // fractional attempts floor
  });

  it('degrades a broken RNG to "no jitter" instead of emitting NaN', () => {
    expect(computeBackoff(1, opts, () => NaN)).toBe(1000);
    expect(computeBackoff(1, opts, () => 7)).toBe(1200); // clamped into [0, 1]
    expect(computeBackoff(1, opts, () => -3)).toBe(800);
  });

  it('REJECTS invalid options loudly — a NaN delay would make setTimeout fire immediately', () => {
    expect(() => computeBackoff(0, { ...opts, backoffMs: NaN })).toThrow(RangeError);
    expect(() => computeBackoff(0, { ...opts, backoffMs: -1 })).toThrow('backoffMs');
    expect(() => computeBackoff(0, { ...opts, maxDelayMs: Infinity })).toThrow('maxDelayMs');
    expect(() => computeBackoff(0, { ...opts, jitterRatio: 1.5 })).toThrow('jitterRatio');
    expect(() => computeBackoff(0, { ...opts, jitterRatio: -0.1 })).toThrow('jitterRatio');
    expect(() => computeBackoff(0, { ...opts, jitterRatio: NaN })).toThrow(RangeError);
  });

  it('is pure: identical inputs and RNG give identical output, and the options are never mutated', () => {
    const frozen = Object.freeze({ ...opts });
    expect(computeBackoff(3, frozen, noJitter)).toBe(computeBackoff(3, frozen, noJitter));
  });
});

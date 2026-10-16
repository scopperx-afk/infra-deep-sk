import { connectRetrySchema, DEFAULT_CONNECT_RETRY } from './connect-retry.schema';
import type { ConnectRetryOptions } from './connect-with-retry';

const parse = (v: unknown) => connectRetrySchema.safeParse(v);

describe('connectRetrySchema', () => {
  it('an absent block yields the documented defaults (5 / 500 / 8000, ±20 %, 10 s per attempt, no overall deadline)', () => {
    const r = parse(undefined);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data).toMatchObject({ ...DEFAULT_CONNECT_RETRY, jitterRatio: 0.2, attemptTimeoutMs: 10_000 });
    expect(r.data.overallDeadlineMs).toBeUndefined();
  });

  it('parses the env-style strings of the EXISTING .env keys unchanged', () => {
    const r = parse({ maxAttempts: '5', initialDelayMs: '500', maxDelayMs: '8000' });
    expect(r.success && r.data).toMatchObject({ maxAttempts: 5, initialDelayMs: 500, maxDelayMs: 8000 });
  });

  it('parses the optional extras; an empty value means "unset"', () => {
    const r = parse({ jitterRatio: '0.5', attemptTimeoutMs: '2000', overallDeadlineMs: '30000' });
    expect(r.success && r.data).toMatchObject({ jitterRatio: 0.5, attemptTimeoutMs: 2000, overallDeadlineMs: 30_000 });
    const empty = parse({ overallDeadlineMs: '' });
    expect(empty.success && empty.data.overallDeadlineMs).toBeUndefined();
  });

  it('the parsed value IS a valid ConnectRetryOptions (modules pass it straight to connectWithRetry)', () => {
    const r = parse({});
    if (!r.success) throw new Error('unreachable');
    const options: ConnectRetryOptions = r.data;
    expect(options.maxAttempts).toBe(5);
  });

  it('rejects out-of-range and inconsistent values', () => {
    for (const bad of [
      { maxAttempts: '0' }, { maxAttempts: '101' }, { maxAttempts: '2.5' }, { maxAttempts: 'many' },
      { initialDelayMs: '0' }, { maxDelayMs: '0' }, { jitterRatio: '1.5' }, { jitterRatio: '-0.1' }, { attemptTimeoutMs: '5' },
      { initialDelayMs: '9000', maxDelayMs: '8000' }, // ceiling below the floor
      { attemptTimeoutMs: '5000', overallDeadlineMs: '1000' }, // deadline shorter than one attempt
    ]) {
      expect(parse(bad).success).toBe(false);
    }
  });
});

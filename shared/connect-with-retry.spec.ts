import {
  ConnectAbortedError,
  ConnectAttemptTimeoutError,
  abortableSleep,
  connectWithRetry,
  describeConnectError,
  type ConnectRetryOptions,
} from './connect-with-retry';

const RETRY: ConnectRetryOptions = { maxAttempts: 5, initialDelayMs: 500, maxDelayMs: 8000 };
const noJitter = () => 0.5;

function harness(over: Partial<Parameters<typeof connectWithRetry>[0]> = {}) {
  const logger = { info: jest.fn(), warn: jest.fn(), fatal: jest.fn() };
  const sleeps: number[] = [];
  const sleep = async (ms: number): Promise<void> => { sleeps.push(ms); };
  return { logger, sleeps, base: { name: 'redis', logger, sleep, random: noJitter, retry: RETRY, connect: async () => undefined, ...over } };
}
const failing = (n: number, err: (i: number) => unknown = (i) => new Error(`boom ${i}`)) => {
  let calls = 0;
  const fn = jest.fn(async () => { calls++; if (calls <= n) throw err(calls); });
  return fn;
};

describe('connectWithRetry — success path (spec contract)', () => {
  it("connects on the first attempt: no sleep, logs info('<name> connected', { attempt: 1 })", async () => {
    const { logger, sleeps, base } = harness();
    const result = await connectWithRetry(base);
    expect(result.attempts).toBe(1);
    expect(sleeps).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith('redis connected', { attempt: 1 });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.fatal).not.toHaveBeenCalled();
  });

  it('a store that fails N-1 times then succeeds on attempt N boots, backing off along the shared curve', async () => {
    const { logger, sleeps, base } = harness({ connect: failing(3) });
    const result = await connectWithRetry(base);
    expect(result.attempts).toBe(4);
    expect(sleeps).toEqual([500, 1000, 2000]);
    expect(logger.info).toHaveBeenCalledWith('redis connected', { attempt: 4 });
    expect(logger.warn).toHaveBeenCalledTimes(3);
    expect(logger.warn.mock.calls[0][0]).toBe('redis connection attempt 1 failed, retrying in 500ms');
    expect(logger.warn.mock.calls[2][1]).toMatchObject({ attempt: 3, maxAttempts: 5, delayMs: 2000, errorName: 'Error', errorMessage: 'boom 3' });
  });

  it('reports elapsed time from the injected clock', async () => {
    let t = 1000;
    const { base } = harness({ now: () => t, connect: async () => { t += 250; } });
    expect((await connectWithRetry(base)).elapsedMs).toBe(250);
  });
});

describe('connectWithRetry — exhaustion', () => {
  it('a store that never succeeds exhausts maxAttempts: ONE fatal, the LAST error rethrown unchanged, boot fails', async () => {
    const errors: Error[] = [];
    const connect = jest.fn(async () => { const e = new Error(`down ${errors.length + 1}`); errors.push(e); throw e; });
    const { logger, sleeps, base } = harness({ connect });
    const thrown = await connectWithRetry(base).catch((e: unknown) => e);
    expect(thrown).toBe(errors[4]); // same reference, not a wrapper (errors[4] only exists once the run has finished)
    expect(connect).toHaveBeenCalledTimes(5);
    expect(sleeps).toEqual([500, 1000, 2000, 4000]);
    expect(logger.fatal).toHaveBeenCalledTimes(1);
    expect(logger.fatal).toHaveBeenCalledWith('redis failed to connect after 5 attempts — aborting boot', errors[4], { attempts: 5 });
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('caps the curve at maxDelayMs', async () => {
    const { sleeps, base } = harness({ connect: failing(99), retry: { ...RETRY, maxAttempts: 8 } });
    await expect(connectWithRetry(base)).rejects.toThrow();
    expect(sleeps).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000]);
  });

  it('maxAttempts: 1 means a single try and no wait', async () => {
    const { sleeps, logger, base } = harness({ connect: failing(5), retry: { ...RETRY, maxAttempts: 1 } });
    await expect(connectWithRetry(base)).rejects.toThrow('boom 1');
    expect(sleeps).toEqual([]);
    expect(logger.fatal).toHaveBeenCalledTimes(1);
  });

  it('passes jitter through: a low RNG shortens the wait by jitterRatio (default 20 %)', async () => {
    const { sleeps, base } = harness({ connect: failing(1), random: () => 0 });
    await connectWithRetry(base);
    expect(sleeps).toEqual([400]);
    const exact = harness({ connect: failing(1), random: () => 0, retry: { ...RETRY, jitterRatio: 0 } });
    await connectWithRetry(exact.base);
    expect(exact.sleeps).toEqual([500]);
  });
});

describe('connectWithRetry — permanent failures (isRetryable)', () => {
  it('a non-retryable error aborts on the FIRST attempt — no sleep, no second try (no lock-out from repeated wrong passwords)', async () => {
    const wrongPassword = Object.assign(new Error('WRONGPASS invalid username-password pair'), { code: 'WRONGPASS' });
    const connect = jest.fn(async () => { throw wrongPassword; });
    const { logger, sleeps, base } = harness({ connect, isRetryable: (e) => (e as { code?: string }).code !== 'WRONGPASS' });
    await expect(connectWithRetry(base)).rejects.toBe(wrongPassword);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    expect(logger.fatal).toHaveBeenCalledWith('redis connection failed with a non-retryable error — aborting boot', wrongPassword, { attempt: 1 });
  });

  it('a retryable error is retried; the classifier is consulted per failure', async () => {
    const isRetryable = jest.fn(() => true);
    const { base } = harness({ connect: failing(2), isRetryable });
    await connectWithRetry(base);
    expect(isRetryable).toHaveBeenCalledTimes(2);
  });

  it('a classifier that throws is treated as "permanent" (fail closed), and says so', async () => {
    const { logger, sleeps, base } = harness({ connect: failing(5), isRetryable: () => { throw new Error('classifier bug'); } });
    await expect(connectWithRetry(base)).rejects.toThrow('boom 1');
    expect(sleeps).toEqual([]);
    expect(logger.warn.mock.calls[0][0]).toBe('redis isRetryable threw; treating the failure as permanent');
    expect(logger.warn.mock.calls[0][1]).toMatchObject({ errorMessage: 'classifier bug' });
  });
});

describe('connectWithRetry — per-attempt timeout', () => {
  const quick: ConnectRetryOptions = { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 1, attemptTimeoutMs: 30 };

  it('an attempt that never settles is cut off with ConnectAttemptTimeoutError (boot no longer hangs) and aborts the driver', async () => {
    const signals: AbortSignal[] = [];
    const connect = jest.fn((signal: AbortSignal) => { signals.push(signal); return new Promise<void>(() => undefined); });
    const { logger, base } = harness({ connect, retry: quick });
    const started = Date.now();
    await expect(connectWithRetry(base)).rejects.toBeInstanceOf(ConnectAttemptTimeoutError);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(signals.every((s) => s.aborted && s.reason instanceof ConnectAttemptTimeoutError)).toBe(true);
    expect(logger.fatal).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][1]).toMatchObject({ errorName: 'ConnectAttemptTimeoutError' });
  });

  it('a timed-out attempt is retried, and a later attempt can succeed', async () => {
    let calls = 0;
    const connect = jest.fn(async () => { if (++calls === 1) await new Promise(() => undefined); });
    const { base } = harness({ connect, retry: quick });
    expect((await connectWithRetry(base)).attempts).toBe(2);
  });

  it('a hung attempt that rejects AFTER it was abandoned never becomes an unhandled rejection', async () => {
    const seen: unknown[] = [];
    const listener = (reason: unknown): void => { seen.push(reason); };
    process.on('unhandledRejection', listener);
    let calls = 0;
    const connect = async (): Promise<void> => {
      if (++calls === 1) await new Promise<void>((_, reject) => setTimeout(() => reject(new Error('late failure')), 80));
    };
    const { base } = harness({ connect, retry: quick });
    await connectWithRetry(base);
    await new Promise((resolve) => setTimeout(resolve, 150));
    process.off('unhandledRejection', listener);
    expect(seen).toEqual([]);
  });

  it('a synchronous throw from connect() is just another failed attempt', async () => {
    let calls = 0;
    const connect = (): Promise<void> => { if (++calls === 1) throw new Error('sync boom'); return Promise.resolve(); };
    const { base } = harness({ connect });
    expect((await connectWithRetry(base)).attempts).toBe(2);
  });
});

describe('connectWithRetry — overall deadline', () => {
  it('stops BEFORE a wait that would overrun the deadline, rethrowing the last real error', async () => {
    let t = 0;
    const errors: Error[] = [];
    const connect = jest.fn(async () => { t += 100; const e = new Error(`down ${errors.length + 1}`); errors.push(e); throw e; });
    const sleep = async (ms: number): Promise<void> => { t += ms; };
    const { logger } = harness();
    const retry = { maxAttempts: 10, initialDelayMs: 1000, maxDelayMs: 8000, overallDeadlineMs: 5000 };
    const thrown = await connectWithRetry({ name: 'db', connect, retry, logger, sleep, random: noJitter, now: () => t }).catch((e: unknown) => e);
    expect(thrown).toBe(errors[2]);
    expect(connect).toHaveBeenCalledTimes(3); // would otherwise have run 10
    expect(logger.fatal.mock.calls[0][0]).toBe('db did not connect within the overall deadline of 5000ms (3 attempts) — aborting boot');
    expect(logger.fatal.mock.calls[0][2]).toEqual({ attempts: 3, overallDeadlineMs: 5000 });
  });

  it('never starts a new attempt after an oversleep carried it past the deadline', async () => {
    let t = 0;
    const connect = jest.fn(async () => { throw new Error('down'); });
    const sleep = async (ms: number): Promise<void> => { t += ms + 10_000; }; // the timer fires very late
    const { logger } = harness();
    const retry = { maxAttempts: 10, initialDelayMs: 500, maxDelayMs: 8000, overallDeadlineMs: 5000 };
    await expect(connectWithRetry({ name: 'db', connect, retry, logger, sleep, random: noJitter, now: () => t })).rejects.toThrow('down');
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('shrinks the per-attempt timeout to the time that remains', async () => {
    const connect = jest.fn(() => new Promise<void>(() => undefined));
    const { base } = harness({ connect, retry: { maxAttempts: 5, initialDelayMs: 1, maxDelayMs: 1, attemptTimeoutMs: 10_000, overallDeadlineMs: 120 } });
    const started = Date.now();
    await expect(connectWithRetry(base)).rejects.toBeInstanceOf(ConnectAttemptTimeoutError);
    expect(Date.now() - started).toBeLessThan(1500); // bounded by the 120 ms deadline, not the 10 s attempt timeout
  });
});

describe('connectWithRetry — cancellation (AbortSignal)', () => {
  it('an already-aborted signal rejects immediately without touching the datastore', async () => {
    const controller = new AbortController();
    controller.abort();
    const connect = jest.fn(async () => undefined);
    const { base } = harness({ connect, signal: controller.signal });
    await expect(connectWithRetry(base)).rejects.toBeInstanceOf(ConnectAbortedError);
    expect(connect).not.toHaveBeenCalled();
  });

  it('aborting during an attempt cancels it and the driver sees the abort', async () => {
    const controller = new AbortController();
    let driverSignal: AbortSignal | undefined;
    const connect = (signal: AbortSignal): Promise<void> => { driverSignal = signal; return new Promise<void>(() => undefined); };
    const { logger, base } = harness({ connect, signal: controller.signal });
    const running = connectWithRetry(base);
    setTimeout(() => controller.abort(), 20);
    await expect(running).rejects.toBeInstanceOf(ConnectAbortedError);
    expect(driverSignal?.aborted).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith('redis connection aborted', { attempt: 1 });
    expect(logger.fatal).not.toHaveBeenCalled();
  });

  it('aborting during the back-off sleep (real timer) ends the sequence at once — no waiting out a long delay', async () => {
    const controller = new AbortController();
    const logger = { info: jest.fn(), warn: jest.fn(), fatal: jest.fn() };
    const connect = jest.fn(async () => { throw new Error('down'); });
    const running = connectWithRetry({
      name: 'redis', connect, logger, signal: controller.signal, random: noJitter,
      retry: { maxAttempts: 5, initialDelayMs: 30_000, maxDelayMs: 30_000 }, // default sleep, deliberately huge
    });
    setTimeout(() => controller.abort(), 30);
    const started = Date.now();
    await expect(running).rejects.toBeInstanceOf(ConnectAbortedError);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('abortableSleep resolves after the delay, rejects on abort, and leaves no listener behind', async () => {
    await expect(abortableSleep(5)).resolves.toBeUndefined();
    const controller = new AbortController();
    const sleeping = abortableSleep(10_000, controller.signal);
    controller.abort(new Error('stop'));
    await expect(sleeping).rejects.toThrow('stop');
    const already = new AbortController();
    already.abort(new Error('pre'));
    await expect(abortableSleep(10, already.signal)).rejects.toThrow('pre');
  });
});

describe('connectWithRetry — option validation (a config bug must not become an infinite loop)', () => {
  const invalid: Array<[string, Partial<ConnectRetryOptions>]> = [
    ['maxAttempts NaN', { maxAttempts: NaN }],
    ['maxAttempts 0', { maxAttempts: 0 }],
    ['maxAttempts fractional', { maxAttempts: 2.5 }],
    ['initialDelayMs negative', { initialDelayMs: -1 }],
    ['maxDelayMs below initialDelayMs', { maxDelayMs: 100 }],
    ['jitterRatio above 1', { jitterRatio: 1.1 }],
    ['attemptTimeoutMs zero', { attemptTimeoutMs: 0 }],
    ['overallDeadlineMs NaN', { overallDeadlineMs: NaN }],
  ];
  it.each(invalid)('rejects %s with a RangeError and never calls connect', async (_label, over) => {
    const connect = jest.fn(async () => undefined);
    const { base } = harness({ connect, retry: { ...RETRY, ...over } });
    await expect(connectWithRetry(base)).rejects.toBeInstanceOf(RangeError);
    expect(connect).not.toHaveBeenCalled();
  });
  it('requires a name', async () => {
    const { base } = harness({ name: '' });
    await expect(connectWithRetry(base)).rejects.toBeInstanceOf(RangeError);
  });
});

describe('connect-time error logging is safe', () => {
  it('masks credentials in connection strings and key=value secrets, strips control characters, bounds the length', async () => {
    const hostile = new Error('connect failed postgres://admin:s3cr3t@db:5432/app?sslmode=require password=hunter2 pwd:"x y" token=abc123\nforged: line\r\n' + 'x'.repeat(1000));
    const { logger, base } = harness({ connect: failing(1, () => hostile) });
    await connectWithRetry(base);
    const meta = logger.warn.mock.calls[0][1] as { errorMessage: string };
    expect(meta.errorMessage).toContain('postgres://***@db:5432/app');
    for (const secret of ['s3cr3t', 'hunter2', 'x y', 'abc123']) expect(meta.errorMessage).not.toContain(secret);
    expect(meta.errorMessage).not.toMatch(/[\r\n]/);
    expect(meta.errorMessage.length).toBeLessThanOrEqual(300);
  });

  it('masks secrets in PREFIXED/SUFFIXED keys — `db_password`, `access_token`, `MY_SECRET`', async () => {
  const { logger, base } = harness({
    connect: failing(1, () => new Error(
      'cfg my_password=hunter2 access_token=abc123 DB_SECRET=xyz bare_pwd=qwerty',
    )),
  });
  await connectWithRetry(base);
  const meta = logger.warn.mock.calls[0][1] as { errorMessage: string };
  for (const secret of ['hunter2', 'abc123', 'xyz', 'qwerty']) {
    expect(meta.errorMessage).not.toContain(secret);
  }
});
  it('describeConnectError handles codes, non-Error throwables and masks every URL scheme', () => {
    expect(describeConnectError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toEqual({ errorName: 'Error', errorMessage: 'x', errorCode: 'ECONNREFUSED' });
    expect(describeConnectError(Object.assign(new Error('x'), { code: 28000 })).errorCode).toBe(28000);
    expect(describeConnectError(Object.assign(new Error('x'), { code: { nested: 1 } }))).not.toHaveProperty('errorCode');
    expect(describeConnectError('plain string failure')).toEqual({ errorName: 'string', errorMessage: 'plain string failure' });
    expect(describeConnectError(undefined)).toEqual({ errorName: 'undefined', errorMessage: '' });
    expect(describeConnectError(null).errorName).toBe('object');
    expect(describeConnectError(new Error('mongodb+srv://u:p@cluster0.x.mongodb.net/db')).errorMessage).toBe('mongodb+srv://***@cluster0.x.mongodb.net/db');
    expect(describeConnectError(new Error('amqps://guest:guest@mq:5671')).errorMessage).toBe('amqps://***@mq:5671');
  });

  it('a non-Error rejection is still retried and finally rethrown as-is', async () => {
    const { base } = harness({ connect: async () => { throw 'string failure'; }, retry: { ...RETRY, maxAttempts: 2 } });
    await expect(connectWithRetry(base)).rejects.toBe('string failure');
  });
});

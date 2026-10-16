import type { LogEntry, LogLevel } from '../logger.port';
import { LoggerObservation } from '../observation/logger.observation';
import type { LogTransport, TransportHealth } from './transport.interface';
import { TransportDispatcher } from './transport-dispatcher';

const entry = (level: LogLevel, message = 'x'): LogEntry => ({
  timestamp: 't',
  level,
  message,
});
const flush = () => new Promise((r) => setImmediate(r));

/** A transport whose write() stays pending until the test explicitly resolves it —
 *  lets us deterministically put the dispatcher into an "in flight" state. */
class ControllableTransport implements LogTransport {
  readonly name: string;
  readonly writes: LogEntry[] = [];
  closeCalled = false;
  healthy = true;
  healthMessage: string | undefined;
  private pending: Array<(err?: Error) => void> = [];

  constructor(name = 'controllable') {
    this.name = name;
  }
  write(entry: LogEntry): Promise<void> {
    this.writes.push(entry);
    return new Promise((resolve, reject) => {
      this.pending.push((err) => (err ? reject(err) : resolve()));
    });
  }
  health(): TransportHealth {
    return this.healthy
      ? { healthy: true }
      : { healthy: false, message: this.healthMessage };
  }
  async close(): Promise<void> {
    this.closeCalled = true;
  }
  settleOldest(err?: Error): void {
    const fn = this.pending.shift();
    if (!fn) throw new Error('no pending write to settle');
    fn(err);
  }
  get pendingCount(): number {
    return this.pending.length;
  }
}

/** A transport that writes synchronously and immediately (no backpressure needed). */
class SyncTransport implements LogTransport {
  readonly name = 'sync';
  readonly writes: LogEntry[] = [];
  write(entry: LogEntry): void {
    this.writes.push(entry);
  }
  health(): TransportHealth {
    return { healthy: true };
  }
  async close(): Promise<void> {}
}

describe('TransportDispatcher — synchronous transports', () => {
  it('dispatches directly, with no queuing needed', () => {
    const t = new SyncTransport();
    const d = new TransportDispatcher(
      { transport: t, critical: true },
      new LoggerObservation(),
    );
    d.dispatch('info', entry('info'));
    expect(t.writes).toHaveLength(1);
  });

  it('a throwing synchronous write is isolated — never propagates to the caller', () => {
    const t = new SyncTransport();

    (t as any).write = () => {
      throw new Error('sync boom');
    };
    const observation = new LoggerObservation();
    const d = new TransportDispatcher(
      { transport: t, critical: false },
      observation,
    );
    expect(() => d.dispatch('info', entry('info'))).not.toThrow();
    expect(observation.getMetricsSnapshot().transportErrorsTotal).toBe(1);
  });
});

describe('TransportDispatcher — async backpressure (§22)', () => {
  it('queues a second entry while the first write is still in flight, then delivers it once the first settles', async () => {
    const t = new ControllableTransport();
    const d = new TransportDispatcher(
      { transport: t, critical: true },
      new LoggerObservation(),
      10,
    );
    d.dispatch('info', entry('info', 'first'));
    d.dispatch('info', entry('info', 'second'));
    expect(t.writes).toHaveLength(1); // second is queued, not yet handed to the transport
    t.settleOldest();
    await flush();
    expect(t.writes).toHaveLength(2);
    expect(t.writes[1].message).toBe('second');
  });

  it('evicts the lowest-priority queued entry on overflow and records a buffer_overflow drop (§26)', async () => {
    const t = new ControllableTransport();
    const observation = new LoggerObservation();
    const d = new TransportDispatcher(
      { transport: t, critical: true },
      observation,
      2,
    ); // capacity 2 while busy
    d.dispatch('info', entry('info', 'in-flight')); // occupies the in-flight slot
    d.dispatch('trace', entry('trace', 'low'));
    d.dispatch('debug', entry('debug', 'mid'));
    d.dispatch('fatal', entry('fatal', 'high')); // should evict 'low' (trace) to fit

    const drops = observation.getMetricsSnapshot().logsDroppedByReason;
    expect(drops).toEqual([
      {
        reason: 'buffer_overflow',
        level: 'trace',
        transport: t.name,
        count: 1,
      },
    ]);

    t.settleOldest(); // finishes 'in-flight'
    await flush();
    t.settleOldest();
    await flush();
    t.settleOldest();
    await flush();
    expect(t.writes.map((w) => w.message)).toEqual([
      'in-flight',
      'mid',
      'high',
    ]); // 'low' never delivered
  });

  it('a rejected write is isolated (no unhandled rejection, no throw) and the queue keeps draining', async () => {
    const t = new ControllableTransport();
    const observation = new LoggerObservation();
    const d = new TransportDispatcher(
      { transport: t, critical: false },
      observation,
      10,
    );
    d.dispatch('info', entry('info', 'a'));
    d.dispatch('info', entry('info', 'b'));
    t.settleOldest(new Error('network blip')); // 'a' fails
    await flush();
    expect(observation.getMetricsSnapshot().transportErrorsTotal).toBe(1);
    expect(t.writes.map((w) => w.message)).toEqual(['a', 'b']); // 'b' still got dispatched despite 'a' failing
    t.settleOldest();
    await flush();
  });
});

describe('TransportDispatcher — health (§25)', () => {
  it("delegates to the transport's own health(), including its critical flag", () => {
    const t = new SyncTransport();
    const d = new TransportDispatcher(
      { transport: t, critical: true },
      new LoggerObservation(),
    );
    expect(d.health()).toEqual({ healthy: true });
    expect(d.critical).toBe(true);
    expect(d.name).toBe('sync');
  });

  it('a health() call that itself throws is caught and reported as unhealthy, never propagated', () => {
    const t = new SyncTransport();

    (t as any).health = () => {
      throw new Error('health check exploded');
    };
    const d = new TransportDispatcher(
      { transport: t, critical: false },
      new LoggerObservation(),
    );
    expect(() => d.health()).not.toThrow();
    expect(d.health()).toMatchObject({ healthy: false });
  });
});

describe('TransportDispatcher — close() (§34)', () => {
  it('drains whatever is still buffered once nothing is in flight, then calls close() on the transport', async () => {
    const t = new ControllableTransport();
    const d = new TransportDispatcher(
      { transport: t, critical: true },
      new LoggerObservation(),
      10,
    );
    d.dispatch('info', entry('info', 'in-flight'));
    d.dispatch('info', entry('info', 'queued'));

    t.settleOldest(); // finishes 'in-flight' → dispatcher's own onWriteSettled() drains 'queued' next
    await flush();
    expect(t.writes.map((w) => w.message)).toEqual(['in-flight', 'queued']);
    t.settleOldest(); // finishes 'queued'
    await flush();

    await d.close(1000); // nothing left in flight or buffered
    expect(t.closeCalled).toBe(true);
  });

  it('waits out an in-flight write, THEN drains the buffer, using real timers deterministically', async () => {
    jest.useFakeTimers();
    try {
      const t = new ControllableTransport();
      const d = new TransportDispatcher(
        { transport: t, critical: true },
        new LoggerObservation(),
        10,
      );
      d.dispatch('info', entry('info', 'in-flight'));
      d.dispatch('info', entry('info', 'queued')); // buffered — a write is already in flight

      const closePromise = d.close(5000);
      // close()'s own wait loop polls every 10ms; settle the in-flight write, then let one poll tick pass.
      t.settleOldest();
      await Promise.resolve(); // let the write's own .then() (onWriteSettled) microtask run first
      await jest.advanceTimersByTimeAsync(10);
      // The wait loop has now observed inFlight===false and moved on to draining the buffer,
      // which calls transport.write('queued') directly — settle that too.
      t.settleOldest();
      await jest.advanceTimersByTimeAsync(0);
      await closePromise;

      expect(t.closeCalled).toBe(true);
      expect(t.writes.map((w) => w.message)).toEqual(['in-flight', 'queued']);
    } finally {
      jest.useRealTimers();
    }
  });

  it('never lets a close()-time failure block shutdown', async () => {
    const t = new SyncTransport();

    (t as any).close = async () => {
      throw new Error('close failed');
    };
    const d = new TransportDispatcher(
      { transport: t, critical: true },
      new LoggerObservation(),
    );
    await expect(d.close(1000)).resolves.toBeUndefined();
  });

  it('dispatch() after close() is a no-op — never reopens or queues into a shutting-down transport', async () => {
    const t = new SyncTransport();
    const d = new TransportDispatcher(
      { transport: t, critical: true },
      new LoggerObservation(),
    );
    await d.close(1000);
    d.dispatch('info', entry('info'));
    expect(t.writes).toHaveLength(0);
  });

  it('respects the timeout budget rather than waiting forever on a stuck transport', async () => {
    const t = new ControllableTransport();
    const d = new TransportDispatcher(
      { transport: t, critical: true },
      new LoggerObservation(),
      10,
    );
    d.dispatch('info', entry('info', 'stuck')); // never settled by the test — simulates a hung transport
    const start = Date.now();
    await d.close(50);
    expect(Date.now() - start).toBeLessThan(500); // bounded, not hanging indefinitely
  });
});

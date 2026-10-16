import { InMemoryAnomalyDetector } from './anomaly/in-memory-anomaly.detector';
import { InMemoryCacheInvalidationBus } from './cache/in-memory-cache-invalidation.bus';
import { LoggerAlertEmitter } from './alerts/logger-alert.emitter';
import type { SecurityAlert } from './alerts/security-alert.port';
import { InMemoryReplayProtectionStore } from './protocol/in-memory-replay-protection.store';
import { recordingLogger } from './testing/security-test-utils';

const clock = (start = 1_000_000) => {
  let now = start;
  return { nowMs: () => now, advance: (ms: number) => { now += ms; } };
};
const alert = (severity: SecurityAlert['severity']): SecurityAlert => ({
  type: 'brute_force', severity, principalId: 'u1', ip: '1.2.3.4', details: { attempts: 9 }, occurredAt: new Date(0).toISOString(),
});

describe('LoggerAlertEmitter (§17.2)', () => {
  it('maps severity to log level: low/medium → warn, high → error, critical → fatal', async () => {
    const logger = recordingLogger();
    const emitter = new LoggerAlertEmitter(logger);
    for (const s of ['low', 'medium', 'high', 'critical'] as const) await emitter.emit(alert(s));
    expect(logger.logs.map((l) => l.level)).toEqual(['warn', 'warn', 'error', 'fatal']);
    expect(logger.logs[0]).toMatchObject({ message: 'security.alert.brute_force', metadata: { severity: 'low', principalId: 'u1', ip: '1.2.3.4', details: { attempts: 9 } } });
  });
  it('NEVER throws, even when the logger itself does', async () => {
    const broken = { warn: () => { throw new Error('sink down'); }, error: () => { throw new Error('x'); }, fatal: () => { throw new Error('x'); } } as never;
    const emitter = new LoggerAlertEmitter(broken);
    for (const s of ['low', 'high', 'critical'] as const) await expect(emitter.emit(alert(s))).resolves.toBeUndefined();
  });
});

describe('InMemoryAnomalyDetector (§17.3)', () => {
  it('flags once `threshold` events land inside the window, per principal and event', async () => {
    const c = clock();
    const d = new InMemoryAnomalyDetector({ threshold: 3, windowMs: 60_000, clock: c });
    expect(await d.record('u1', 'login_failed')).toBe(false);
    expect(await d.record('u1', 'login_failed')).toBe(false);
    expect(await d.record('u1', 'login_failed')).toBe(true);
    expect(await d.record('u1', 'other_event')).toBe(false);
    expect(await d.record('u2', 'login_failed')).toBe(false);
  });
  it('events age out of the sliding window', async () => {
    const c = clock();
    const d = new InMemoryAnomalyDetector({ threshold: 3, windowMs: 60_000, clock: c });
    await d.record('u', 'e'); await d.record('u', 'e');
    c.advance(61_000);
    expect(await d.record('u', 'e')).toBe(false); // the two old ones expired
  });
  it('reset() clears every event of a principal', async () => {
    const d = new InMemoryAnomalyDetector({ threshold: 2, clock: clock() });
    await d.record('u', 'a'); await d.record('u', 'b');
    await d.reset('u');
    expect(await d.record('u', 'a')).toBe(false);
    expect(await d.record('u', 'b')).toBe(false);
    await d.reset('never-seen');
  });
  it('memory is BOUNDED: the least-recently-used keys are evicted past maxTrackedKeys', async () => {
    const d = new InMemoryAnomalyDetector({ threshold: 2, maxTrackedKeys: 3, clock: clock() });
    await d.record('a', 'e'); // would be at 1/2
    await d.record('b', 'e'); await d.record('c', 'e'); await d.record('d', 'e'); // evicts a
    expect(await d.record('a', 'e')).toBe(false); // a started over
    expect((d as unknown as { windows: Map<string, unknown> }).windows.size).toBeLessThanOrEqual(3);
  });
  it('validates its options', () => {
    expect(() => new InMemoryAnomalyDetector({ threshold: 0 })).toThrow(RangeError);
    expect(() => new InMemoryAnomalyDetector({ windowMs: 0 })).toThrow(RangeError);
    expect(() => new InMemoryAnomalyDetector({ maxTrackedKeys: 0 })).toThrow(RangeError);
  });
});

describe('InMemoryReplayProtectionStore (§18.2)', () => {
  it('first sighting is false (and marks it); an identical nonce inside the TTL is a replay', async () => {
    const s = new InMemoryReplayProtectionStore({ clock: clock() });
    expect(await s.checkAndMark('n1', 60)).toBe(false);
    expect(await s.checkAndMark('n1', 60)).toBe(true);
    expect(await s.checkAndMark('n2', 60)).toBe(false);
  });
  it('is atomic under concurrency: of many simultaneous identical nonces exactly ONE passes', async () => {
    const s = new InMemoryReplayProtectionStore({ clock: clock() });
    const results = await Promise.all(Array.from({ length: 50 }, () => s.checkAndMark('same', 60)));
    expect(results.filter((replay) => replay === false)).toHaveLength(1);
  });
  it('a nonce is fresh again once its TTL has elapsed; clear() resets it', async () => {
    const c = clock();
    const s = new InMemoryReplayProtectionStore({ clock: c });
    await s.checkAndMark('n', 10);
    c.advance(11_000);
    expect(await s.checkAndMark('n', 10)).toBe(false);
    await s.clear('n');
    expect(await s.checkAndMark('n', 10)).toBe(false);
  });
  it('is size-bounded and validates its input', async () => {
    const s = new InMemoryReplayProtectionStore({ maxEntries: 3, clock: clock() });
    for (const n of ['a', 'b', 'c', 'd', 'e']) await s.checkAndMark(n, 60);
    expect((s as unknown as { entries: Map<string, number> }).entries.size).toBeLessThanOrEqual(3);
    await expect(s.checkAndMark('', 60)).rejects.toThrow(TypeError);
    await expect(s.checkAndMark('x', 0)).rejects.toThrow(RangeError);
    await expect(s.checkAndMark('x', 10 ** 9)).rejects.toThrow(RangeError);
  });
});

describe('InMemoryCacheInvalidationBus (§20)', () => {
  it('delivers a payload to every subscriber of the channel only, and unsubscribe works', async () => {
    const bus = new InMemoryCacheInvalidationBus();
    const a: unknown[] = []; const b: unknown[] = []; const other: unknown[] = [];
    const unsubA = await bus.subscribe('user.invalidated', (p) => { a.push(p); });
    await bus.subscribe('user.invalidated', async (p) => { b.push(p); });
    await bus.subscribe('other', (p) => { other.push(p); });
    await bus.publish('user.invalidated', { id: 1 });
    unsubA();
    await bus.publish('user.invalidated', { id: 2 });
    expect(a).toEqual([{ id: 1 }]);
    expect(b).toEqual([{ id: 1 }, { id: 2 }]);
    expect(other).toEqual([]);
    await bus.publish('nobody-listens', 1);
  });
  it('a throwing or rejecting handler never affects the publisher or the other handlers', async () => {
    const bus = new InMemoryCacheInvalidationBus();
    const seen: unknown[] = [];
    await bus.subscribe('c', () => { throw new Error('sync boom'); });
    await bus.subscribe('c', async () => { throw new Error('async boom'); });
    await bus.subscribe('c', (p) => { seen.push(p); });
    await expect(bus.publish('c', 'x')).resolves.toBeUndefined();
    expect(seen).toEqual(['x']);
  });
});

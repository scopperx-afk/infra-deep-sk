import { PriorityDropBuffer } from './priority-buffer';

describe('PriorityDropBuffer — basic capacity behavior (§22)', () => {
  it('accepts entries up to capacity with no eviction', () => {
    const b = new PriorityDropBuffer<string>(3);
    expect(b.enqueue('info', 'a')).toEqual({ accepted: true });
    expect(b.enqueue('info', 'b')).toEqual({ accepted: true });
    expect(b.enqueue('info', 'c')).toEqual({ accepted: true });
    expect(b.size).toBe(3);
  });

  it('dequeue returns entries in FIFO arrival order', () => {
    const b = new PriorityDropBuffer<string>(5);
    b.enqueue('info', 'a');
    b.enqueue('info', 'b');
    b.enqueue('info', 'c');
    expect(b.dequeue()?.item).toBe('a');
    expect(b.dequeue()?.item).toBe('b');
    expect(b.dequeue()?.item).toBe('c');
    expect(b.dequeue()).toBeUndefined();
  });

  it('rejects a non-positive or non-integer capacity', () => {
    expect(() => new PriorityDropBuffer(0)).toThrow(RangeError);
    expect(() => new PriorityDropBuffer(-1)).toThrow(RangeError);
    expect(() => new PriorityDropBuffer(1.5)).toThrow(RangeError);
  });
});

describe('PriorityDropBuffer — priority-aware eviction on overflow (§22)', () => {
  it('evicts the lowest-priority entry (TRACE) to make room for a higher-priority one (FATAL)', () => {
    const b = new PriorityDropBuffer<string>(2);
    b.enqueue('trace', 't1');
    b.enqueue('info', 'i1');
    const result = b.enqueue('fatal', 'f1');
    expect(result.accepted).toBe(true);
    expect(result.evicted).toEqual({ level: 'trace', item: 't1' });
    expect(b.size).toBe(2);
    expect(b.drain().map((e) => e.item)).toEqual(['i1', 'f1']);
  });

  it('drops the INCOMING entry itself when it is no more important than anything buffered', () => {
    const b = new PriorityDropBuffer<string>(2);
    b.enqueue('error', 'e1');
    b.enqueue('error', 'e2');
    const result = b.enqueue('trace', 't1'); // trace is lower priority than everything present
    expect(result.accepted).toBe(false);
    expect(result.evicted).toEqual({ level: 'trace', item: 't1' });
    expect(b.drain().map((e) => e.item)).toEqual(['e1', 'e2']); // buffer unchanged
  });

  it('a same-priority incoming entry is REJECTED, not swapped in — ties favor what already arrived (stable order)', () => {
    const b = new PriorityDropBuffer<string>(2);
    b.enqueue('info', 'i1');
    b.enqueue('info', 'i2');
    const result = b.enqueue('info', 'i3'); // same priority as everything buffered
    expect(result.accepted).toBe(false);
    expect(result.evicted).toEqual({ level: 'info', item: 'i3' });
    expect(b.drain().map((e) => e.item)).toEqual(['i1', 'i2']); // buffer unchanged
  });

  it('respects the full drop order across every tier: trace < debug < info < (audit=warn) < error < fatal', () => {
    const b = new PriorityDropBuffer<string>(6);
    for (const level of [
      'fatal',
      'error',
      'warn',
      'info',
      'debug',
      'trace',
    ] as const)
      b.enqueue(level, level);
    expect(b.size).toBe(6);
    // Push one more FATAL: must evict TRACE (the lowest present), not any other tier.
    const result = b.enqueue('fatal', 'fatal-2');
    expect(result.evicted?.level).toBe('trace');
  });

  it("AUDIT shares WARN's priority tier (§22 omits AUDIT from its own table — see SPEC-ERRATA.md E-L4)", () => {
    const b = new PriorityDropBuffer<string>(2);
    b.enqueue('audit', 'a1');
    b.enqueue('warn', 'w1');
    // Both tier 3 (audit, warn); a new INFO (tier 2, lower) must be the one dropped, not audit/warn.
    const result = b.enqueue('info', 'i1');
    expect(result.accepted).toBe(false);
    expect(result.evicted).toEqual({ level: 'info', item: 'i1' });

    // But a new ERROR (tier 4, higher than both) evicts one of the tier-3 entries — audit and warn
    // are equally eligible; whichever the implementation picks, it must be one of THOSE two, not
    // arbitrary — confirmed by checking the survivor set excludes exactly one of {a1, w1}.
    const before = b.drain(); // [a1, w1] — re-seed since drain() emptied it
    for (const { level, item } of before) b.enqueue(level, item);
    const r2 = b.enqueue('error', 'e1');
    expect(r2.accepted).toBe(true);
    expect(['a1', 'w1']).toContain(r2.evicted?.item);
    expect(b.drain().map((e) => e.item)).toContain('e1');
  });

  it('never throws on overflow — the whole point of a backpressure buffer', () => {
    const b = new PriorityDropBuffer<number>(1);
    expect(() => {
      for (let i = 0; i < 1000; i++) b.enqueue('trace', i);
    }).not.toThrow();
  });
});

describe('PriorityDropBuffer.drain()', () => {
  it('empties the buffer and returns everything in arrival order', () => {
    const b = new PriorityDropBuffer<string>(3);
    b.enqueue('info', 'a');
    b.enqueue('warn', 'b');
    const drained = b.drain();
    expect(drained.map((e) => e.item)).toEqual(['a', 'b']);
    expect(b.size).toBe(0);
  });
});

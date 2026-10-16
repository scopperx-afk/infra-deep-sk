import { LOG_FORCE, LogSampler, forceLog } from './log-sampler';

const fixedRandom = (...values: number[]) => {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
};

describe('LogSampler — ratio sampling for TRACE/DEBUG/INFO (§16)', () => {
  it('ratio 1 always samples without even calling random() (hot-path shortcut)', () => {
    const random = jest.fn(() => 0.999);
    const s = new LogSampler({ trace: 1, debug: 1, info: 1 }, random);
    expect(s.shouldSample('info', undefined)).toBe(true);
    expect(random).not.toHaveBeenCalled();
  });

  it('ratio 0 never samples without even calling random()', () => {
    const random = jest.fn(() => 0.0001);
    const s = new LogSampler({ trace: 0, debug: 0, info: 0 }, random);
    expect(s.shouldSample('debug', undefined)).toBe(false);
    expect(random).not.toHaveBeenCalled();
  });

  it('a fractional ratio compares against random() correctly at the boundary', () => {
    const s = new LogSampler(
      { trace: 0.5, debug: 0.5, info: 0.5 },
      fixedRandom(0.49, 0.5, 0.51),
    );
    expect(s.shouldSample('trace', undefined)).toBe(true); // 0.49 < 0.5
    expect(s.shouldSample('trace', undefined)).toBe(false); // 0.5 is NOT < 0.5
    expect(s.shouldSample('trace', undefined)).toBe(false); // 0.51 < 0.5 is false
  });

  it('updateRatios() changes behavior for subsequent calls', () => {
    const s = new LogSampler({ trace: 0, debug: 0, info: 0 });
    expect(s.shouldSample('trace', undefined)).toBe(false);
    s.updateRatios({ trace: 1, debug: 1, info: 1 });
    expect(s.shouldSample('trace', undefined)).toBe(true);
  });
});

describe('LogSampler — critical levels are NEVER sampled away (§16)', () => {
  it.each(['audit', 'warn', 'error', 'fatal'] as const)(
    '%s always passes even with ratio-0 settings',
    (level) => {
      const s = new LogSampler({ trace: 0, debug: 0, info: 0 }, () => 0); // random()=0 would fail almost any ratio check
      expect(s.shouldSample(level, undefined)).toBe(true);
    },
  );

  it('a caller cannot weaken AUDIT/WARN/ERROR/FATAL protection via SamplingRatios — the type has no such keys', () => {
    // Compile-time guarantee: SamplingRatios only has trace/debug/info. This test pins the
    // runtime consequence: even a maximally-hostile ratio object has no effect on the protected levels.
    const s = new LogSampler({ trace: 0, debug: 0, info: 0 });
    expect(s.shouldSample('audit', undefined)).toBe(true);
  });
});

describe('forceLog() — bypasses sampling entirely (§16)', () => {
  it('a forced call passes regardless of ratio', () => {
    const s = new LogSampler({ trace: 0, debug: 0, info: 0 }, () => 0);
    expect(s.shouldSample('trace', forceLog())).toBe(true);
    expect(s.shouldSample('debug', forceLog({ reason: 'important' }))).toBe(
      true,
    );
  });

  it('forceLog() preserves the caller-supplied metadata alongside the flag', () => {
    const tagged = forceLog({ reason: 'important' });
    expect(tagged.reason).toBe('important');
    expect((tagged as Record<symbol, unknown>)[LOG_FORCE]).toBe(true);
  });

  it('an ordinary plain object without forceLog() is not treated as forced', () => {
    const s = new LogSampler({ trace: 0, debug: 0, info: 0 }, () => 0);
    expect(s.shouldSample('trace', { reason: 'not forced' })).toBe(false);
  });

  it('the force flag inside a LAZY callback has no effect — force only works on an already-plain object (documented limit, §16)', () => {
    const s = new LogSampler({ trace: 0, debug: 0, info: 0 }, () => 0);
    const lazy = () => forceLog({ reason: 'too late to help' });
    expect(s.shouldSample('trace', lazy)).toBe(false); // sampling decided WITHOUT calling lazy()
  });

  it("never evaluates a lazy metadata callback itself — that stays the caller's responsibility (§10)", () => {
    const s = new LogSampler({ trace: 1, debug: 1, info: 1 });
    const lazy = jest.fn(() => ({ x: 1 }));
    s.shouldSample('info', lazy);
    expect(lazy).not.toHaveBeenCalled();
  });
});

describe('LogSampler — unknown level fallback', () => {
  it('a level absent from the ratios map is never silently dropped', () => {
    const s = new LogSampler({} as never, () => 0);
    expect(s.shouldSample('trace', undefined)).toBe(true);
  });
});

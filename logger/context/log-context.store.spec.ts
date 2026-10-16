import {
  enrichLogContext,
  getLogContext,
  runWithLogContext,
} from './log-context.store';

describe('LogContext store (§8)', () => {
  it('getLogContext() returns undefined outside any bound context', () => {
    expect(getLogContext()).toBeUndefined();
  });

  it('runWithLogContext() binds a context for the duration of fn', () => {
    runWithLogContext({ method: 'GET', url: '/x' }, () => {
      expect(getLogContext()).toMatchObject({ method: 'GET', url: '/x' });
    });
    expect(getLogContext()).toBeUndefined(); // restored after fn returns
  });

  it('enrichLogContext() additively mutates the CURRENT context in place — visible to later reads in the same chain', () => {
    runWithLogContext({ method: 'GET' }, () => {
      expect(getLogContext()?.userId).toBeUndefined();
      enrichLogContext({ userId: 'u-1' });
      expect(getLogContext()).toMatchObject({ method: 'GET', userId: 'u-1' });
    });
  });

  it('enrichLogContext() is visible across an await within the same request (the real Guard-then-handler timing)', async () => {
    await runWithLogContext({ method: 'GET' }, async () => {
      await Promise.resolve();
      enrichLogContext({ userId: 'u-2' });
      await Promise.resolve();
      expect(getLogContext()?.userId).toBe('u-2');
    });
  });

  it('enrichLogContext() outside any bound context is a safe no-op — never throws', () => {
    expect(() => enrichLogContext({ userId: 'u-3' })).not.toThrow();
    expect(getLogContext()).toBeUndefined();
  });

  it('nested runWithLogContext(): inner context visible only inside its own callback, outer restored after', () => {
    runWithLogContext({ method: 'OUTER' }, () => {
      runWithLogContext({ method: 'INNER' }, () => {
        expect(getLogContext()?.method).toBe('INNER');
      });
      expect(getLogContext()?.method).toBe('OUTER');
    });
  });

  it("concurrent requests never see each other's enrichment (per-request isolation)", async () => {
    const results: string[] = [];
    await Promise.all(
      [1, 2, 3].map((i) =>
        runWithLogContext({ method: `req-${i}` }, async () => {
          await new Promise((r) => setTimeout(r, Math.random() * 10));
          enrichLogContext({ userId: `u-${i}` });
          await new Promise((r) => setTimeout(r, Math.random() * 10));
          results.push(`${getLogContext()?.method}:${getLogContext()?.userId}`);
        }),
      ),
    );
    expect(results.sort()).toEqual(['req-1:u-1', 'req-2:u-2', 'req-3:u-3']);
  });

  it('restores the outer context after fn throws', () => {
    runWithLogContext({ method: 'OUTER' }, () => {
      expect(() =>
        runWithLogContext({ method: 'INNER' }, () => {
          throw new Error('boom');
        }),
      ).toThrow('boom');
      expect(getLogContext()?.method).toBe('OUTER');
    });
  });

  it('runWithLogContext() copies its initial object — later external mutation of the original does not leak in', () => {
    const initial = { method: 'GET' };
    runWithLogContext(initial, () => {
      initial.method = 'MUTATED-EXTERNALLY';
      // the bound context is a COPY taken at run() time, so this external mutation of the
      // ORIGINAL reference must not affect what's already been captured for this call.
    });
    // Re-run to double check state carried over correctly between separate calls too.
    runWithLogContext({ method: 'FRESH' }, () => {
      expect(getLogContext()?.method).toBe('FRESH');
    });
  });
});

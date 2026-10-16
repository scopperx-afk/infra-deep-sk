import { getRequestContext, requestContextStore, runWithRequestContext } from './request-context.store';

describe('RequestContext store (§9)', () => {
  it('getRequestContext() returns undefined outside any bound request', () => {
    expect(getRequestContext()).toBeUndefined();
  });

  it('runWithRequestContext() binds a context for the duration of fn, restored after', () => {
    runWithRequestContext({ locale: 'en-US' }, () => {
      expect(getRequestContext()).toEqual({ locale: 'en-US' });
    });
    expect(getRequestContext()).toBeUndefined();
  });

  it('the bound context is frozen — downstream code cannot mutate it in place', () => {
    runWithRequestContext({ locale: 'en-US' }, () => {
      const ctx = getRequestContext();
      expect(() => {
        (ctx as { locale: string }).locale = 'fr-FR';
      }).toThrow(TypeError);
    });
  });

  it('nested calls: inner context visible only inside its own callback, outer restored after', () => {
    runWithRequestContext({ locale: 'en' }, () => {
      runWithRequestContext({ locale: 'fr' }, () => {
        expect(getRequestContext()?.locale).toBe('fr');
      });
      expect(getRequestContext()?.locale).toBe('en');
    });
  });

  it('concurrent requests never observe each other\'s context', async () => {
    const results: string[] = [];
    await Promise.all(
      [1, 2, 3].map((i) =>
        runWithRequestContext({ locale: `locale-${i}` }, async () => {
          await new Promise((r) => setTimeout(r, Math.random() * 10));
          results.push(getRequestContext()?.locale ?? 'none');
        }),
      ),
    );
    expect(results.sort()).toEqual(['locale-1', 'locale-2', 'locale-3']);
  });

  it('exports the exact singleton instance — the module-level store and the exported binding are the same object', () => {
    expect(requestContextStore).toBeDefined();
    runWithRequestContext({ locale: 'de' }, () => {
      expect(requestContextStore.getStore()).toEqual({ locale: 'de' });
    });
  });
});

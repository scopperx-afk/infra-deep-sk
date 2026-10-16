import { ErrorsMetricsCollectorService } from './errors.metrics';

describe('ErrorsMetricsCollectorService (§19)', () => {
  it('starts at zero across every dimension', () => {
    const m = new ErrorsMetricsCollectorService();
    expect(m.getMetricsSnapshot()).toEqual({
      errorsTotal: 0,
      errorsByCategory: {
        domain: 0,
        validation: 0,
        infrastructure: 0,
        unknown: 0,
      },
      errorsByCode: {},
      errorsByStatus: {},
    });
  });

  it('increments errorsTotal and the matching category/code/status buckets', () => {
    const m = new ErrorsMetricsCollectorService();
    m.record('domain', 404, 'NOT_FOUND');
    m.record('domain', 404, 'NOT_FOUND');
    m.record('validation', 400, 'VALIDATION_ERROR');
    const snap = m.getMetricsSnapshot();
    expect(snap.errorsTotal).toBe(3);
    expect(snap.errorsByCategory).toEqual({
      domain: 2,
      validation: 1,
      infrastructure: 0,
      unknown: 0,
    });
    expect(snap.errorsByCode).toEqual({ NOT_FOUND: 2, VALIDATION_ERROR: 1 });
    expect(snap.errorsByStatus).toEqual({ 404: 2, 400: 1 });
  });

  it('"unknown" is its own real category, separate from the three throwable ones', () => {
    const m = new ErrorsMetricsCollectorService();
    m.record('unknown', 500, 'INTERNAL_ERROR');
    expect(m.getMetricsSnapshot().errorsByCategory.unknown).toBe(1);
  });

  it('two different subclasses sharing a status are still counted by their own distinct code', () => {
    const m = new ErrorsMetricsCollectorService();
    m.record('domain', 404, 'NOT_FOUND');
    m.record('domain', 404, 'POST_NOT_FOUND');
    const snap = m.getMetricsSnapshot();
    expect(snap.errorsByCode).toEqual({ NOT_FOUND: 1, POST_NOT_FOUND: 1 });
    expect(snap.errorsByStatus).toEqual({ 404: 2 });
  });

  it('getMetricsSnapshot() returns a fresh copy each time — mutating the result never affects internal state', () => {
    const m = new ErrorsMetricsCollectorService();
    m.record('domain', 404, 'NOT_FOUND');
    const snap = m.getMetricsSnapshot();
    snap.errorsByCategory.domain = 999;
    snap.errorsByCode.NOT_FOUND = 999;
    expect(m.getMetricsSnapshot().errorsByCategory.domain).toBe(1);
    expect(m.getMetricsSnapshot().errorsByCode.NOT_FOUND).toBe(1);
  });
});

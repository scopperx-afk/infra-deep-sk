import { runWithRequestContext, requestContextStore } from './request-context.store';
import { RequestContextService } from './request-context.service';

describe('RequestContextService (§9 — DI-injectable form)', () => {
  it('delegates to the exact same underlying store the plain function reads', () => {
    const service = new RequestContextService(requestContextStore);
    expect(service.getContext()).toBeUndefined();
    runWithRequestContext({ locale: 'ja-JP' }, () => {
      expect(service.getContext()).toEqual({ locale: 'ja-JP' });
    });
  });
});

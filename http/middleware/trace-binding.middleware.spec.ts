import { Test } from '@nestjs/testing';
import { ConfigModule, staticSource } from '../../config';
import { getTraceContext } from '../../tracing';
import { httpConfigSchema } from '../config/http.schema';
import { TraceBindingMiddleware } from './trace-binding.middleware';

const BASE_ENV = {
  NODE_ENV: 'test',
  APP__NAME: 'x',
  APP__FRONTEND_URL: 'http://x',
  HTTP__CORS__ORIGINS: 'http://allowed.example.com',
};

async function buildMiddleware(env: Record<string, string> = {}): Promise<TraceBindingMiddleware> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ sources: [staticSource({ ...BASE_ENV, ...env })], exitOnValidationFailure: false, onNotice: () => undefined }),
      ConfigModule.forFeature('http', httpConfigSchema),
    ],
    providers: [TraceBindingMiddleware],
  }).compile();
  return moduleRef.get(TraceBindingMiddleware);
}

const fakeReqRes = (headers: Record<string, string> = {}) => {
  const setHeaderCalls: Array<[string, unknown]> = [];
  const req = { headers };
  const res = { setHeader: (k: string, v: unknown) => setHeaderCalls.push([k, v]) };
  return { req, res, setHeaderCalls };
};

describe('TraceBindingMiddleware (§8)', () => {
  it('binds a fresh correlationId when no inbound header is present, and echoes it on the response', async () => {
    const mw = await buildMiddleware();
    const { req, res, setHeaderCalls } = fakeReqRes();
    let captured: ReturnType<typeof getTraceContext>;
    mw.use(req as never, res as never, () => {
      captured = getTraceContext();
    });
    expect(captured!?.correlationId).toEqual(expect.any(String));
    expect(setHeaderCalls).toEqual([['x-correlation-id', captured!?.correlationId]]);
  });

  it('reuses a valid inbound correlation id from the configured header', async () => {
    const mw = await buildMiddleware();
    const { req, res } = fakeReqRes({ 'x-correlation-id': 'abc-123.def_456' });
    let captured: ReturnType<typeof getTraceContext>;
    mw.use(req as never, res as never, () => {
      captured = getTraceContext();
    });
    expect(captured!?.correlationId).toBe('abc-123.def_456');
  });

  it('generates a fresh id when the inbound header fails Tracing\'s own sanitization — never throws', async () => {
    const mw = await buildMiddleware();
    const { req, res } = fakeReqRes({ 'x-correlation-id': 'bad header\nvalue' });
    let captured: ReturnType<typeof getTraceContext>;
    expect(() =>
      mw.use(req as never, res as never, () => {
        captured = getTraceContext();
      }),
    ).not.toThrow();
    expect(captured!?.correlationId).not.toBe('bad header\nvalue');
  });

  it('respects a project-configured correlationHeader name', async () => {
    const mw = await buildMiddleware({ HTTP__CORRELATION_HEADER: 'x-request-id' });
    const { req, res, setHeaderCalls } = fakeReqRes({ 'x-request-id': 'my-id-1' });
    mw.use(req as never, res as never, () => undefined);
    expect(setHeaderCalls[0][0]).toBe('x-request-id');
    expect(setHeaderCalls[0][1]).toBe('my-id-1');
  });

  it('is unaffected by the configured header no longer matching a now-stale inbound header name (reads header ONCE, cached, per Anti-Pattern #9)', async () => {
    // Constructing the middleware already read+cached the header name; this just documents
    // that behavior exists by constructing twice with different configs and confirming each
    // instance keeps its OWN cached name independently.
    const mwDefault = await buildMiddleware();
    const mwCustom = await buildMiddleware({ HTTP__CORRELATION_HEADER: 'x-custom-trace' });
    const a = fakeReqRes({ 'x-correlation-id': 'via-default' });
    const b = fakeReqRes({ 'x-custom-trace': 'via-custom' });
    let capturedA: ReturnType<typeof getTraceContext>;
    let capturedB: ReturnType<typeof getTraceContext>;
    mwDefault.use(a.req as never, a.res as never, () => (capturedA = getTraceContext()));
    mwCustom.use(b.req as never, b.res as never, () => (capturedB = getTraceContext()));
    expect(capturedA!?.correlationId).toBe('via-default');
    expect(capturedB!?.correlationId).toBe('via-custom');
  });
});

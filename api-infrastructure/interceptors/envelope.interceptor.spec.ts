/** EnvelopeInterceptor — spec §4.3, §4.5, §12, §13 ("Envelope"); E-A5/E-A6/E-A16. Real Nest + Express + supertest. */
import {
  Controller, Get, Header, HttpCode, HttpException, Query, Redirect, Res, Sse, StreamableFile,
  type ExecutionContext, type INestApplication, type MessageEvent,
} from '@nestjs/common';
import { APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { Observable, of } from 'rxjs';
import request from 'supertest';
import { deriveContext, runWithContext } from '../../tracing';
import { apiConfigSchema, type ApiConfig } from '../config/api.schema';
import { API_CONFIG } from '../api-infrastructure.tokens';
import { RawResponse } from '../decorators/raw-response.decorator';
import { SkipEnvelope } from '../decorators/skip-envelope.decorator';
import { buildCursorPage, buildPartialSuccess, buildSuccess } from '../envelope/builders';
import { EnvelopeInterceptor } from './envelope.interceptor';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

@SkipEnvelope()
@Controller('skip-class')
class SkipClassCtl {
  @Get() a() { return { raw: true }; }
}

@Controller()
class Ctl {
  @Get('plain') plain() { return { id: 1 }; }
  @Get('array') array() { return [1, 2, 3]; }
  @Get('string') str() { return 'hello'; }
  @Get('number') num() { return 0; }
  @Get('null') nul() { return null; }
  @Get('void') nothing(): void { /* nothing */ }
  @Get('lookalike') lookalike() { return { data: [1, 2], total: 2, meta: { m: 1 } }; }

  @Get('v2/things') versioned() { return { ok: true }; }
  @Get('api/v3/things') prefixed() { return { ok: true }; }

  @Get('skip') @SkipEnvelope() skip() { return { raw: true }; }
  @Get('raw') @RawResponse() raw(@Res() res: { status(n: number): { json(b: unknown): void } }) { res.status(200).json({ written: 'by-handler' }); }

  @Get('draft') draft() { return buildSuccess({ id: 7 }, { requestedBy: 'u-1', correlationId: 'FORGED', timestamp: 'FORGED' }); }
  @Get('partial') partial() { return buildPartialSuccess([{ id: 1 }], [{ index: 1, code: 'DUP', message: 'duplicate' }]); }
  @Get('page') page(@Query('hasMore') hasMore?: string) {
    return buildCursorPage({ items: [{ id: 1 }], hasMore: hasMore === 'true', nextCursor: 'NXT' }, 20);
  }

  @Get('nocontent') @HttpCode(204) noContent() { /* nothing */ }
  @Get('reset') @HttpCode(205) reset() { /* nothing */ }
  @Get('passthrough204') p204(@Res({ passthrough: true }) res: { status(n: number): unknown }) { res.status(204); }
  @Get('passthrough304') p304(@Res({ passthrough: true }) res: { status(n: number): unknown }) { res.status(304); }
  @Get('created') @HttpCode(201) created() { return { id: 9 }; }

  @Get('redirect-static') @Redirect('/plain', 302) redirectStatic() { /* nothing */ }
  @Get('redirect-dynamic') @Redirect() redirectDynamic() { return { url: '/array', statusCode: 301 }; }

  @Sse('sse') sse(): Observable<MessageEvent> { return of({ data: 'tick' }); }

  @Get('file') @Header('Content-Type', 'text/plain') file() { return new StreamableFile(Buffer.from('file-bytes')); }

  @Get('http-error') httpError(): never { throw new HttpException({ code: 'TEAPOT', message: 'no' }, 418); }
  @Get('crash') crash(): never { throw new Error('boom'); }
}

async function makeApp(overrides: Partial<{ [K in keyof ApiConfig]: Partial<ApiConfig[K]> | ApiConfig[K] }> = {}): Promise<INestApplication> {
  const parsed = apiConfigSchema.parse({});
  const config: ApiConfig = {
    ...parsed,
    ...(overrides as Partial<ApiConfig>),
    envelope: { ...parsed.envelope, ...(overrides.envelope as object) },
  };
  const ref = await Test.createTestingModule({
    controllers: [Ctl, SkipClassCtl],
    providers: [
      { provide: API_CONFIG, useValue: config },
      { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
    ],
  }).compile();
  const app = ref.createNestApplication({ logger: false });
  (app.getHttpServer() as Server).setMaxListeners(0); // supertest attaches listeners per request
  // Stand-in for HTTP's TraceBindingMiddleware (HTTP spec §8) using Tracing's own public primitives.
  app.use((req: { headers: Record<string, string | undefined> }, _res: unknown, next: () => void) => {
    const correlationId = req.headers['x-correlation-id'];
    runWithContext(deriveContext(correlationId === undefined ? {} : { correlationId }), next);
  });
  await app.init();
  return app;
}

describe('EnvelopeInterceptor — the wrapping contract', () => {
  let app: INestApplication;
  beforeAll(async () => { app = await makeApp(); });
  afterAll(() => app.close());
  const get = (path: string) => request(app.getHttpServer() as Server).get(path);

  it('wraps a plain object: { data, meta{ timestamp, apiVersion, correlationId } } (§4.1)', async () => {
    const before = Date.now();
    const res = await get('/plain').set('x-correlation-id', 'corr-1').expect(200);
    expect(res.body).toEqual({ data: { id: 1 }, meta: { timestamp: expect.stringMatching(ISO), apiVersion: 'v1', correlationId: 'corr-1' } });
    const ts = Date.parse(res.body.meta.timestamp as string);
    expect(ts).toBeGreaterThanOrEqual(before - 1);
    expect(ts).toBeLessThanOrEqual(Date.now() + 1);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it.each([
    ['/array', [1, 2, 3]],
    ['/string', 'hello'],
    ['/number', 0],
    ['/null', null],
    ['/void', null],
  ])('%s ⇒ data %j', async (path, expected) => {
    const res = await get(path).expect(200);
    expect(res.body.data).toEqual(expected);
    expect(Object.keys(res.body).sort()).toEqual(['data', 'meta']);
  });

  it('a payload that merely resembles an envelope is DATA, siblings intact (E-A1)', async () => {
    const res = await get('/lookalike').expect(200);
    expect(res.body.data).toEqual({ data: [1, 2], total: 2, meta: { m: 1 } });
  });

  it('when the request carried no correlation header, Tracing mints one — meta.correlationId is a real, well-formed id (never "undefined")', async () => {
    const res = await get('/plain').expect(200);
    expect(res.body.meta.correlationId).toEqual(expect.any(String));
    expect(res.body.meta.correlationId).not.toBe('undefined');
    expect(res.body.meta.correlationId).toMatch(/^[A-Za-z0-9\-_.]{1,128}$/);
  });

  it('a hostile inbound correlation id is replaced, not echoed (Tracing §8.6) — the envelope inherits that for free', async () => {
    const res = await get('/plain').set('x-correlation-id', 'bad id with spaces').expect(200);
    expect(res.body.meta.correlationId).not.toBe('bad id with spaces');
  });

  describe('apiVersion (§8.2) — from the URL the router matched, never a header', () => {
    it('defaults to api.version when the path has none', async () => {
      expect((await get('/plain').expect(200)).body.meta.apiVersion).toBe('v1');
    });
    it('reports the version in the path', async () => {
      expect((await get('/v2/things').expect(200)).body.meta.apiVersion).toBe('v2');
      expect((await get('/api/v3/things').expect(200)).body.meta.apiVersion).toBe('v3');
    });
    it('ignores a client-supplied version header', async () => {
      expect((await get('/plain').set('X-API-Version', 'v9').set('Accept-Version', 'v9').expect(200)).body.meta.apiVersion).toBe('v1');
    });
  });

  describe('builders end-to-end', () => {
    it('buildSuccess: domain meta merged, reserved keys NOT overridable (E-A5)', async () => {
      const res = await get('/draft').set('x-correlation-id', 'c-9').expect(200);
      expect(res.body.data).toEqual({ id: 7 });
      expect(res.body.meta).toMatchObject({ requestedBy: 'u-1', correlationId: 'c-9', timestamp: expect.stringMatching(ISO) });
      expect(res.body.meta.timestamp).not.toBe('FORGED');
    });
    it('partial success: 2xx with a non-empty errors[] (§4.2 — distinct from ErrorResponseBody)', async () => {
      const res = await get('/partial').expect(200);
      expect(res.body.errors).toEqual([{ index: 1, code: 'DUP', message: 'duplicate' }]);
      expect(res.body).not.toHaveProperty('code');
      expect(res.body).not.toHaveProperty('traceId');
    });
    it('paginated: meta.pagination, nextCursor only with hasMore', async () => {
      expect((await get('/page?hasMore=true').expect(200)).body.meta.pagination).toEqual({ hasMore: true, limit: 20, nextCursor: 'NXT' });
      expect((await get('/page?hasMore=false').expect(200)).body.meta.pagination).toEqual({ hasMore: false, limit: 20 });
    });
    it('the symbol brand never leaks to the wire', async () => {
      const res = await get('/draft').expect(200);
      expect(JSON.stringify(res.body)).not.toMatch(/envelope-draft/);
    });
  });

  describe('opt-outs (§4.5)', () => {
    it('@SkipEnvelope() on a handler', async () => {
      expect((await get('/skip').expect(200)).body).toEqual({ raw: true });
    });
    it('@SkipEnvelope() on a controller covers its handlers', async () => {
      expect((await get('/skip-class').expect(200)).body).toEqual({ raw: true });
    });
    it('@RawResponse() with a handler that writes the response itself', async () => {
      expect((await get('/raw').expect(200)).body).toEqual({ written: 'by-handler' });
    });
  });

  describe('responses an envelope would CORRUPT are passed through untouched (E-A6)', () => {
    it('@HttpCode(204): no body at all', async () => {
      const res = await get('/nocontent').expect(204);
      expect(res.text).toBe('');
      expect(res.body).toEqual({});
    });
    it('@HttpCode(205): no body', async () => {
      const res = await get('/reset').expect(205);
      expect(res.text).toBe('');
    });
    it('a status the handler set itself via @Res({passthrough}) — 204 and 304', async () => {
      expect((await get('/passthrough204').expect(204)).text).toBe('');
      expect((await get('/passthrough304').expect(304)).text).toBe('');
    });
    it('a non-bodyless explicit status (201) IS still enveloped', async () => {
      const res = await get('/created').expect(201);
      expect(res.body.data).toEqual({ id: 9 });
    });
    it('static @Redirect() keeps its Location and status', async () => {
      const res = await get('/redirect-static').redirects(0).expect(302);
      expect(res.headers['location']).toBe('/plain');
    });
    it('dynamic @Redirect() ({ url, statusCode } returned) is not turned into data', async () => {
      const res = await get('/redirect-dynamic').redirects(0).expect(301);
      expect(res.headers['location']).toBe('/array');
    });
    it('HEAD is passed through (no body to shape)', async () => {
      const res = await request(app.getHttpServer() as Server).head('/plain').expect(200);
      expect(res.text).toBeUndefined();
    });
    it('StreamableFile bytes are delivered as-is', async () => {
      const res = await get('/file').expect(200);
      expect(res.text).toBe('file-bytes');
    });
    it('@Sse(): events are not wrapped in an envelope', async () => {
      // Its own app + real listening socket: an event stream cannot be asserted through supertest,
      // and closing a SHARED server here would break every test that follows.
      const sseApp = await makeApp();
      const server = (sseApp.getHttpServer() as http.Server).listen(0);
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const { port } = server.address() as AddressInfo;
      try {
        const body = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('no SSE event within 3s')), 3000);
          const req = http.get({ port, path: '/sse', headers: { accept: 'text/event-stream' } }, (res) => {
            let buf = '';
            res.on('data', (c: Buffer) => {
              buf += c.toString();
              if (buf.includes('tick')) { clearTimeout(timer); req.destroy(); resolve(buf); }
            });
          });
          req.on('error', () => undefined); // destroy() above surfaces as ECONNRESET
        });
        expect(body).toContain('data: tick');
        expect(body).not.toContain('"meta"');
      } finally {
        await sseApp.close();
      }
    });
  });

  describe('errors are never enveloped (§4.2, §12) — the interceptor never even sees them', () => {
    it('an HttpException keeps Nest’s own body', async () => {
      const res = await get('/http-error').expect(418);
      expect(res.body).toEqual({ code: 'TEAPOT', message: 'no' });
      expect(res.body).not.toHaveProperty('data');
      expect(res.body).not.toHaveProperty('meta');
    });
    it('an unexpected error keeps Nest’s own 500', async () => {
      const res = await get('/crash').expect(500);
      expect(res.body).not.toHaveProperty('data');
      expect(res.body).not.toHaveProperty('meta');
    });
  });

  it('request-scoped context does not bleed between concurrent requests: 60 parallel calls each get THEIR OWN correlationId', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `par-${i}`);
    const results = await Promise.all(ids.map((id) => get('/plain').set('x-correlation-id', id).then((r) => r.body.meta.correlationId as string)));
    expect(results).toEqual(ids);
  });
});

describe('EnvelopeInterceptor — configuration (Config §13.20 api.envelope.*)', () => {
  const run = async (overrides: Parameters<typeof makeApp>[0], path = '/plain') => {
    const app = await makeApp(overrides);
    try { return (await request(app.getHttpServer() as Server).get(path)).body as Record<string, unknown>; } finally { await app.close(); }
  };

  it('enabled=false ⇒ the interceptor is inert: bare payloads', async () => {
    expect(await run({ envelope: { enabled: false } })).toEqual({ id: 1 });
  });
  it('includeTimestamp=false ⇒ meta.timestamp ABSENT (not null)', async () => {
    const body = (await run({ envelope: { includeTimestamp: false } })) as { meta: Record<string, unknown> };
    expect('timestamp' in body.meta).toBe(false);
    expect(body.meta).toHaveProperty('apiVersion');
  });
  it('includeApiVersion=false ⇒ absent', async () => {
    const body = (await run({ envelope: { includeApiVersion: false } })) as { meta: Record<string, unknown> };
    expect('apiVersion' in body.meta).toBe(false);
  });
  it('includeCorrelationId=false ⇒ absent', async () => {
    const body = (await run({ envelope: { includeCorrelationId: false } })) as { meta: Record<string, unknown> };
    expect('correlationId' in body.meta).toBe(false);
  });
  it('all three off ⇒ meta is an empty object, still present (§4.1: meta on every success)', async () => {
    const body = await run({ envelope: { includeTimestamp: false, includeApiVersion: false, includeCorrelationId: false } });
    expect(body).toEqual({ data: { id: 1 }, meta: {} });
  });
  it('a configured api.version is the fallback for paths with no version', async () => {
    const body = (await run({ version: 'v7' })) as { meta: { apiVersion: string } };
    expect(body.meta.apiVersion).toBe('v7');
  });
  it('a request outside any Tracing context omits correlationId entirely (never "undefined")', async () => {
    const ref = await Test.createTestingModule({
      controllers: [Ctl],
      providers: [{ provide: API_CONFIG, useValue: apiConfigSchema.parse({}) }, { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor }],
    }).compile();
    const app = ref.createNestApplication({ logger: false });
    await app.init(); // NO trace-binding middleware
    const res = await request(app.getHttpServer() as Server).get('/plain').expect(200);
    expect(res.body.meta).not.toHaveProperty('correlationId');
    expect(JSON.stringify(res.body)).not.toContain('undefined');
    await app.close();
  });
});

describe('EnvelopeInterceptor — direct (contexts a real HTTP round-trip cannot reach)', () => {
  const interceptor = new EnvelopeInterceptor(apiConfigSchema.parse({}), new Reflector());
  const handler = () => undefined;
  class Dummy {}
  const ctxOf = (type: string, res: object = { statusCode: 200 }): ExecutionContext =>
    ({ getType: () => type, getHandler: () => handler, getClass: () => Dummy,
       switchToHttp: () => ({ getRequest: () => ({ method: 'GET', url: '/x' }), getResponse: () => res }) }) as unknown as ExecutionContext;
  const run = (ctx: ExecutionContext, value: unknown): unknown => {
    let out: unknown;
    interceptor.intercept(ctx, { handle: () => of(value) }).subscribe((v) => { out = v; });
    return out;
  };

  it.each(['ws', 'rpc'])('a %s context is returned untouched (the envelope is an HTTP wire contract)', (type) => {
    const stream = of('x');
    const result = interceptor.intercept(ctxOf(type), { handle: () => stream });
    expect(result).toBe(stream);
  });

  it('Buffer / Uint8Array / Node Readable / Web ReadableStream results pass through by identity', () => {
    const values = [Buffer.from('a'), new Uint8Array([1]), Readable.from(['a']), new ReadableStream()];
    for (const v of values) expect(run(ctxOf('http'), v)).toBe(v);
  });

  it('a response already written by the handler (headersSent / writableEnded) is never wrapped', () => {
    expect(run(ctxOf('http', { statusCode: 200, headersSent: true }), { a: 1 })).toEqual({ a: 1 });
    expect(run(ctxOf('http', { statusCode: 200, writableEnded: true }), { a: 1 })).toEqual({ a: 1 });
  });

  it('an ordinary result IS wrapped (control for the cases above)', () => {
    expect(run(ctxOf('http'), { a: 1 })).toMatchObject({ data: { a: 1 }, meta: { apiVersion: 'v1' } });
  });

  it('memoises per (class, handler): decorator lookups are not repeated per request', () => {
    const reflector = new Reflector();
    const spy = jest.spyOn(reflector, 'getAllAndOverride');
    const i = new EnvelopeInterceptor(apiConfigSchema.parse({}), reflector);
    const ctx = ctxOf('http');
    for (let n = 0; n < 5; n++) i.intercept(ctx, { handle: () => of(1) }).subscribe();
    expect(spy).toHaveBeenCalledTimes(2); // skip + raw, once — not 10
  });
});

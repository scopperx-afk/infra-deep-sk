/**
 * Regression tests for the Errors review findings (R-01 … R-12). Every test here FAILS on the
 * pre-review code and passes on the fixed code.
 */
import { Controller, Get, Global, HttpException, Module, Res, type ArgumentsHost } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { z } from 'zod';
import { ConfigModule, staticSource } from '../config';
import { LOGGER_SERVICE, type ILogger } from '../logger';
import {
  AppError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from './domain/app-error';
import { ErrorsModule } from './errors.module';
import { ERRORS_METRICS_COLLECTOR } from './errors.tokens';
import { ErrorMapperService } from './mapping/error-mapper.service';
import type { MappedError } from './mapping/error-mapper.port';
import { ErrorsMetricsCollectorService } from './metrics/errors.metrics';
import { GlobalExceptionFilter } from './nest/global-exception.filter';
import { logCaughtException } from './nest/exception-logging';

const envCfg = (env: string) =>
  ConfigModule.forRoot({
    sources: [staticSource({ NODE_ENV: env, APP__NAME: 't', APP__FRONTEND_URL: 'http://x' })],
    exitOnValidationFailure: false,
    onNotice: () => undefined,
  });

async function mapperFor(env: string): Promise<ErrorMapperService> {
  const m = await Test.createTestingModule({ imports: [envCfg(env)], providers: [ErrorMapperService] }).compile();
  return m.get(ErrorMapperService);
}

const fakeLogger = () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }) as unknown as jest.Mocked<ILogger>;

describe('R-01 — AppError keeps its identity and its cause', () => {
  it('name is the subclass name (was "Error" for every AppError), and is non-enumerable', () => {
    const e = new NotFoundError('x');
    expect(e.name).toBe('NotFoundError');
    expect(Object.keys(e)).not.toContain('name');
    expect(JSON.stringify(e)).not.toContain('NotFoundError');
    class OrderNotFound extends NotFoundError { readonly code: string = 'ORDER_NOT_FOUND'; }
    expect(new OrderNotFound('x').name).toBe('OrderNotFound');
    expect(new OrderNotFound('x') instanceof AppError).toBe(true);
  });
  it('a wrapped root cause survives on Error.cause (and ValidationError accepts it too)', () => {
    const root = new Error('ECONNREFUSED 10.0.0.5:5432');
    expect((new ServiceUnavailableError('db down', undefined, { cause: root }) as Error & { cause?: unknown }).cause).toBe(root);
    expect((new ValidationError('bad', [], { cause: root }) as Error & { cause?: unknown }).cause).toBe(root);
    expect('cause' in new NotFoundError('x')).toBe(false); // absent when not given
  });
});

describe('R-02 — `details` and 5xx messages are not sent to clients', () => {
  it('AppError details on a 5xx are withheld in production AND staging (a 503 used to return { host, password })', async () => {
    for (const env of ['production', 'staging']) {
      const m = await mapperFor(env);
      const r = m.mapToErrorResponse(new ServiceUnavailableError('db down', { host: 'db-internal:5432', password: 'p' }));
      expect(r.status).toBe(503);
      expect(r.body.message).toBe('db down'); // the author-written message is intentional
      expect('details' in r.body).toBe(false);
    }
  });
  it('client-error details (< 500) are still sent; a subclass can opt a 5xx in explicitly', async () => {
    const m = await mapperFor('production');
    expect(m.mapToErrorResponse(new NotFoundError('n', { id: 1 })).body.details).toEqual({ id: 1 });
    class OpenUnavailable extends ServiceUnavailableError { override get exposeDetails(): boolean { return true; } }
    expect(m.mapToErrorResponse(new OpenUnavailable('x', { retryAfter: 30 })).body.details).toEqual({ retryAfter: 30 });
  });
  it('in development 5xx details ARE returned (debugging aid)', async () => {
    const m = await mapperFor('development');
    expect(m.mapToErrorResponse(new ServiceUnavailableError('x', { host: 'h' })).body.details).toEqual({ host: 'h' });
  });
  it('a 5xx HttpException message is replaced outside dev/test (it used to carry "SELECT … failed" / internal hosts)', async () => {
    for (const env of ['production', 'staging']) {
      const m = await mapperFor(env);
      expect(m.mapToErrorResponse(new HttpException('SELECT * FROM secret_table failed', 500)).body.message).toBe('Internal server error');
      expect(m.mapToErrorResponse(new HttpException('Redis node 10.0.3.4 refused', 503)).body.message).toBe('Service unavailable');
      expect(m.mapToErrorResponse(new HttpException('upstream x', 502)).body.message).toBe('Bad gateway');
    }
    const dev = await mapperFor('development');
    expect(dev.mapToErrorResponse(new HttpException('Redis node 10.0.3.4 refused', 503)).body.message).toContain('Redis');
  });
  it('a 4xx HttpException keeps its message in every environment', async () => {
    const m = await mapperFor('production');
    expect(m.mapToErrorResponse(new HttpException('Cannot GET /x', 404)).body.message).toBe('Cannot GET /x');
  });
});

describe('R-03 — unknown-error internals are development-only (never staging)', () => {
  const boom = () => new TypeError('column "ssn" does not exist');
  it.each(['production', 'staging'])('%s: no details at all', async (env) => {
    expect('details' in (await mapperFor(env)).mapToErrorResponse(boom()).body).toBe(false);
  });
  it('test: name + message, but NO stack', async () => {
    const d = (await mapperFor('test')).mapToErrorResponse(boom()).body.details as Record<string, unknown>;
    expect(d).toMatchObject({ name: 'TypeError' });
    expect(d.stack).toBeUndefined();
  });
  it('development: name + message + stack', async () => {
    const d = (await mapperFor('development')).mapToErrorResponse(boom()).body.details as Record<string, unknown>;
    expect(typeof d.stack).toBe('string');
  });
});

describe('R-04 — status mapping: client mistakes are never INTERNAL_ERROR', () => {
  it.each([
    [405, 'METHOD_NOT_ALLOWED'], [408, 'REQUEST_TIMEOUT'], [410, 'GONE'], [413, 'PAYLOAD_TOO_LARGE'],
    [415, 'UNSUPPORTED_MEDIA_TYPE'], [422, 'UNPROCESSABLE_ENTITY'], [502, 'BAD_GATEWAY'], [501, 'NOT_IMPLEMENTED'],
  ])('HttpException %i → %s', async (status, code) => {
    const r = (await mapperFor('production')).mapToErrorResponse(new HttpException('x', status));
    expect(r.status).toBe(status);
    expect(r.body.code).toBe(code);
  });
  it('an http-errors-style client error raised outside Nest (status + expose) is a client error, not "unknown"', async () => {
    const e = Object.assign(new Error('request entity too large'), { status: 413, expose: true });
    const r = (await mapperFor('production')).mapToErrorResponse(e);
    expect(r).toMatchObject({ status: 413, category: 'validation', body: { code: 'PAYLOAD_TOO_LARGE', message: 'request entity too large' } });
  });
  it('…but a 5xx or a non-exposed error with a status is still Unknown (its message stays hidden)', async () => {
    const m = await mapperFor('production');
    expect(m.mapToErrorResponse(Object.assign(new Error('secret'), { status: 500, expose: false })).category).toBe('unknown');
    expect(m.mapToErrorResponse(Object.assign(new Error('secret'), { status: 400, expose: false })).body.message).toBe('Internal server error');
  });
  it('an AppError subclass with an impossible httpStatus (200) becomes 500, never "200 OK" with an error body', async () => {
    const bad = new NotFoundError('oops');
    Object.defineProperty(bad, 'httpStatus', { value: 200 }); // what a careless subclass would effectively do
    expect((await mapperFor('production')).mapToErrorResponse(bad).status).toBe(500);
  });
});

describe('R-05 — bounded client payloads', () => {
  it('5000 Zod issues → at most 50 + one "omitted" marker (was a 300 KB response)', async () => {
    const parsed = z.array(z.string()).safeParse(Array.from({ length: 5000 }, () => 1));
    const r = (await mapperFor('production')).mapToErrorResponse((parsed as { error: Error }).error);
    const d = r.body.details as { path: string; message: string }[];
    expect(d.length).toBe(51);
    expect(d[50].message).toContain('4950 more');
    expect(JSON.stringify(r.body).length).toBeLessThan(10_000);
  });
  it('an over-long message is clipped', async () => {
    const r = (await mapperFor('production')).mapToErrorResponse(new NotFoundError('m'.repeat(50_000)));
    expect(r.body.message.length).toBeLessThanOrEqual(1_001);
  });
});

describe('R-06 — the mapper never throws', () => {
  it('a throwing getResponse() / message getter yields a generic 500, not an exception inside the filter', async () => {
    const m = await mapperFor('production');
    class Evil extends HttpException { override getResponse(): never { throw new Error('getter boom'); } }
    expect(() => m.mapToErrorResponse(new Evil('x', 400))).not.toThrow();
    expect(m.mapToErrorResponse(new Evil('x', 400))).toMatchObject({ status: 500, category: 'unknown' });
    const evilApp = new NotFoundError('x');
    Object.defineProperty(evilApp, 'message', { get() { throw new Error('msg'); } });
    expect(m.mapToErrorResponse(evilApp).status).toBe(500);
  });
});

function fakeRes(over: Record<string, unknown> = {}) {
  const json = jest.fn();
  const res = { headersSent: false, status: jest.fn(() => ({ json })), setHeader: jest.fn(), destroy: jest.fn(), end: jest.fn(), ...over };
  return { res, json };
}
const httpHost = (res: unknown, type = 'http') => ({ getType: () => type, switchToHttp: () => ({ getResponse: () => res }) }) as unknown as ArgumentsHost;
const mapperStub = (mapped: MappedError) => ({ mapToErrorResponse: () => mapped });
const metricsStub = () => ({ record: jest.fn(), getMetricsSnapshot: jest.fn() });

describe('R-07 — GlobalExceptionFilter is the last line of defence and never throws', () => {
  const mapped: MappedError = { status: 409, category: 'domain', body: { code: 'CONFLICT', message: 'dup', details: { a: 1 }, traceId: 't1' } };

  it('un-serializable details: the original status + code still reach the client, only details are dropped', () => {
    const { res, json } = fakeRes();
    json.mockImplementationOnce(() => { throw new TypeError('Converting circular structure to JSON'); });
    new GlobalExceptionFilter(mapperStub(mapped) as never, fakeLogger(), metricsStub()).catch(new ConflictError('dup'), httpHost(res));
    expect(res.status).toHaveBeenNthCalledWith(2, 409);
    expect(json).toHaveBeenLastCalledWith({ code: 'CONFLICT', message: 'dup', traceId: 't1' });
  });
  it('headers already sent: logs, does NOT call json() again, destroys the connection so the client sees the failure', () => {
    const { res, json } = fakeRes({ headersSent: true });
    const logger = fakeLogger();
    expect(() => new GlobalExceptionFilter(mapperStub(mapped) as never, logger, metricsStub()).catch(new Error('after flush'), httpHost(res))).not.toThrow();
    expect(json).not.toHaveBeenCalled();
    expect(res.destroy).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalled(); // the error is still reported
  });
  it('if even the fallback response fails, it aborts instead of throwing', () => {
    const { res, json } = fakeRes();
    json.mockImplementation(() => { throw new Error('socket gone'); });
    expect(() => new GlobalExceptionFilter(mapperStub(mapped) as never, fakeLogger(), metricsStub()).catch(new Error('x'), httpHost(res))).not.toThrow();
    expect(res.destroy).toHaveBeenCalled();
  });
  it('a non-HTTP host: logged, and the ORIGINAL exception is re-thrown (was: TypeError masking it)', () => {
    const original = new Error('original');
    const logger = fakeLogger();
    expect(() => new GlobalExceptionFilter(mapperStub(mapped) as never, logger, metricsStub()).catch(original, httpHost(undefined, 'rpc'))).toThrow(original);
    expect(logger.info).toHaveBeenCalled();
  });
  it('marks error responses Cache-Control: no-store', () => {
    const { res } = fakeRes();
    new GlobalExceptionFilter(mapperStub(mapped) as never, fakeLogger(), metricsStub()).catch(new Error('x'), httpHost(res));
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });
  it('a throwing logger or metrics collector cannot prevent the response', () => {
    const { res, json } = fakeRes();
    const logger = fakeLogger();
    (logger.info as jest.Mock).mockImplementation(() => { throw new Error('log down'); });
    const metrics = metricsStub(); metrics.record.mockImplementation(() => { throw new Error('metrics down'); });
    new GlobalExceptionFilter(mapperStub(mapped) as never, logger, metrics).catch(new Error('x'), httpHost(res));
    expect(json).toHaveBeenCalledWith(mapped.body);
  });
});

describe('R-08 — log level follows the outcome', () => {
  const m = (status: number, category: MappedError['category'], code = 'C'): MappedError => ({ status, category, body: { code, message: 'm' } });
  const ex = new NotFoundError('x');

  it.each([[404, 'domain'], [409, 'domain'], [400, 'validation'], [422, 'validation']] as const)('%i → INFO, no stack', (status, category) => {
    const l = fakeLogger(); logCaughtException(l, ex, m(status, category));
    expect(l.info).toHaveBeenCalledWith('Request rejected', { code: 'C', status, errorName: 'NotFoundError' });
    expect(l.error).not.toHaveBeenCalled(); expect(l.warn).not.toHaveBeenCalled();
  });
  it.each([401, 403, 429])('%i → WARN (security-relevant)', (status) => {
    const l = fakeLogger(); logCaughtException(l, ex, m(status, 'infrastructure'));
    expect(l.warn).toHaveBeenCalledTimes(1); expect(l.error).not.toHaveBeenCalled();
  });
  it.each([500, 502, 503, 504])('known %i → ERROR "Request failed" with the exception (stack)', (status) => {
    const l = fakeLogger(); logCaughtException(l, ex, m(status, 'infrastructure'));
    expect(l.error).toHaveBeenCalledWith('Request failed', ex, { code: 'C', status });
  });
  it('unknown → ERROR "Unhandled exception" with the exception', () => {
    const l = fakeLogger(); const boom = new Error('boom'); logCaughtException(l, boom, m(500, 'unknown', 'INTERNAL_ERROR'));
    expect(l.error).toHaveBeenCalledWith('Unhandled exception', boom, { code: 'INTERNAL_ERROR', status: 500 });
  });
  it('WS channel uses WS-prefixed messages', () => {
    const l = fakeLogger(); logCaughtException(l, ex, m(404, 'domain'), 'ws');
    expect(l.info).toHaveBeenCalledWith('WS Request rejected', expect.anything());
  });
});

describe('R-13 — ZodError recognised by contract, issue messages bounded', () => {
  const like = (issues: unknown[], name = 'ZodError') => Object.assign(new Error('x'), { name, issues });
  it('an error from ANOTHER zod copy / zod/v4 (name + issues) is a 400 VALIDATION_ERROR, not Unknown', async () => {
    const r = (await mapperFor('production')).mapToErrorResponse(like([{ path: ['a', 0], message: 'bad' }]));
    expect(r).toMatchObject({ status: 400, category: 'validation', body: { code: 'VALIDATION_ERROR', details: [{ path: 'a.0', message: 'bad' }] } });
  });
  it('…but only when BOTH parts of the contract hold (an arbitrary error named ZodError without issues stays Unknown)', async () => {
    const m = await mapperFor('production');
    expect(m.mapToErrorResponse(like([], 'SomethingElse')).category).toBe('unknown');
    expect(m.mapToErrorResponse(Object.assign(new Error('x'), { name: 'ZodError' })).category).toBe('unknown');
  });
  it('a symbol path key (zod/v4 PropertyKey[]) does not make the mapper throw', async () => {
    const r = (await mapperFor('production')).mapToErrorResponse(like([{ path: ['a', Symbol('k')], message: 'm' }]));
    expect(r.status).toBe(400);
    expect((r.body.details as { path: string }[])[0].path).toBe('a.Symbol(k)');
  });
  it('a quoted-input issue message is capped at 200 chars (zod quotes the invalid value)', async () => {
    const r = (await mapperFor('production')).mapToErrorResponse(like([{ path: ['color'], message: `Invalid enum value. Expected 'red', received '${'x'.repeat(50_000)}'` }]));
    expect(((r.body.details as { message: string }[])[0]).message.length).toBeLessThanOrEqual(201);
  });
});

describe('R-09 — metrics cardinality is bounded', () => {
  it('codes beyond the cap fold into one overflow bucket', () => {
    const c = new ErrorsMetricsCollectorService();
    for (let i = 0; i < 150; i++) c.record('domain', 404, `CODE_${i}`);
    const snap = c.getMetricsSnapshot();
    expect(Object.keys(snap.errorsByCode).length).toBeLessThanOrEqual(101);
    expect(snap.errorsByCode._OTHER).toBe(50);
    expect(snap.errorsTotal).toBe(150);
    c.record('domain', 404, 'CODE_3'); // an already-tracked code keeps counting
    expect(c.getMetricsSnapshot().errorsByCode.CODE_3).toBe(2);
  });
});

describe('R-10 — end to end through a real Nest app', () => {
  const circular: Record<string, unknown> = { a: 1 }; circular.self = circular;
  const logger = fakeLogger();

  @Controller('e')
  class C {
    @Get('circ') circ() { throw new ConflictError('already exists', circular); }
    @Get('unavailable') un() { throw new ServiceUnavailableError('db down', { host: 'db-internal:5432' }); }
    @Get('late') late(@Res() res: { status(n: number): { write(s: string): void } }) { res.status(200).write('partial'); throw new NotFoundError('after headers'); }
    @Get('413') e413() { throw Object.assign(new Error('request entity too large'), { status: 413, expose: true }); }
  }
  @Global() @Module({ providers: [{ provide: LOGGER_SERVICE, useValue: logger }], exports: [LOGGER_SERVICE] }) class LoggerStub {}

  async function app(env: string) {
    @Module({ imports: [envCfg(env), LoggerStub, ErrorsModule], controllers: [C] }) class M {}
    const ref = await Test.createTestingModule({ imports: [M] }).compile();
    const a = ref.createNestApplication(); await a.init(); return a;
  }

  it('production: circular details → 409 + code survive; 503 hides details; 413 outside Nest is a 413', async () => {
    const a = await app('production');
    try {
      const circ = await request(a.getHttpServer()).get('/e/circ');
      expect(circ.status).toBe(409);
      expect(circ.body).toMatchObject({ code: 'CONFLICT', message: 'already exists' });
      expect(circ.headers['cache-control']).toBe('no-store');
      const un = await request(a.getHttpServer()).get('/e/unavailable');
      expect(un.status).toBe(503);
      expect(un.body.details).toBeUndefined();
      const big = await request(a.getHttpServer()).get('/e/413');
      expect(big.status).toBe(413);
      expect(big.body.code).toBe('PAYLOAD_TOO_LARGE');
    } finally { await a.close(); }
  });

  it('an error after the response has started does not blow up the process (connection is cut, error is logged)', async () => {
    const a = await app('production');
    const unhandled = jest.fn(); process.on('unhandledRejection', unhandled);
    try {
      await request(a.getHttpServer()).get('/e/late').then(() => undefined, () => undefined); // client sees a broken response
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalled();
    } finally { process.off('unhandledRejection', unhandled); await a.close(); }
  });
});

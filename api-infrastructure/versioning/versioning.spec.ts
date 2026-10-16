/** Versioning — spec §8, §13 ("Versioning"); E-A3 header formats, E-A7 search window. */
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { DeprecationInterceptor } from '../interceptors/deprecation.interceptor';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Deprecated, DEPRECATION_KEY, prepareDeprecationHeaders } from './deprecation.decorator';
import { extractApiVersion } from './extract-version';

describe('extractApiVersion', () => {
  it.each([
    ['/v1/auth/login', 'v1'],
    ['/v2/posts', 'v2'],
    ['/api/v1/x', 'v1'], // §13: the version is not necessarily the FIRST segment — a global prefix may precede it
    ['/v12/x', 'v12'],
    ['/V1/auth', 'v1'], // router is case-insensitive; reported normalised
    ['//v3//x', 'v3'],
    ['/v1', 'v1'],
    ['/v1?x=1', 'v1'],
    ['/api/v1?x=/v2', 'v1'],
    ['v1/x', 'v1'],
  ])('%s ⇒ %s', (path, expected) => expect(extractApiVersion(path)).toBe(expected));

  it.each([
    ['/auth/login'],
    [''],
    ['/'],
    ['/?v=v1'],
    ['/api/internal/v1/x'], // outside the 2-segment window — E-A7
    ['/projects/123/v2/tasks'], // a deeper segment that merely LOOKS like a version is not one — E-A7
    ['/files/images/v3'],
    ['/version/1'],
    ['/v/1'],
    ['/v1x/y'],
    ['/vv1/y'],
    ['/v/x'],
    ['/v12345/x'], // > 4 digits is not a plausible version
  ])('%p ⇒ null', (path) => expect(extractApiVersion(path)).toBeNull());

  it('documents the residual ambiguity: a resource called `v2` in SECOND position is indistinguishable from a global prefix + version (E-A7)', () => {
    expect(extractApiVersion('/projects/v2/tasks')).toBe('v2');
  });

  it('never throws on non-strings', () => {
    expect(extractApiVersion(undefined as unknown as string)).toBeNull();
    expect(extractApiVersion(null as unknown as string)).toBeNull();
    expect(extractApiVersion(5 as unknown as string)).toBeNull();
  });
});

describe('prepareDeprecationHeaders (E-A3)', () => {
  it('Sunset is an HTTP-date (RFC 8594), NOT the ISO string the spec text implied', () => {
    expect(prepareDeprecationHeaders({ sunsetAt: '2026-12-31T23:59:59Z' }).Sunset).toBe('Thu, 31 Dec 2026 23:59:59 GMT');
  });
  it('Deprecation defaults to the spec’s literal `true`; with deprecatedAt it is the RFC 9745 sf-date', () => {
    expect(prepareDeprecationHeaders({ sunsetAt: '2026-12-31T00:00:00Z' }).Deprecation).toBe('true');
    expect(prepareDeprecationHeaders({ sunsetAt: '2026-12-31T00:00:00Z', deprecatedAt: '2023-07-01T00:00:00Z' }).Deprecation).toBe('@1688169600');
  });
  it('Link carries rel="successor-version" only when successorUrl is supplied', () => {
    expect(prepareDeprecationHeaders({ sunsetAt: '2026-12-31T00:00:00Z', successorUrl: '/v2/users' }).Link).toBe('</v2/users>; rel="successor-version"');
    expect('Link' in prepareDeprecationHeaders({ sunsetAt: '2026-12-31T00:00:00Z' })).toBe(false);
  });
  it.each([['not a date'], [''], ['2026-99-99']])('rejects an invalid sunsetAt %p at boot', (sunsetAt) => {
    expect(() => prepareDeprecationHeaders({ sunsetAt })).toThrow(TypeError);
  });
  it('rejects an invalid deprecatedAt', () => {
    expect(() => prepareDeprecationHeaders({ sunsetAt: '2026-12-31T00:00:00Z', deprecatedAt: 'nope' })).toThrow(TypeError);
  });
  it.each([['/v2>; rel="evil'], ['/v2\r\nX-Injected: 1'], ['/a b'], ['<x>'], ['/v2"'], ['/v2\\']])('rejects a successorUrl that could break out of the Link header (%j)', (successorUrl) => {
    expect(() => prepareDeprecationHeaders({ sunsetAt: '2026-12-31T00:00:00Z', successorUrl })).toThrow(TypeError);
  });
  it('is frozen (precomputed once, shared across requests)', () => {
    expect(Object.isFrozen(prepareDeprecationHeaders({ sunsetAt: '2026-12-31T00:00:00Z' }))).toBe(true);
  });
});

describe('@Deprecated + DeprecationInterceptor over real HTTP', () => {
  @Controller()
  class C {
    @Get('old') @Deprecated({ sunsetAt: '2026-12-31T23:59:59Z', deprecatedAt: '2023-07-01T00:00:00Z', successorUrl: '/v2/new' }) old() { return { ok: true }; }
    @Get('fresh') fresh() { return { ok: true }; }
  }
  @Deprecated({ sunsetAt: '2027-01-01T00:00:00Z' })
  @Controller('legacy')
  class Legacy {
    @Get() a() { return 1; }
    @Get('boom') boom(): never { throw new Error('boom'); }
  }

  let app: INestApplication;
  beforeAll(async () => {
    const ref = await Test.createTestingModule({
      controllers: [C, Legacy],
      providers: [{ provide: APP_INTERCEPTOR, useClass: DeprecationInterceptor }],
    }).compile();
    app = ref.createNestApplication({ logger: false });
    await app.init();
  });
  afterAll(() => app.close());
  const http = () => request(app.getHttpServer() as Server);

  it('a deprecated handler sets all three headers', async () => {
    const res = await http().get('/old').expect(200);
    expect(res.headers['deprecation']).toBe('@1688169600');
    expect(res.headers['sunset']).toBe('Thu, 31 Dec 2026 23:59:59 GMT');
    expect(res.headers['link']).toBe('</v2/new>; rel="successor-version"');
  });
  it('a non-deprecated handler sets none of them (§13)', async () => {
    const res = await http().get('/fresh').expect(200);
    expect(res.headers['deprecation']).toBeUndefined();
    expect(res.headers['sunset']).toBeUndefined();
    expect(res.headers['link']).toBeUndefined();
  });
  it('a class-level @Deprecated covers every handler on it', async () => {
    const res = await http().get('/legacy').expect(200);
    expect(res.headers['deprecation']).toBe('true');
    expect(res.headers['sunset']).toBe('Fri, 01 Jan 2027 00:00:00 GMT');
  });
  it('an ERROR response from a deprecated endpoint still carries the headers (E-A8: before-handler phase)', async () => {
    const res = await http().get('/legacy/boom').expect(500);
    expect(res.headers['deprecation']).toBe('true');
  });
  it('metadata is the PRECOMPUTED headers object', () => {
    expect(Reflect.getMetadata(DEPRECATION_KEY, C.prototype.old)).toMatchObject({ Deprecation: '@1688169600' });
  });
});

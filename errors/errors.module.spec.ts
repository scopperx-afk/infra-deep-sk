import { Controller, Get, Inject, Injectable, Module } from '@nestjs/common';
import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { z, ZodError } from 'zod';
import { ConfigModule, staticSource } from '../config';
import { TracingModule } from '../tracing';
import { LoggerModule } from '../logger';
import { ErrorsModule } from './errors.module';
import { ERROR_MAPPER, ERRORS_METRICS_COLLECTOR } from './errors.tokens';
import { NotFoundError } from './domain/app-error';
import type { ErrorMapper } from './mapping/error-mapper.port';
import type { ErrorsMetricsCollector } from './metrics/errors.metrics';

const BASE_ENV = {
  NODE_ENV: 'test',
  APP__NAME: 'test-app',
  APP__FRONTEND_URL: 'http://x',
};

@Controller()
class TestController {
  @Get('domain-error')
  throwDomain(): never {
    throw new NotFoundError('Post not found', { postId: 'p-1' });
  }

  @Get('http-exception')
  throwHttp(): never {
    throw new NotFoundException('missing');
  }

  @Get('zod-error')
  throwZod(): never {
    const schema = z.object({ email: z.string().email() });
    const result = schema.safeParse({ email: 'not-an-email' });
    if (!result.success) throw result.error;
    throw new Error('unreachable');
  }

  @Get('unknown-error')
  throwUnknown(): never {
    throw new Error('column "ssn" does not exist in table users');
  }

  @Get('ok')
  ok(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [TestController] })
class TestFeatureModule {}

let stdoutSpy: jest.SpyInstance;
let stderrSpy: jest.SpyInstance;
beforeEach(() => {
  stdoutSpy = jest
    .spyOn(process.stdout, 'write')
    .mockImplementation(() => true);
  stderrSpy = jest
    .spyOn(process.stderr, 'write')
    .mockImplementation(() => true);
});
afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
});

async function bootApp(
  env: Record<string, string> = {},
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        sources: [staticSource({ ...BASE_ENV, ...env })],
        exitOnValidationFailure: false,
        onNotice: () => undefined,
      }),
      TracingModule.forRoot(),
      LoggerModule.forRoot(),
      ErrorsModule,
      TestFeatureModule,
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('ErrorsModule — end-to-end HTTP (§8, §15)', () => {
  let app: INestApplication;
  afterEach(async () => {
    await app?.close();
  });

  it('an AppError thrown from a controller is caught, mapped, and serialized correctly', async () => {
    app = await bootApp();
    const res = await request(app.getHttpServer()).get('/domain-error');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      code: 'NOT_FOUND',
      message: 'Post not found',
      details: { postId: 'p-1' },
    });
  });

  it('a Nest HttpException thrown from a controller is caught and mapped', async () => {
    app = await bootApp();
    const res = await request(app.getHttpServer()).get('/http-exception');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND', message: 'missing' });
  });

  it('a raw ZodError thrown from a controller is caught and flattened', async () => {
    app = await bootApp();
    const res = await request(app.getHttpServer()).get('/zod-error');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.details[0].path).toBe('email');
  });

  it('an unknown thrown Error never leaks its raw message as the wire "message" field (outside production, still exposes safe {name,message,stack} details per §10)', async () => {
    app = await bootApp(); // NODE_ENV=test → not production → §10 includes dev details
    const res = await request(app.getHttpServer()).get('/unknown-error');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(res.body.message).toBe('Internal server error'); // the FIXED message — never the raw exception text
    expect(res.body.details).toMatchObject({
      name: 'Error',
      message: 'column "ssn" does not exist in table users',
    });
  });

  it('in production, the unknown-error response omits details entirely — no leak at all, not even in a dev-only field', async () => {
    app = await bootApp({ NODE_ENV: 'production' });
    const res = await request(app.getHttpServer()).get('/unknown-error');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
    expect(JSON.stringify(res.body)).not.toContain('ssn');
  });

  it('a normal successful response is completely unaffected by ErrorsModule being wired in', async () => {
    app = await bootApp();
    const res = await request(app.getHttpServer()).get('/ok');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('metrics accumulate across real requests through the real filter', async () => {
    app = await bootApp();
    await request(app.getHttpServer()).get('/domain-error');
    await request(app.getHttpServer()).get('/unknown-error');
    const metrics = app.get<ErrorsMetricsCollector>(ERRORS_METRICS_COLLECTOR);
    const snap = metrics.getMetricsSnapshot();
    expect(snap.errorsTotal).toBe(2);
    expect(snap.errorsByCategory.domain).toBe(1);
    expect(snap.errorsByCategory.unknown).toBe(1);
  });
});

describe('ErrorsModule — @Global() reachability (§17)', () => {
  it('ERROR_MAPPER is injectable from a sibling feature module that never imports ErrorsModule itself', async () => {
    @Injectable()
    class SomeFeatureService {
      constructor(@Inject(ERROR_MAPPER) public readonly mapper: ErrorMapper) {}
    }
    @Module({ providers: [SomeFeatureService] }) // deliberately does NOT import ErrorsModule
    class SomeFeatureModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          sources: [staticSource(BASE_ENV)],
          exitOnValidationFailure: false,
          onNotice: () => undefined,
        }),
        TracingModule.forRoot(),
        LoggerModule.forRoot(),
        ErrorsModule, // registered once, at the root — never re-imported by SomeFeatureModule
        SomeFeatureModule,
      ],
    }).compile();

    const service = moduleRef.get(SomeFeatureService);
    expect(service.mapper).toBeDefined();
    const result = service.mapper.mapToErrorResponse(new NotFoundError('x'));
    expect(result.body.code).toBe('NOT_FOUND');
    await moduleRef.close();
  });
});

/**
 * Validation ⇄ Errors integration — Validation spec §8 (the failure path), §14 ("Failure
 * path"), §15 #1 and #8; Errors spec §7 case 3, §8, §9, §11, §19.
 *
 * WHY this test lives in `errors/`, not `validation/`: Validation may not import Errors
 * (§2 — no Layer 1 sibling imports, either direction), and `validation/boundary.spec.ts`
 * asserts exactly that. The proof that the two modules nonetheless cooperate — through
 * nothing but a structurally-recognized `ZodError` — therefore has to be written from the
 * side that is allowed to know both: Errors may depend on Zod (its mapper already does) and
 * a test may reach Validation through its public `index.ts` like any other consumer.
 *
 * What this pins: a handler parameter declared as a `createZodDto()` class, validated by the
 * REAL `ValidationModule`, fails with a RAW `ZodError`; Errors' REAL `GlobalExceptionFilter` +
 * `ErrorMapperService` turn it into the wire body a hand-constructed `ValidationError` would
 * have produced; it is logged exactly once (by Errors, never by Validation) and counted exactly
 * once as category `validation`.
 *
 * Only Config's and Logger's PROVIDERS are stubbed (via the same `CONFIG_SERVICE` /
 * `LOGGER_SERVICE` tokens Errors itself injects) — their modules are Layer 0 and out of scope
 * here. Tracing is not stubbed: the mapper's own `getTraceContext() ?? deriveContext()` runs
 * for real, so assertions never assume what, if anything, `traceId` is — only that when
 * present it is a real string and never the literal "undefined" (§5).
 *
 * Scope note: the WebSocket test below exercises `WsExceptionFilter` rendering a ZodError. It
 * does NOT claim a gateway's `@MessageBody()` is validated by `APP_PIPE` — that claim (Validation
 * §11) was probed and does not hold on this Nest version; see `validation/validation.module.ts`.
 */
import {
  Body,
  Controller,
  Get,
  Global,
  Module,
  Post,
  Query,
  type ArgumentsHost,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { z, ZodError } from 'zod';
import { CONFIG_SERVICE } from '../../config';
import { LOGGER_SERVICE } from '../../logger';
import { createZodDto, ValidationModule } from '../../validation';
import {
  ERROR_MAPPER,
  ERRORS_METRICS_COLLECTOR,
  ErrorsModule,
  ValidationError,
  WsExceptionFilter,
  type ErrorMapper,
  type ErrorResponseBody,
  type ErrorsMetricsCollector,
  type FieldError,
} from '../index';

// ── The spec's own example schemas (§4, §6), declared inline ─────────────────────────────────
const CreatePostSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1),
  tags: z.array(z.string()).max(20).default([]),
});
class CreatePostDto extends createZodDto(CreatePostSchema) {}

const ListPostsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  publishedOnly: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});
class ListPostsQueryDto extends createZodDto(ListPostsQuerySchema) {}

@Controller()
class PostsController {
  @Post('posts')
  create(@Body() dto: CreatePostDto) {
    return { received: dto };
  }

  @Get('posts')
  list(@Query() query: ListPostsQueryDto) {
    return { received: query };
  }
}

/** Typed loosely on purpose: the real `ILogger` has more members than Errors ever calls. */
const makeLoggerStub = () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
});
type LoggerStub = ReturnType<typeof makeLoggerStub>;

let logger: LoggerStub;

/** Stands in for the Layer 0 providers ErrorsModule injects. Global, like the real Config/Logger modules. */
@Global()
@Module({
  providers: [
    { provide: CONFIG_SERVICE, useValue: { isProduction: () => false } },
    { provide: LOGGER_SERVICE, useFactory: () => logger },
  ],
  exports: [CONFIG_SERVICE, LOGGER_SERVICE],
})
class Layer0ProvidersStub {}

/** `traceId` comes from Tracing's own derivation, which this test deliberately does not pin. */
const withoutTraceId = (body: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'traceId'));

/** supertest types `res.body` as `any`; the wire contract is Errors §5's `ErrorResponseBody`. */
const errorBody = (res: request.Response): ErrorResponseBody =>
  res.body as ErrorResponseBody;

/** Re-derives `FieldError[]` from a schema's own issues, independent of Errors' flattening code. */
const fieldErrorsOf = (schema: z.ZodTypeAny, input: unknown): FieldError[] => {
  const result = schema.safeParse(input);
  if (result.success)
    throw new Error('fixture input was expected to be invalid');
  return result.error.issues.map((i) => ({
    path: i.path.join('.'),
    message: i.message,
  }));
};

describe('Validation ⇄ Errors: the raw-ZodError failure path (§8)', () => {
  let app: INestApplication;
  let mapper: ErrorMapper;
  let metrics: ErrorsMetricsCollector;

  // A fresh app per test: the metrics collector and the logger stub both accumulate.
  beforeEach(async () => {
    logger = makeLoggerStub();
    const moduleRef = await Test.createTestingModule({
      imports: [Layer0ProvidersStub, ErrorsModule, ValidationModule],
      controllers: [PostsController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    mapper = app.get<ErrorMapper>(ERROR_MAPPER);
    metrics = app.get<ErrorsMetricsCollector>(ERRORS_METRICS_COLLECTOR);
  });
  afterEach(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer() as Server);

  describe('the wire response', () => {
    it('an invalid body becomes a 400 whose body is exactly the §5 ErrorResponseBody shape', async () => {
      const res = await http()
        .post('/posts')
        .send({ body: 'World' })
        .expect(400);
      expect(
        Object.keys(errorBody(res))
          .sort()
          .filter((k) => k !== 'traceId'),
      ).toEqual(['code', 'details', 'message']);
      expect(errorBody(res).code).toBe('VALIDATION_ERROR');
      expect(errorBody(res).message).toBe('Validation failed');
    });

    it('details carries one dotted path per failing field', async () => {
      const res = await http()
        .post('/posts')
        .send({ title: '', body: 5 })
        .expect(400);
      const paths = (errorBody(res).details as FieldError[])
        .map((d) => d.path)
        .sort();
      expect(paths).toEqual(['body', 'title']);
      for (const d of errorBody(res).details as FieldError[])
        expect(typeof d.message).toBe('string');
    });

    it('traceId is omitted or a real string — never the literal "undefined" (§5)', async () => {
      const res = await http().post('/posts').send({}).expect(400);
      const { traceId } = errorBody(res);
      if (traceId !== undefined) {
        expect(typeof traceId).toBe('string');
        expect(traceId).not.toBe('undefined');
      }
    });

    it('a query-parameter violation produces the same shape, pointing at the query field', async () => {
      const res = await http()
        .get('/posts')
        .query('pageSize=10000')
        .expect(400);
      expect(errorBody(res).code).toBe('VALIDATION_ERROR');
      expect((errorBody(res).details as FieldError[])[0].path).toBe('pageSize');
    });

    it('a valid request is untouched by Errors: 2xx, no error body', async () => {
      const res = await http()
        .post('/posts')
        .send({ title: 'Hello', body: 'World' })
        .expect(201);
      expect(res.body).toEqual({
        received: { title: 'Hello', body: 'World', tags: [] },
      });
    });
  });

  describe('identical to a hand-constructed ValidationError (§8: "an identical 400 body")', () => {
    it('the HTTP body equals what the same mapper produces for ValidationError with equivalent field details', async () => {
      const payload = { title: '', body: 5, tags: 'nope' };
      const res = await http().post('/posts').send(payload).expect(400);

      const handBuilt = mapper.mapToErrorResponse(
        new ValidationError(
          'Validation failed',
          fieldErrorsOf(CreatePostSchema, payload),
        ),
      );

      expect(res.status).toBe(handBuilt.status);
      expect(withoutTraceId(errorBody(res))).toEqual(
        withoutTraceId(handBuilt.body),
      );
    });

    it('both are classified as category "validation", not "unknown"', () => {
      const fromZod = mapper.mapToErrorResponse(
        thrown(() => CreatePostSchema.parse({})),
      );
      const fromValidationError = mapper.mapToErrorResponse(
        new ValidationError('Validation failed', []),
      );
      expect(fromZod.category).toBe('validation');
      expect(fromValidationError.category).toBe('validation');
    });
  });

  describe('logged once, by Errors only — Validation logs nothing (§15 #8, Errors §11)', () => {
    it('exactly one logger call for one failed request — at INFO (a 400 is a client error, not an error-level event)', async () => {
      await http().post('/posts').send({}).expect(400);

      const totalCalls =
        logger.error.mock.calls.length +
        logger.warn.mock.calls.length +
        logger.info.mock.calls.length +
        logger.debug.mock.calls.length;
      expect(totalCalls).toBe(1);
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledTimes(1);
      const [message, context] = logger.info.mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      expect(message).toBe('Request rejected');
      expect(context).toEqual({
        code: 'VALIDATION_ERROR',
        status: 400,
        errorName: 'ZodError',
      });
    });

    it('a successful request logs nothing at all', async () => {
      await http()
        .post('/posts')
        .send({ title: 'Hello', body: 'World' })
        .expect(201);
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalled();
    });
  });

  describe('counted once, as a client error — not as a bug (Errors §19)', () => {
    it('one failed request is one validation-category error with code VALIDATION_ERROR and status 400', async () => {
      await http().post('/posts').send({}).expect(400);
      const snapshot = metrics.getMetricsSnapshot();
      expect(snapshot.errorsTotal).toBe(1);
      expect(snapshot.errorsByCategory.validation).toBe(1);
      expect(snapshot.errorsByCode).toEqual({ VALIDATION_ERROR: 1 });
      expect(snapshot.errorsByStatus).toEqual({ 400: 1 });
    });

    it('never inflates errorsByCategory.unknown — the "real uncaught bug" signal stays clean', async () => {
      await http().post('/posts').send({}).expect(400);
      await http().get('/posts').query('page=0').expect(400);
      expect(metrics.getMetricsSnapshot().errorsByCategory.unknown).toBe(0);
    });

    it('a successful request records nothing', async () => {
      await http()
        .post('/posts')
        .send({ title: 'Hello', body: 'World' })
        .expect(201);
      expect(metrics.getMetricsSnapshot().errorsTotal).toBe(0);
    });
  });

  describe('WsExceptionFilter renders a ZodError identically to the HTTP path (Errors §9)', () => {
    it('emits the very same ErrorResponseBody over the socket client', async () => {
      const payload = { body: 'World' };
      const httpRes = await http().post('/posts').send(payload).expect(400);

      const emit = jest.fn();
      const host = {
        switchToWs: () => ({ getClient: () => ({ emit }) }),
      } as unknown as ArgumentsHost;
      // Resolved from the container (it IS the stub) so the type is whatever the real ILogger is — no cast to maintain.
      const wsLogger =
        app.get<ConstructorParameters<typeof WsExceptionFilter>[1]>(
          LOGGER_SERVICE,
        );
      const wsFilter = new WsExceptionFilter(mapper, wsLogger, metrics);

      wsFilter.catch(
        thrown(() => CreatePostSchema.parse(payload)),
        host,
      );

      expect(emit).toHaveBeenCalledTimes(1);
      const [event, wsBody] = emit.mock.calls[0] as [string, object];
      expect(event).toBe('error');
      expect(withoutTraceId(wsBody)).toEqual(
        withoutTraceId(errorBody(httpRes)),
      );
    });
  });
});

/** Returns the error `fn` throws; fails loudly if it does not throw. */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected a throw');
}

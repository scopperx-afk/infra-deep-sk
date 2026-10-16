/**
 * `ValidationModule` wired into a real Nest + Express application — Validation spec §10,
 * §14 ("Pipe", "Coercion"). Unit tests of the Pipe call `transform()` directly with
 * hand-built metadata; this spec proves the parts that can only fail in a running app:
 *
 *   1. `ValidationModule` alone registers the Pipe (via `APP_PIPE`) — the controller module
 *      below declares no pipe of its own.
 *   2. Nest's real `emitDecoratorMetadata` output (`@Body() dto: CreatePostDto`) actually
 *      reaches the Pipe as `ArgumentMetadata.metatype`.
 *   3. Query values arrive as the STRINGS Express really delivers, not JS-native booleans/numbers
 *      handed in by a unit test (§14: "not just a JS-native number/boolean passed directly").
 *
 * A control app WITHOUT `ValidationModule` proves the assertions are sensitive: there, an
 * invalid body reaches the handler. Without that control, "the invalid body was rejected"
 * could be passing for some unrelated reason.
 *
 * The thrown `ZodError` is captured by a TEST-LOCAL exception filter declared below. It is not
 * Errors' filter — this module may not import Errors (§2) — and the Errors-side behavior is
 * exercised in `errors/integration/validation-pipe.integration.spec.ts`.
 *
 * Scope note: this spec covers HTTP only; `@nestjs/websockets` is not a dependency of this repo, so
 * no real gateway can be exercised here. The WebSocket facts (E-V1: `APP_PIPE` does not reach
 * `@MessageBody()`; per-gateway `@UsePipes(ZodValidationPipe)` does) were established with a real
 * gateway in `findings/ws-apppipe-probe.ts`. The last two blocks below exercise the same `@UsePipes`
 * mechanism over HTTP as a stand-in, plus the hazard (E-V6) of misusing it on HTTP handlers.
 */
import {
  Body,
  Catch,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UsePipes,
  type ArgumentsHost,
  type ExceptionFilter,
  type INestApplication,
} from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { z, ZodError } from 'zod';
import { createZodDto } from './dto/create-zod-dto';
import { ZodValidationPipe as PublicZodValidationPipe } from './index';
import { ZodValidationPipe } from './pipes/zod-validation.pipe';
import { ValidationModule } from './validation.module';

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

/** What this spec's handlers echo back. supertest types `res.body` as `any`; this is the shape actually sent. */
interface EchoBody {
  received?: Record<string, unknown>;
  publishedOnlyType?: string;
  pageType?: string;
}
const echo = (res: request.Response): EchoBody => res.body as EchoBody;

/** A hand-written interface: reflects as `Object`, so it never opted in and must pass untouched (§4). */
interface RawShape {
  anything: unknown;
}

// ── Test-local capture filter: records what propagated, answers 400 for a ZodError ───────────────
const captured: unknown[] = [];
@Catch()
class CaptureFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    captured.push(exception);
    const res = host
      .switchToHttp()
      .getResponse<{ status(c: number): { json(b: unknown): unknown } }>();
    res.status(exception instanceof ZodError ? 400 : 500).json({
      propagated:
        exception instanceof Error ? exception.name : typeof exception,
    });
  }
}

@Controller()
class PostsController {
  @Post('posts')
  create(@Body() dto: CreatePostDto) {
    return { received: dto };
  }

  @Get('posts')
  list(@Query() query: ListPostsQueryDto) {
    return {
      received: query,
      publishedOnlyType: typeof query.publishedOnly,
      pageType: typeof query.page,
    };
  }

  @Get('posts/:id')
  get(@Param('id') id: string) {
    return { id, type: typeof id };
  }

  @Post('raw')
  raw(@Body() body: RawShape) {
    return { received: body };
  }
}

/** The per-scope mechanism a WebSocket gateway must use (E-V1) — applied on an HTTP controller as a stand-in. */
@Controller('scoped')
@UsePipes(PublicZodValidationPipe)
class ScopedPostsController {
  @Post('posts')
  create(@Body() dto: CreatePostDto) {
    return { received: dto };
  }

  @Get('posts')
  list(@Query() query: ListPostsQueryDto) {
    return { received: query };
  }

  @Get('posts/:id')
  get(@Param('id') id: string) {
    return { id };
  }
}

async function bootScoped(opts: {
  withValidationModule: boolean;
}): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: opts.withValidationModule ? [ValidationModule] : [],
    controllers: [ScopedPostsController],
    providers: [{ provide: APP_FILTER, useClass: CaptureFilter }],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

async function boot(opts: {
  withValidation: boolean;
}): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: opts.withValidation ? [ValidationModule] : [],
    controllers: [PostsController],
    providers: [{ provide: APP_FILTER, useClass: CaptureFilter }],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('ValidationModule (HTTP, via APP_PIPE)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer() as Server);

  beforeAll(async () => {
    app = await boot({ withValidation: true });
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    captured.length = 0;
  });

  describe('registration (§10)', () => {
    it('registers exactly one provider: ZodValidationPipe under the APP_PIPE framework token', () => {
      expect(Reflect.getMetadata('providers', ValidationModule)).toEqual([
        { provide: APP_PIPE, useClass: ZodValidationPipe },
      ]);
    });

    it('declares no imports, exports or controllers — nothing to coordinate with any sibling', () => {
      expect(Reflect.getMetadata('imports', ValidationModule)).toBeUndefined();
      expect(Reflect.getMetadata('exports', ValidationModule)).toBeUndefined();
      expect(
        Reflect.getMetadata('controllers', ValidationModule),
      ).toBeUndefined();
    });
  });

  describe('a createZodDto() body (§4)', () => {
    it('a valid body reaches the handler parsed — default applied', async () => {
      const res = await http()
        .post('/posts')
        .send({ title: 'Hello', body: 'World' })
        .expect(201);
      expect(res.body).toEqual({
        received: { title: 'Hello', body: 'World', tags: [] },
      });
    });

    it('an invalid body never reaches the handler: a raw ZodError propagates to the filter chain', async () => {
      await http().post('/posts').send({ body: 'World' }).expect(400);
      expect(captured).toHaveLength(1);
      expect(captured[0]).toBeInstanceOf(ZodError);
      expect((captured[0] as ZodError).constructor).toBe(ZodError);
      expect((captured[0] as ZodError).issues[0]).toMatchObject({
        path: ['title'],
        code: 'invalid_type',
      });
    });

    it('the propagated error is NOT a Nest HttpException — it was not wrapped on the way (§8)', async () => {
      await http().post('/posts').send({}).expect(400);
      expect(captured[0]).toBeInstanceOf(ZodError);
      expect((captured[0] as Error).name).toBe('ZodError');
    });

    it('an empty request body is rejected, not treated as an empty-but-valid payload', async () => {
      await http().post('/posts').expect(400);
      expect(captured[0]).toBeInstanceOf(ZodError);
    });
  });

  describe('query strings, as Express actually delivers them (§6, §14)', () => {
    it('?publishedOnly=false reaches the handler as the boolean false', async () => {
      const res = await http()
        .get('/posts')
        .query('publishedOnly=false')
        .expect(200);
      expect(echo(res).received?.publishedOnly).toBe(false);
      expect(echo(res).publishedOnlyType).toBe('boolean');
    });

    it('?publishedOnly=true reaches the handler as the boolean true', async () => {
      const res = await http()
        .get('/posts')
        .query('publishedOnly=true')
        .expect(200);
      expect(echo(res).received?.publishedOnly).toBe(true);
    });

    it('no query string at all yields every default', async () => {
      const res = await http().get('/posts').expect(200);
      expect(echo(res).received).toEqual({
        page: 1,
        pageSize: 20,
        publishedOnly: true,
      });
    });

    it('numeric strings are coerced to real numbers', async () => {
      const res = await http()
        .get('/posts')
        .query('page=3&pageSize=50')
        .expect(200);
      expect(echo(res).received).toMatchObject({ page: 3, pageSize: 50 });
      expect(echo(res).pageType).toBe('number');
    });

    it('?pageSize=10000 is rejected with a ZodError — NOT clamped to 100 (§6)', async () => {
      await http().get('/posts').query('pageSize=10000').expect(400);
      expect(captured[0]).toBeInstanceOf(ZodError);
      expect((captured[0] as ZodError).issues[0]).toMatchObject({
        path: ['pageSize'],
        code: 'too_big',
      });
    });

    it('?publishedOnly=yes is rejected rather than guessed at', async () => {
      await http().get('/posts').query('publishedOnly=yes').expect(400);
      expect((captured[0] as ZodError).issues[0].path).toEqual([
        'publishedOnly',
      ]);
    });

    it('a repeated key (?publishedOnly=true&publishedOnly=false → an array) is rejected, not first-wins/last-wins', async () => {
      await http()
        .get('/posts')
        .query('publishedOnly=true&publishedOnly=false')
        .expect(400);
      expect((captured[0] as ZodError).issues[0].path).toEqual([
        'publishedOnly',
      ]);
    });
  });

  describe('deliberately narrow scope — non-Zod parameters pass through (§4, §14)', () => {
    it("@Param('id') id: string — reaches the handler as the same string, untouched", async () => {
      const res = await http().get('/posts/42').expect(200);
      expect(res.body).toEqual({ id: '42', type: 'string' });
      expect(captured).toEqual([]);
    });

    it('a body declared as a hand-written interface passes through unexamined, however odd', async () => {
      const weird = { anything: [1, { two: 'three' }, null], extra: true };
      const res = await http().post('/raw').send(weird).expect(201);
      expect(res.body).toEqual({ received: weird });
      expect(captured).toEqual([]);
    });
  });
});

describe('control: the same controller WITHOUT ValidationModule', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await boot({ withValidation: false });
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    captured.length = 0;
  });

  it("an invalid body reaches the handler unvalidated — so the rejection above is ValidationModule's doing, not an accident", async () => {
    const res = await request(app.getHttpServer() as Server)
      .post('/posts')
      .send({ body: 'World' })
      .expect(201);
    expect(res.body).toEqual({ received: { body: 'World' } }); // no title, no default tags: nothing validated it
    expect(captured).toEqual([]);
  });

  it('?publishedOnly=false arrives as the raw string — nothing coerced it', async () => {
    const res = await request(app.getHttpServer() as Server)
      .get('/posts')
      .query('publishedOnly=false')
      .expect(200);
    expect(echo(res).received?.publishedOnly).toBe('false');
  });
});

describe('ZodValidationPipe exported from the public index, applied per-scope with @UsePipes (E-V1 remedy)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer() as Server);

  beforeAll(async () => {
    app = await bootScoped({ withValidationModule: false }); // NO APP_PIPE: only @UsePipes is in play, as on a gateway
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    captured.length = 0;
  });

  it('the index export is the very same class APP_PIPE registers — one pipe, not a second WsZodValidationPipe (§15 #7)', () => {
    expect(PublicZodValidationPipe).toBe(ZodValidationPipe);
  });

  it('@UsePipes(ZodValidationPipe) alone validates a createZodDto() body — no ValidationModule required', async () => {
    const res = await http()
      .post('/scoped/posts')
      .send({ title: 'Hello', body: 'World' })
      .expect(201);
    expect(echo(res).received).toEqual({
      title: 'Hello',
      body: 'World',
      tags: [],
    });
    await http().post('/scoped/posts').send({ body: 'World' }).expect(400);
    expect(captured[0]).toBeInstanceOf(ZodError);
    expect((captured[0] as ZodError).issues[0]).toMatchObject({
      path: ['title'],
      code: 'invalid_type',
    });
  });

  it('query coercion behaves identically under @UsePipes (?publishedOnly=false → false)', async () => {
    const res = await http()
      .get('/scoped/posts')
      .query('publishedOnly=false')
      .expect(200);
    expect(echo(res).received?.publishedOnly).toBe(false);
  });

  it('non-Zod parameters still pass through untouched under @UsePipes', async () => {
    const res = await http().get('/scoped/posts/42').expect(200);
    expect(res.body).toEqual({ id: '42' });
    expect(captured).toEqual([]);
  });
});

describe('E-V6 (hardened, E-V8): @UsePipes(ZodValidationPipe) on an HTTP handler no longer breaks the route', () => {
  // Originally documented as a HAZARD: with ValidationModule present, APP_PIPE already runs the Pipe; Nest then
  // runs the @UsePipes instance too, and the second `.parse()` was handed the FIRST parse's output — harmless
  // for idempotent schemas, fatal for §6's mandated boolean shape (every request 400, defaults included).
  // The Pipe now recognises a value it already produced from the SAME schema and returns it as is. Applying it
  // to an HTTP handler is still redundant (and the class JSDoc still says "never on HTTP handlers"); it is no
  // longer a landmine.
  let app: INestApplication;
  const http = () => request(app.getHttpServer() as Server);

  beforeAll(async () => {
    app = await bootScoped({ withValidationModule: true });
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    captured.length = 0;
  });

  it('an idempotent schema is parsed once and the result is unchanged', async () => {
    const res = await http()
      .post('/scoped/posts')
      .send({ title: 'Hello', body: 'World' })
      .expect(201);
    expect(echo(res).received).toEqual({
      title: 'Hello',
      body: 'World',
      tags: [],
    });
  });

  it('the §6 enum+transform boolean now WORKS under both pipes: ?publishedOnly=false → false (was 400)', async () => {
    const res = await http().get('/scoped/posts').query('publishedOnly=false').expect(200);
    expect(echo(res).received?.publishedOnly).toBe(false);
    expect(captured).toEqual([]); // nothing was thrown
  });

  it('…and a request with NO query string succeeds with the default (was: dead on every call)', async () => {
    const res = await http().get('/scoped/posts').expect(200);
    expect(echo(res).received?.publishedOnly).toBe(true);
  });

  it('invalid input is STILL rejected exactly once (the guard skips only a value this schema already produced)', async () => {
    await http().get('/scoped/posts').query('publishedOnly=maybe').expect(400);
    expect(captured).toHaveLength(1);
  });
});

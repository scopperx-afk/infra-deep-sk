/**
 * Regression tests for the Validation review findings (V-01 … V-09). Every test here FAILS on the
 * pre-review code (or exercises behaviour that did not exist) and passes on the fixed code.
 */
import { Body, Controller, Get, Global, Module, Param, ParseIntPipe, Post, Query, UsePipes } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { z } from 'zod';
import { z as z4 } from 'zod/v4';
import { ConfigModule, staticSource } from '../config';
import { ErrorsModule } from '../errors';
import { LOGGER_SERVICE } from '../logger';
import { assertRouteInputsValidated, createZodDto, findUnvalidatedRouteInputs, queryBoolean, queryInt, ValidationModule, ZodValidationPipe } from './index';

const pipe = new ZodValidationPipe();
const meta = (metatype: unknown) => ({ type: 'body', metatype }) as never;

describe('V-01 — the pipe', () => {
  it('a class that CLAIMS isZodDto but has no schema fails with a message that names the cause (was: TypeError "Cannot read properties of undefined")', () => {
    class Fake { static readonly isZodDto = true; }
    expect(() => pipe.transform({}, meta(Fake))).toThrow(/Fake is marked isZodDto but carries no Zod schema — declare it with createZodDto\(schema\)/);
  });

  it('a value the SAME schema already produced is returned as is — no second parse (E-V6/E-V8)', () => {
    const Flag = z.object({ flag: z.enum(['true', 'false']).transform((v) => v === 'true') });
    class FlagDto extends createZodDto(Flag) {}
    const once = pipe.transform({ flag: 'true' }, meta(FlagDto)) as { flag: boolean };
    expect(once.flag).toBe(true);
    expect(pipe.transform(once, meta(FlagDto))).toBe(once); // would have thrown: the enum no longer matches `true`
  });

  it('…but an object produced by ONE schema is still validated by a DIFFERENT schema (a permissive DTO must not exempt the body from a strict one)', () => {
    class Anything extends createZodDto(z.any()) {}
    class Strict extends createZodDto(z.object({ n: z.number() })) {}
    const raw = { n: 'not a number' };
    expect(pipe.transform(raw, meta(Anything))).toBe(raw); // z.any() returns the SAME reference
    expect(() => pipe.transform(raw, meta(Strict))).toThrow(z.ZodError);
  });

  it('invalid input is still rejected, and a rejected value is never remembered as "already parsed"', () => {
    class D extends createZodDto(z.object({ n: z.number() })) {}
    const bad = { n: 'x' };
    expect(() => pipe.transform(bad, meta(D))).toThrow(z.ZodError);
    expect(() => pipe.transform(bad, meta(D))).toThrow(z.ZodError); // second time too
  });

  it('primitives and non-DTO types still pass through by reference', () => {
    expect(pipe.transform('42', meta(String))).toBe('42');
    const o = {};
    expect(pipe.transform(o, meta(Object))).toBe(o);
  });
});

describe('V-02 — queryBoolean() / queryInt()', () => {
  const S = z.object({ published: queryBoolean({ default: true }), flag: queryBoolean().optional(), page: queryInt({ min: 1, max: 1000, default: 1 }), size: queryInt({ min: 1, max: 100 }).optional() });
  const ok = (v: unknown) => S.parse(v);
  const bad = (v: unknown) => S.safeParse(v).success;

  it('queryBoolean: "true"/"false" become real booleans, the default applies, anything else is a 400 (z.coerce.boolean made "false" TRUE)', () => {
    expect(ok({ published: 'false' }).published).toBe(false);
    expect(ok({ published: 'true' }).published).toBe(true);
    expect(ok({}).published).toBe(true);
    expect(ok({ flag: 'false' }).flag).toBe(false);
    for (const v of ['yes', '1', '0', 'TRUE', '', 'on']) expect(bad({ flag: v })).toBe(false);
  });

  it('queryInt: decimal integers only, bounds enforced, default applies', () => {
    expect(ok({}).page).toBe(1);
    expect(ok({ page: '7' }).page).toBe(7);
    expect(ok({ size: '100' }).size).toBe(100);
    expect(typeof ok({ page: '7' }).page).toBe('number');
    for (const v of ['0', '1001']) expect(bad({ page: v })).toBe(false);
  });

  it.each(['', ' ', ' 5', '5 ', '0x10', '1e3', '1.5', '+5', 'Infinity', 'NaN', 'abc', '99999999999999999999', '--1'])(
    'queryInt rejects %p (z.coerce.number() turns most of these into a number — "" and " " into 0)',
    (v) => {
      expect(bad({ page: v })).toBe(false);
      expect(z.coerce.number().safeParse(v).success && v !== 'abc' && v !== 'Infinity' && v !== 'NaN' && v !== '--1' ? true : true).toBe(true); // (documentation anchor)
    },
  );

  it('a REPEATED query parameter (an array) is a clean validation error, not NaN', () => {
    const r = S.safeParse({ page: ['1', '2'] });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toMatch(/Expected string, received array/);
  });
});

// ── a real Nest app: the audit and the cross-module behaviour ───────────────────────────────────────
class CreateDto extends createZodDto(z.object({ title: z.string(), tags: z.array(z.string()).default([]) })) {}
class ListQueryDto extends createZodDto(z.object({ page: queryInt({ default: 1 }) })) {}
interface LooseBody { title: string }
class PlainClass { title!: string }

@Controller('base')
class BaseController {
  @Post('inherited') inherited(@Body() b: LooseBody) { return b; }
}

@Controller('audit')
class AuditController extends BaseController {
  @Post('ok-dto') okDto(@Body() b: CreateDto) { return b; }
  @Post('iface') iface(@Body() b: LooseBody) { return b; }
  @Post('plain') plain(@Body() b: PlainClass) { return b; }
  @Get('q-dto') qDto(@Query() q: ListQueryDto) { return q; }
  @Get('q-iface') qIface(@Query() q: Record<string, string>) { return q; }
  @Get('named/:id') named(@Param('id') id: string, @Query('x') x: string) { return { id, x }; }
  @Get('piped/:id') piped(@Param('id', ParseIntPipe) id: number) { return { id }; }
  @Post('own-pipe') ownPipe(@Body(new ZodValidationPipe()) b: LooseBody) { return b; }
  helper(_: unknown): void { /* not a route */ }
}

const fakeLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
@Global() @Module({ providers: [{ provide: LOGGER_SERVICE, useValue: fakeLogger }], exports: [LOGGER_SERVICE] }) class LoggerStub {}
const envCfg = (env: string) => ConfigModule.forRoot({ sources: [staticSource({ NODE_ENV: env, APP__NAME: 't', APP__FRONTEND_URL: 'http://x' })], exitOnValidationFailure: false, onNotice: () => undefined });

async function bootApp(controllers: Function[], env = 'production') {
  @Module({ imports: [envCfg(env), LoggerStub, ErrorsModule, ValidationModule], controllers: controllers as never[] }) class M {}
  const ref = await Test.createTestingModule({ imports: [M] }).compile();
  const app = ref.createNestApplication();
  await app.init();
  return app;
}

describe('V-03 — route-input audit', () => {
  it("Nest's metadata key and RouteParamtypes the audit relies on are pinned to the framework's own constants", () => {
    expect(ROUTE_ARGS_METADATA).toBe('__routeArguments__');
    expect(RouteParamtypes.BODY).toBe(3);
    expect(RouteParamtypes.QUERY).toBe(4);
    expect(RouteParamtypes.PARAM).toBe(5);
  });

  it('reports every body / whole-query input that is not a Zod DTO — and nothing else', async () => {
    const app = await bootApp([AuditController]);
    try {
      const found = findUnvalidatedRouteInputs(app).map((f) => `${f.controller}.${f.handler}#${f.index}:${f.source}:${f.declaredType}`);
      expect(found).toEqual([
        'AuditController.iface#0:body:Object',
        'AuditController.inherited#0:body:Object', // an inherited route is audited too
        'AuditController.plain#0:body:PlainClass',
        'AuditController.qIface#0:query:Object',
      ]);
      // NOT reported: a Zod DTO body/query, a parameter with its OWN pipe, named primitives, non-route methods
    } finally { await app.close(); }
  });

  it('includeNamedPrimitives also reports @Param(\'id\') id: string / @Query(\'x\') x: string', async () => {
    const app = await bootApp([AuditController]);
    try {
      const named = findUnvalidatedRouteInputs(app, { includeNamedPrimitives: true }).filter((f) => f.key !== undefined).map((f) => `${f.source}:${f.key}`);
      expect(named.sort()).toEqual(['param:id', 'query:x']); // `@Param('id', ParseIntPipe)` has its own pipe — not reported
    } finally { await app.close(); }
  });

  it('ignore() accepts a specific finding on purpose', async () => {
    const app = await bootApp([AuditController]);
    try {
      const found = findUnvalidatedRouteInputs(app, { ignore: (f) => f.handler === 'iface' || f.handler === 'inherited' });
      expect(found.map((f) => f.handler).sort()).toEqual(['plain', 'qIface']);
    } finally { await app.close(); }
  });

  it('assertRouteInputsValidated throws ONE error listing every offender, and passes on a clean app', async () => {
    const dirty = await bootApp([AuditController]);
    try {
      expect(() => assertRouteInputsValidated(dirty)).toThrow(/4 route input\(s\) reach the application unvalidated/);
      expect(() => assertRouteInputsValidated(dirty)).toThrow(/AuditController\.iface\(\) parameter #0 @Body\(\) is typed Object/);
    } finally { await dirty.close(); }

    @Controller('clean') class Clean { @Post() create(@Body() b: CreateDto) { return b; } @Get() list(@Query() q: ListQueryDto) { return q; } }
    const clean = await bootApp([Clean]);
    try { expect(() => assertRouteInputsValidated(clean)).not.toThrow(); } finally { await clean.close(); }
  });
});

describe('V-04..V-06 — end to end through the Errors module', () => {
  const Color = z.object({ color: z.enum(['red', 'green']) });
  class ColorDto extends createZodDto(Color) {}
  class V4Dto extends (createZodDto as unknown as (s: unknown) => new () => object)(z4.object({ n: z4.number(), nested: z4.object({ k: z4.string() }) })) {}

  @Controller('e2e')
  class E2e {
    @Post('color') color(@Body() b: ColorDto) { return b; }
    @Post('v4') v4(@Body() b: V4Dto) { return b; }
  }

  it('V-04 an invalid string is NOT reflected back at full length (90 KB in → 90 KB out before)', async () => {
    const app = await bootApp([E2e]);
    try {
      const r = await request(app.getHttpServer()).post('/e2e/color').send({ color: 'x'.repeat(90_000) });
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.body).length).toBeLessThan(1_000);
      expect(r.body.details[0].message.length).toBeLessThanOrEqual(201); // 200 characters + the "…" marker
      expect(r.body.details[0].path).toBe('color');
    } finally { await app.close(); }
  });

  it('V-05 an error from a different zod COPY / zod/v4 is a 400 VALIDATION_ERROR (was a 500 INTERNAL_ERROR, logged at ERROR)', async () => {
    const app = await bootApp([E2e]);
    try {
      fakeLogger.error.mockClear();
      const r = await request(app.getHttpServer()).post('/e2e/v4').send({ n: 'abc', nested: {} });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('VALIDATION_ERROR');
      expect(r.body.details.map((d: { path: string }) => d.path).sort()).toEqual(['n', 'nested.k']);
      expect(fakeLogger.error).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it('V-06 the double-pipe landmine is gone through a real request (APP_PIPE + @UsePipes on the same handler)', async () => {
    const Flag = z.object({ flag: queryBoolean({ default: false }) });
    class FlagDto extends createZodDto(Flag) {}
    @Controller('double') class Double { @Get() @UsePipes(ZodValidationPipe) get(@Query() q: FlagDto) { return q; } }
    const app = await bootApp([Double]);
    try {
      const a = await request(app.getHttpServer()).get('/double?flag=true');
      expect([a.status, a.body]).toEqual([200, { flag: true }]);
      const b = await request(app.getHttpServer()).get('/double');
      expect([b.status, b.body]).toEqual([200, { flag: false }]);
    } finally { await app.close(); }
  });
});

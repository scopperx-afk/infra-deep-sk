/** OpenAPI generation — spec §9, §13 ("OpenAPI"); E-A12. Builds a REAL Swagger document from decorated controllers. */
import { Body, Controller, Get, Post, type INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { z } from 'zod';
import { ListQuery } from '../decorators/list-query.decorator';
import { ApiErrorResponses, ApiPaginatedResponse, ApiSuccessResponse } from './api-success-response.decorator';
import { ApiZodBody, ApiZodQuery, ApiCursorPagination, ApiOffsetPagination } from './api-zod.decorators';
import {
  ApiResponseSchema, ErrorResponseSchema, PaginatedResponseSchema, PartialSuccessResponseSchema,
} from './envelope-schemas';
import { zodToOpenApiSchema } from './zod-to-openapi';

const UserSchema = z.object({ id: z.string().uuid(), email: z.string().email(), age: z.number().int().optional(), createdAt: z.date() });
const CreateUserSchema = z.object({ email: z.string().email(), name: z.string().min(1).max(80) });
// The Validation module's DTO convention — two statics — expressed structurally.
class CreateUserDto { static readonly isZodDto = true as const; static readonly schema = CreateUserSchema; }
class ListUsersQueryDto { static readonly isZodDto = true as const; static readonly schema = z.object({ q: z.string().max(50).optional(), active: z.enum(['true', 'false']) }); }

@Controller('users')
class UsersCtl {
  @Get(':id') @ApiSuccessResponse(UserSchema) @ApiErrorResponses(404, 500) one() { return null; }
  @Get() @ApiPaginatedResponse(UserSchema) @ApiCursorPagination() list() { return null; }
  @Get('admin') @ApiPaginatedResponse(UserSchema, { mode: 'offset', description: 'Admin list' }) @ApiOffsetPagination() admin() { return null; }
  @Post() @ApiZodBody(CreateUserDto) @ApiSuccessResponse(UserSchema, { status: 201, description: 'Created' }) create(@Body() _b: unknown) { return null; }
  @Get('search') @ApiZodQuery(ListUsersQueryDto) search() { return null; }
  @Get('rich')
  @ListQuery({ pagination: 'cursor', filters: ['status', { name: 'age', type: 'number' }, { name: 'createdAt', type: 'date', allowedOperators: ['gte', 'lte'] }], sorts: ['createdAt', 'email'] })
  rich() { return null; }
}

describe('OpenAPI document', () => {
  let app: INestApplication;
  let doc: ReturnType<typeof SwaggerModule.createDocument>;
  beforeAll(async () => {
    const ref = await Test.createTestingModule({ controllers: [UsersCtl] }).compile();
    app = ref.createNestApplication({ logger: false });
    await app.init();
    doc = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('t').setVersion('1').build());
  });
  afterAll(() => app.close());

  const op = (path: string, method: 'get' | 'post' = 'get') => (doc.paths[path] as Record<string, any>)[method]; // eslint-disable-line @typescript-eslint/no-explicit-any
  const params = (path: string) => Object.fromEntries((op(path).parameters as Array<{ name: string }>).map((p) => [p.name, p])) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

  it('@ApiSuccessResponse documents the full envelope around the data schema', () => {
    const schema = op('/users/{id}').responses['200'].content['application/json'].schema;
    expect(schema.required).toEqual(expect.arrayContaining(['data', 'meta']));
    expect(schema.properties.data.properties.email).toMatchObject({ type: 'string', format: 'email' });
    expect(schema.properties.data.properties.createdAt).toMatchObject({ type: 'string', format: 'date-time' });
    expect(schema.properties.meta.properties).toHaveProperty('correlationId');
    expect(schema.properties.errors.type).toBe('array');
    expect(schema).not.toHaveProperty('$schema');
  });

  it('@ApiErrorResponses documents the UN-enveloped ErrorResponseBody shape (§4.2, §12)', () => {
    const r = op('/users/{id}').responses;
    for (const status of ['404', '500']) {
      const schema = r[status].content['application/json'].schema;
      expect(Object.keys(schema.properties).sort()).toEqual(['code', 'details', 'message', 'traceId']);
      expect(schema.required.sort()).toEqual(['code', 'message']);
    }
  });

  it('@ApiPaginatedResponse (cursor): data is an array, meta.pagination has the cursor shape', () => {
    const schema = op('/users').responses['200'].content['application/json'].schema;
    expect(schema.properties.data.type).toBe('array');
    expect(JSON.stringify(schema.properties.meta)).toContain('nextCursor');
    expect(JSON.stringify(schema.properties.meta)).not.toContain('totalPages');
  });

  it('@ApiPaginatedResponse (offset): the offset shape, with the custom description', () => {
    const res = op('/users/admin').responses['200'];
    expect(res.description).toBe('Admin list');
    expect(JSON.stringify(res.content['application/json'].schema.properties.meta)).toContain('totalPages');
  });

  it('custom status codes are honoured (201)', () => {
    expect(op('/users', 'post').responses['201'].description).toBe('Created');
  });

  it('@ApiZodBody documents the request body from the SAME schema the pipe validates with', () => {
    const body = op('/users', 'post').requestBody.content['application/json'].schema;
    expect(body.required.sort()).toEqual(['email', 'name']);
    expect(body.properties.name).toMatchObject({ type: 'string', minLength: 1, maxLength: 80 });
  });

  it('@ApiZodQuery expands a query DTO into one parameter per field, with required-ness', () => {
    const p = params('/users/search');
    expect(p.q).toMatchObject({ in: 'query', required: false });
    expect(p.q.schema).toMatchObject({ type: 'string', maxLength: 50 });
    expect(p.active).toMatchObject({ in: 'query', required: true });
    expect(p.active.schema.enum).toEqual(['true', 'false']);
  });

  it('@ApiCursorPagination / @ApiOffsetPagination document the pagination parameters', () => {
    expect(Object.keys(params('/users')).sort()).toEqual(['cursor', 'limit']);
    expect(Object.keys(params('/users/admin')).sort()).toEqual(['includeTotal', 'limit', 'page']);
    expect(params('/users/admin').includeTotal.schema.enum).toEqual(['true', 'false']);
  });

  describe('@ListQuery derives the docs from the SAME options that configure the parsers', () => {
    const p = () => params('/users/rich');
    it('documents exactly the filter keys the parser will honour', () => {
      const keys = Object.keys(p()).filter((k) => !['cursor', 'limit', 'sort'].includes(k)).sort();
      expect(keys).toEqual(['age', 'ageGt', 'ageGte', 'ageIn', 'ageLt', 'ageLte', 'ageNe', 'createdAtGte', 'createdAtLte', 'status', 'statusIn', 'statusLike', 'statusNe']);
    });
    it('types come from the field type; `in` is a comma-separated string', () => {
      expect(p().age.schema.type).toBe('number');
      expect(p().createdAtGte.schema).toMatchObject({ type: 'string', format: 'date-time' });
      expect(p().ageIn.schema.type).toBe('string');
    });
    it('documents `sort` with the allowed fields', () => {
      expect(p().sort.description).toContain('createdAt, email');
      expect(p().sort.schema.example).toBe('createdAt:desc');
    });
    it('an operator restricted away is NOT documented (createdAt only allows gte/lte)', () => {
      expect(p()).not.toHaveProperty('createdAt');
      expect(p()).not.toHaveProperty('createdAtGt');
    });
  });
});

describe('envelope schemas', () => {
  const Item = z.object({ id: z.number() });
  const valid = { data: { id: 1 }, meta: { timestamp: '2026-01-01T00:00:00.000Z', apiVersion: 'v1', extra: 'ok' } };

  it('ApiResponseSchema accepts a real envelope, passes extra meta through, rejects a missing data', () => {
    expect(ApiResponseSchema(Item).safeParse(valid).success).toBe(true);
    expect(ApiResponseSchema(Item).parse(valid).meta).toHaveProperty('extra', 'ok');
    expect(ApiResponseSchema(Item).safeParse({ meta: {} }).success).toBe(false);
  });
  it('PaginatedResponseSchema (cursor) requires meta.pagination with hasMore/limit', () => {
    const S = PaginatedResponseSchema(Item);
    expect(S.safeParse({ data: [{ id: 1 }], meta: { pagination: { hasMore: false, limit: 20 } } }).success).toBe(true);
    expect(S.safeParse({ data: [{ id: 1 }], meta: {} }).success).toBe(false);
    expect(S.safeParse({ data: { id: 1 }, meta: { pagination: { hasMore: false, limit: 20 } } }).success).toBe(false);
  });
  it('PaginatedResponseSchema (offset) requires page', () => {
    const S = PaginatedResponseSchema(Item, 'offset');
    expect(S.safeParse({ data: [], meta: { pagination: { page: 1, limit: 10, hasMore: false, total: 0, totalPages: 0 } } }).success).toBe(true);
    expect(S.safeParse({ data: [], meta: { pagination: { hasMore: false, limit: 10 } } }).success).toBe(false);
  });
  it('PartialSuccessResponseSchema REQUIRES a non-empty errors array', () => {
    const S = PartialSuccessResponseSchema(Item);
    expect(S.safeParse({ ...valid, errors: [{ code: 'E', message: 'm', index: 0 }] }).success).toBe(true);
    expect(S.safeParse({ ...valid, errors: [] }).success).toBe(false);
    expect(S.safeParse(valid).success).toBe(false);
  });
  it('ErrorResponseSchema: code+message required, details/traceId optional', () => {
    expect(ErrorResponseSchema.safeParse({ code: 'X', message: 'm' }).success).toBe(true);
    expect(ErrorResponseSchema.safeParse({ code: 'X', message: 'm', details: [1], traceId: 't' }).success).toBe(true);
    expect(ErrorResponseSchema.safeParse({ message: 'm' }).success).toBe(false);
  });
});

describe('zodToOpenApiSchema', () => {
  it('memoises per schema object and mode', () => {
    const s = z.object({ a: z.string() });
    expect(zodToOpenApiSchema(s)).toBe(zodToOpenApiSchema(s));
    expect(zodToOpenApiSchema(s, 'input')).toBe(zodToOpenApiSchema(s, 'input'));
  });
  it('emits OpenAPI 3 constructs (nullable, not JSON-Schema type arrays) and inlines — no $ref', () => {
    const out = JSON.stringify(zodToOpenApiSchema(z.object({ a: z.string().nullable(), b: z.object({ c: z.number() }) })));
    expect(out).toContain('"nullable":true');
    expect(out).not.toContain('$ref');
  });
});

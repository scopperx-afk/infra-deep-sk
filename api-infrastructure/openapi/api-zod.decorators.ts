/**
 * Request-side OpenAPI helpers — E-A12. Validation's `createZodDto()` classes (`isZodDto: true`,
 * static `schema`) carry no `@ApiProperty` metadata, so Swagger would show an empty body. These
 * decorators document the request from the SAME Zod schema the pipe validates with, so the
 * document cannot drift from the validation.
 *
 * `ZodDtoLike` is a STRUCTURAL type on purpose: importing Validation's `ZodDto` would be the
 * lateral Layer-1 import spec §2 forbids, and a structural type means any DTO factory that follows
 * the same two-field convention works.
 */
import { applyDecorators } from '@nestjs/common';
import { ApiBody, ApiQuery } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger';
import type { ZodTypeAny } from 'zod';
import { zodToOpenApiSchema } from './zod-to-openapi';

export interface ZodDtoLike {
  readonly isZodDto: true;
  readonly schema: ZodTypeAny;
}

/** Documents a request body from a `createZodDto()` class. */
export const ApiZodBody = (dto: ZodDtoLike) =>
  applyDecorators(ApiBody({ schema: zodToOpenApiSchema(dto.schema, 'input') }));

/**
 * Documents a query DTO: one `@ApiQuery` per top-level property of its schema. Properties whose
 * schema has no JSON-Schema form (a `.transform()`-only field, e.g. the pagination `limit`) are
 * documented as untyped strings — use `@ApiCursorPagination()` / `@ApiOffsetPagination()` for those.
 */
export const ApiZodQuery = (dto: ZodDtoLike) => {
  const schema = zodToOpenApiSchema(dto.schema, 'input') as {
    properties?: Record<string, SchemaObject>;
    required?: string[];
  };
  const required = new Set(schema.required ?? []);
  return applyDecorators(
    ...Object.entries(schema.properties ?? {}).map(([name, propSchema]) =>
      ApiQuery({
        name,
        required: required.has(name),
        schema: Object.keys(propSchema).length === 0 ? { type: 'string' } : propSchema,
      }),
    ),
  );
};

/** Documents `?cursor=&limit=` (§5.1.1). Default/maximum limit are deployment-configured (`api.pagination.*`). */
export const ApiCursorPagination = () =>
  applyDecorators(
    ApiQuery({
      name: 'cursor',
      required: false,
      schema: { type: 'string' },
      description: 'Opaque cursor from the previous page\'s `meta.pagination.nextCursor`.',
    }),
    ApiQuery({
      name: 'limit',
      required: false,
      schema: { type: 'integer', minimum: 1 },
      description:
        'Page size. Defaults to `api.pagination.defaultLimit`; a value above `api.pagination.maxLimit` is rejected (400), never clamped.',
    }),
  );

/** Documents `?page=&limit=&includeTotal=` (§5.2.1). */
export const ApiOffsetPagination = () =>
  applyDecorators(
    ApiQuery({ name: 'page', required: false, schema: { type: 'integer', minimum: 1, default: 1 } }),
    ApiQuery({
      name: 'limit',
      required: false,
      schema: { type: 'integer', minimum: 1 },
      description: 'Page size. Defaults to `api.pagination.defaultLimit`; above `api.pagination.maxLimit` is a 400.',
    }),
    ApiQuery({
      name: 'includeTotal',
      required: false,
      schema: { type: 'string', enum: ['true', 'false'], default: 'false' },
      description: 'Opt in to `meta.pagination.total` — costs a `COUNT(*)`.',
    }),
  );

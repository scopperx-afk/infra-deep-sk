/**
 * Response-documentation decorators — API Infrastructure spec §9.4.
 *
 * `@ApiSuccessResponse(UserSchema)` replaces the pair of `@ApiResponse({ schema })` + a
 * hand-described envelope that a controller would otherwise need on every method of every domain.
 *
 * Caveat, stated plainly: these document the envelope's DEFAULT shape. A deployment that sets
 * `api.envelope.enabled=false` serves bare payloads while the generated document still shows the
 * envelope — decoration runs at class-load time, before Config exists, so the decorator cannot know.
 * Disabling the envelope is a whole-API contract change (Config §13.20 keeps it a deploy-time
 * switch); regenerate or post-process the document if you ever do.
 */
import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import type { ZodTypeAny } from 'zod';
import {
  ApiResponseSchema,
  ErrorResponseSchema,
  PaginatedResponseSchema,
} from './envelope-schemas';
import { zodToOpenApiSchema } from './zod-to-openapi';

export interface ApiSuccessResponseOptions {
  /** default: 200 */
  readonly status?: number;
  readonly description?: string;
}

export const ApiSuccessResponse = (
  dataSchema: ZodTypeAny,
  options: ApiSuccessResponseOptions = {},
) =>
  applyDecorators(
    ApiResponse({
      status: options.status ?? 200,
      description: options.description ?? 'Successful response',
      schema: zodToOpenApiSchema(ApiResponseSchema(dataSchema)),
    }),
  );

export interface ApiPaginatedResponseOptions extends ApiSuccessResponseOptions {
  /** Which `meta.pagination` shape the endpoint returns. Default `'cursor'`. */
  readonly mode?: 'cursor' | 'offset';
}

/** Documents a paginated list: `data: Item[]` + `meta.pagination` (§5). */
export const ApiPaginatedResponse = (
  itemSchema: ZodTypeAny,
  options: ApiPaginatedResponseOptions = {},
) =>
  applyDecorators(
    ApiResponse({
      status: options.status ?? 200,
      description: options.description ?? 'Paginated list',
      schema: zodToOpenApiSchema(PaginatedResponseSchema(itemSchema, options.mode ?? 'cursor')),
    }),
  );

const ERROR_DESCRIPTIONS: Readonly<Record<number, string>> = {
  400: 'Validation failed',
  401: 'Missing or invalid credentials',
  403: 'Not allowed',
  404: 'Resource not found',
  409: 'Conflict',
  429: 'Rate limited',
  500: 'Internal server error',
  503: 'Service unavailable',
};

/**
 * Documents the standard error body (`ErrorResponseBody`, Errors spec §5) for the given statuses —
 * the error side is NEVER enveloped (§4.2, §12), so it gets its own schema, not `ApiResponseSchema`.
 */
export const ApiErrorResponses = (...statuses: number[]) =>
  applyDecorators(
    ...statuses.map((status) =>
      ApiResponse({
        status,
        description: ERROR_DESCRIPTIONS[status] ?? 'Error',
        schema: zodToOpenApiSchema(ErrorResponseSchema),
      }),
    ),
  );

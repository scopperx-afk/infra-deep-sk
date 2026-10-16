/**
 * The only public surface of the API Infrastructure module — API Infrastructure spec §10.
 * ESLint boundary: `src/infrastructure/api-infrastructure/**` is importable from outside only
 * through this file.
 */
export { ApiInfrastructureModule } from './api-infrastructure.module';
export { API_CONFIG } from './api-infrastructure.tokens';
export type { ApiConfig } from './config/api.schema';

// ── Envelope (§4) ───────────────────────────────────────────────────────────────────────────
export { SkipEnvelope } from './decorators/skip-envelope.decorator';
export { RawResponse } from './decorators/raw-response.decorator';
export {
  buildSuccess,
  buildPartialSuccess,
  buildEmpty,
  buildCursorPage,
  buildOffsetPage,
} from './envelope/builders';
export type { EnvelopeDraft } from './envelope/envelope-draft';
export type { ApiResponse, ApiResponseMeta, PartialFailure } from './envelope/envelope.port';

// ── Pagination (§5) ─────────────────────────────────────────────────────────────────────────
export { encodeCursor, decodeCursor } from './pagination/cursor';
export {
  buildPaginationMeta,
  buildOffsetPaginationMeta,
  fetchLimit,
  toCursorPage,
  toOffsetPage,
} from './pagination/build-meta';
export { CursorPaginationSchema, OffsetPaginationSchema } from './pagination/schemas';
export type { CursorPagination, OffsetPagination } from './pagination/schemas';
export { CursorParams, OffsetParams } from './decorators/pagination-params.decorator';
export type { CursorParamsOptions } from './decorators/pagination-params.decorator';
export type {
  PaginationMeta,
  OffsetPaginationMeta,
  CursorPage,
  OffsetPage,
  CursorPageRequest,
  OffsetPageRequest,
} from './pagination/pagination.port';

// ── Filtering (§6) ──────────────────────────────────────────────────────────────────────────
export { Filterable, Filters } from './filtering/filter-allowlist.decorator';
export { parseFilters } from './filtering/parse-filter';
export { escapeLikePattern } from './filtering/like.util';
export type {
  FilterOperator,
  FilterFieldType,
  FilterableField,
  ParsedFilter,
} from './filtering/filter.port';

// ── Sorting (§7) ────────────────────────────────────────────────────────────────────────────
export { Sortable, Sorts } from './sorting/sort-allowlist.decorator';
export { parseSorts, withTiebreaker } from './sorting/parse-sort';
export type { ParsedSort, SortDirection } from './sorting/sort.port';

// ── Versioning (§8) ─────────────────────────────────────────────────────────────────────────
export { extractApiVersion } from './versioning/extract-version';
export { Deprecated } from './versioning/deprecation.decorator';
export type { DeprecationOptions } from './versioning/deprecation.decorator';

// ── OpenAPI (§9) ────────────────────────────────────────────────────────────────────────────
export {
  ApiSuccessResponse,
  ApiPaginatedResponse,
  ApiErrorResponses,
} from './openapi/api-success-response.decorator';
export type {
  ApiSuccessResponseOptions,
  ApiPaginatedResponseOptions,
} from './openapi/api-success-response.decorator';
export {
  ApiResponseSchema,
  PaginatedResponseSchema,
  PartialSuccessResponseSchema,
  ErrorResponseSchema,
} from './openapi/envelope-schemas';
export {
  ApiZodBody,
  ApiZodQuery,
  ApiCursorPagination,
  ApiOffsetPagination,
} from './openapi/api-zod.decorators';
export type { ZodDtoLike } from './openapi/api-zod.decorators';
export { zodToOpenApiSchema } from './openapi/zod-to-openapi';
export { ListQuery } from './decorators/list-query.decorator';
export type { ListQueryOptions } from './decorators/list-query.decorator';

// ── Testing (§13 test-helper convention — exported from index.ts, like Tracing/Config) ─────
export { withApiRuntime } from './testing/with-api-runtime';
export type { ApiRuntimeOverrides } from './testing/with-api-runtime';

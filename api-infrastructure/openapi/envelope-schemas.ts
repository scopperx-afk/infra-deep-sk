/**
 * Envelope response schemas — API Infrastructure spec §9.2, §9.3. The envelope's own shape is
 * authored ONCE here, so no controller re-describes it in its OpenAPI annotations (§17 principle 1).
 *
 * `PaginatedResponseSchema` takes the ITEM schema (the spec's `ApiResponse<T[]>` return type means
 * the array wrapper is the helper's job, not the caller's) and a `mode` — cursor (default) or
 * offset — because the two shapes of `meta.pagination` differ (§5.1.2 vs §5.2.2).
 */
import { z, type ZodTypeAny } from 'zod';

export const PartialFailureSchema = z.object({
  index: z.number().int().nonnegative().optional(),
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});

export const ApiResponseMetaSchema = z
  .object({
    timestamp: z.string().datetime().optional(),
    apiVersion: z.string().optional(),
    correlationId: z.string().optional(),
  })
  .passthrough(); // domain-extensible (§4.1)

export const CursorPaginationMetaSchema = z.object({
  nextCursor: z.string().optional(),
  prevCursor: z.string().optional(),
  hasMore: z.boolean(),
  limit: z.number().int().positive(),
});

export const OffsetPaginationMetaSchema = z.object({
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  hasMore: z.boolean(),
  total: z.number().int().nonnegative().optional(),
  totalPages: z.number().int().nonnegative().optional(),
});

/** `{ data: T, meta, errors? }` — a successful response. */
export function ApiResponseSchema<T extends ZodTypeAny>(dataSchema: T) {
  return z.object({
    data: dataSchema,
    meta: ApiResponseMetaSchema,
    errors: z.array(PartialFailureSchema).optional(),
  });
}

/** `{ data: T[], meta: { …, pagination } }` — a paginated list. */
export function PaginatedResponseSchema<T extends ZodTypeAny>(
  itemSchema: T,
  mode: 'cursor' | 'offset' = 'cursor',
) {
  return z.object({
    data: z.array(itemSchema),
    meta: ApiResponseMetaSchema.and(
      z.object({
        pagination: mode === 'cursor' ? CursorPaginationMetaSchema : OffsetPaginationMetaSchema,
      }),
    ),
  });
}

/** A 2xx that carries a NON-EMPTY `errors` array (§4.4 partial failure). */
export function PartialSuccessResponseSchema<T extends ZodTypeAny>(dataSchema: T) {
  return z.object({
    data: dataSchema,
    meta: ApiResponseMetaSchema,
    errors: z.array(PartialFailureSchema).min(1),
  });
}

/**
 * The wire shape of an Errors-module `ErrorResponseBody` (Errors spec §5), mirrored for OpenAPI —
 * this module may not import Errors (§2), so the mirror is its responsibility and a contract test
 * (`integration/error-schema.contract.spec.ts`) pins it against Errors' real output.
 */
export const ErrorResponseSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
  traceId: z.string().optional(),
});

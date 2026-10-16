/**
 * `@CursorParams()` / `@OffsetParams()` — resolved pagination request parameters (E-A9).
 *
 * §5.3 gives domains the SCHEMAS; Appendix C then shows a handler hand-calling `decodeCursor()`
 * and re-deriving everything by hand. These two parameter decorators are that appendix's flow made
 * one declaration, using the SAME schemas (`pagination/schemas.ts`) so there is exactly one place
 * the bounds are enforced:
 *
 *   @Get() list(@CursorParams() page: CursorPageRequest) { ... page.limit, page.after ... }
 *
 * A violation throws the raw `ZodError` (Validation spec §8) — Errors maps it to `400
 * VALIDATION_ERROR` — so this module still imports nothing from Errors (§2).
 *
 * Invalid cursor policy. §5.1.3 + §13: an undecodable cursor "degrades to no cursor" (page 1),
 * which is the DEFAULT here. That is the right default for an idempotent public feed, and the
 * wrong one for a client that is mid-export (it would silently restart and loop). So each endpoint
 * can opt into `{ onInvalidCursor: 'reject' }` → `400` on `cursor`. In lenient mode the result
 * carries `cursorRejected: true` so the domain can count/log it.
 */
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { ZodError, type ZodIssue } from 'zod';
import { decodeCursor } from '../pagination/cursor';
import { CursorPaginationSchema, OffsetPaginationSchema } from '../pagination/schemas';
import type {
  CursorPageRequest,
  OffsetPageRequest,
} from '../pagination/pagination.port';

export interface CursorParamsOptions {
  /** `'first-page'` (default, §5.1.3) or `'reject'` (400 on an undecodable cursor). */
  readonly onInvalidCursor?: 'first-page' | 'reject';
}

export function resolveCursorRequest(
  query: unknown,
  options: CursorParamsOptions = {},
): CursorPageRequest {
  const parsed = CursorPaginationSchema.parse(query ?? {});
  if (parsed.cursor === undefined || parsed.cursor === '') {
    return { limit: parsed.limit, cursorRejected: false };
  }
  const after = decodeCursor(parsed.cursor);
  if (after !== null) return { limit: parsed.limit, after, cursorRejected: false };
  if (options.onInvalidCursor === 'reject') {
    const issue: ZodIssue = {
      code: 'custom',
      path: ['cursor'],
      message: 'cursor is invalid or expired',
    };
    throw new ZodError([issue]);
  }
  return { limit: parsed.limit, cursorRejected: true };
}

export function resolveOffsetRequest(query: unknown): OffsetPageRequest {
  const parsed = OffsetPaginationSchema.parse(query ?? {});
  return {
    page: parsed.page,
    limit: parsed.limit,
    offset: (parsed.page - 1) * parsed.limit,
    includeTotal: parsed.includeTotal,
  };
}

const queryOf = (ctx: ExecutionContext): unknown =>
  ctx.switchToHttp().getRequest<{ query?: unknown }>().query;

export const CursorParams = createParamDecorator(
  (options: CursorParamsOptions | undefined, ctx: ExecutionContext) =>
    resolveCursorRequest(queryOf(ctx), options),
);

export const OffsetParams = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => resolveOffsetRequest(queryOf(ctx)),
);

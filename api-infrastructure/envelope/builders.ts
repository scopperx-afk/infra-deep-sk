/**
 * Public builder helpers — API Infrastructure spec §4.6 — plain functions, no DI (the same
 * pattern Tracing §4.2, HTTP §9 and Logger §8 each establish for a cross-cutting primitive).
 *
 * They return an `EnvelopeDraft` (see `envelope-draft.ts`), not a finished `ApiResponse`: the
 * interceptor owns `timestamp`/`apiVersion`/`correlationId` and completes the draft on the way
 * out. (Spec §4.6 types them as returning `ApiResponse<T>` whose `meta` has required fields the
 * builder cannot know — an honest return type is `EnvelopeDraft`.)
 *
 * `buildCursorPage`/`buildOffsetPage` replace Appendix C's hand-assembled
 * `wrapInEnvelope(page.items, { ...defaultMeta(ctx), pagination: … })` — a flow that called two
 * functions §10 never exports (E-A11).
 */
import { buildOffsetPaginationMeta, buildPaginationMeta } from '../pagination/build-meta';
import type { CursorPage, OffsetPage } from '../pagination/pagination.port';
import { makeDraft, type EnvelopeDraft } from './envelope-draft';
import type { ApiResponseMeta, PartialFailure } from './envelope.port';

export function buildSuccess<T>(data: T, meta?: ApiResponseMeta): EnvelopeDraft<T> {
  return makeDraft(data, meta);
}

export function buildPartialSuccess<T>(
  data: T,
  errors: readonly PartialFailure[],
  meta?: ApiResponseMeta,
): EnvelopeDraft<T> {
  return makeDraft(data, meta, errors);
}

export function buildEmpty(meta?: ApiResponseMeta): EnvelopeDraft<null> {
  return makeDraft(null, meta);
}

/** A cursor-paginated list (§5.1): `data` is the items, `meta.pagination` the cursor meta. */
export function buildCursorPage<T>(
  page: CursorPage<T>,
  limit: number,
  meta?: ApiResponseMeta,
): EnvelopeDraft<T[]> {
  return makeDraft(page.items, { ...(meta ?? {}), pagination: buildPaginationMeta(page, limit) });
}

/** An offset-paginated list (§5.2). */
export function buildOffsetPage<T>(
  page: OffsetPage<T>,
  meta?: ApiResponseMeta,
): EnvelopeDraft<T[]> {
  return makeDraft(page.items, { ...(meta ?? {}), pagination: buildOffsetPaginationMeta(page) });
}

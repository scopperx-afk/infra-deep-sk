/**
 * Shared pagination request schemas — API Infrastructure spec §5.3.
 *
 * Exported for domain reuse and `.extend()`-able, exactly as §5.3 shows:
 *
 *   const ListSessionsSchema = CursorPaginationSchema.extend({ unreadOnly: ... });
 *
 * ── Deviation E-A2 ──────────────────────────────────────────────────────────────────────────
 * §5.3's own snippet hardcodes `.max(100).default(20)`, but §11 and Config §13.20 make both
 * numbers Config-driven (`api.pagination.maxLimit` / `defaultLimit`). A static schema cannot be
 * both. `limit` and `page` therefore resolve their bounds at PARSE time from the runtime snapshot
 * (`runtime/api-runtime.ts`), which `ApiInfrastructureModule` fills from Config at bootstrap. The
 * schema is still a plain, extend-able `z.object`.
 *
 * Reject, never clamp (§5.3, Validation spec §6): `?limit=10000` is a 400 with a `FieldError` on
 * `limit`, not a silently-reduced 100 — a caller that asked for 10000 and got 100 has been lied
 * to. Numeric strings must be plain decimal digits: `Number('0x10')`, `Number('1e2')` and
 * `Number(' 5 ')` all "work" in JavaScript and would let many spellings alias one value.
 *
 * The raw type of `limit`/`page` is `unknown` on purpose: a repeated key (`?limit=1&limit=2`)
 * arrives as an array and must produce a clean "must be an integer" message, not Zod's generic
 * union error.
 *
 * Raw failure type: these issues surface as the raw `ZodError` Validation spec §8 mandates, which
 * Errors' mapper already turns into `400 VALIDATION_ERROR` with `details: FieldError[]`.
 */
import { z } from 'zod';
import { getApiRuntime } from '../runtime/api-runtime';

const DIGITS = /^\d{1,9}$/;

/** `undefined` → `fallback()`; otherwise a strictly-formatted positive integer or a custom issue. */
function positiveInt(
  name: string,
  fallback: () => number,
  max: () => number,
): z.ZodType<number, z.ZodTypeDef, unknown> {
  return z.unknown().transform((raw, ctx): number => {
    if (raw === undefined) return fallback();
    const n =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string' && DIGITS.test(raw)
          ? Number(raw)
          : Number.NaN;
    if (!Number.isInteger(n)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${name} must be a positive integer` });
      return z.NEVER;
    }
    const ceiling = max();
    if (n < 1 || n > ceiling) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${name} must be between 1 and ${ceiling}`,
      });
      return z.NEVER;
    }
    return n;
  });
}

export const limitSchema = positiveInt(
  'limit',
  () => getApiRuntime().pagination.defaultLimit,
  () => getApiRuntime().pagination.maxLimit,
);

export const pageSchema = positiveInt(
  'page',
  () => 1,
  () => getApiRuntime().pagination.maxPage,
);

/** `?cursor=` — an opaque string; its decoding/validity is `decodeCursor()`'s concern (§5.1.3), not a 400. */
export const CursorPaginationSchema = z.object({
  cursor: z.string().optional(),
  limit: limitSchema,
});

/** `?includeTotal=true|false` — never `z.coerce.boolean()` (Validation spec §6: `"false"` would coerce to `true`). */
export const OffsetPaginationSchema = z.object({
  page: pageSchema,
  limit: limitSchema,
  includeTotal: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type CursorPagination = z.infer<typeof CursorPaginationSchema>;
export type OffsetPagination = z.infer<typeof OffsetPaginationSchema>;

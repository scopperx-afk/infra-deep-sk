/**
 * Transport-coercion primitives for query strings and route params — Validation spec §6.
 *
 * Query strings and route params arrive as STRINGS, and spec §6 makes coercion the schema author's job.
 * The two shapes that authors keep getting wrong are provided here once, correctly, so that "the schema
 * author's job" is one line and cannot be written in the broken way:
 *
 *  - `queryBoolean()` is §6's mandated `z.enum(['true','false']).transform(...)`. The obvious alternative,
 *    `z.coerce.boolean()`, is `Boolean(value)`: the string `'false'` is truthy, so `?published=false`
 *    silently means TRUE (banned project-wide by `boundary.spec.ts`).
 *  - `queryInt()` accepts DECIMAL INTEGERS only. `z.coerce.number()` is `Number(value)`: `''` and `' '`
 *    become 0, `'0x10'` becomes 16, `'1e3'` becomes 1000, `'Infinity'` passes `.min()`; and a repeated
 *    parameter (`?page=1&page=2`) is an ARRAY, which `Number()` turns into NaN — a confusing message at best.
 *    Here every one of those is a clean 400.
 *
 * Mechanism, not business shape (§3): no limits are baked in beyond the ones the caller passes.
 */
import { z } from 'zod';

const DECIMAL_INTEGER = /^-?\d{1,15}$/;

export function queryBoolean(options: { default?: boolean } = {}) {
  const base = z.enum(['true', 'false']);
  return (options.default === undefined ? base : base.default(options.default ? 'true' : 'false')).transform(
    (v) => v === 'true',
  );
}

export function queryInt(options: { min?: number; max?: number; default?: number } = {}) {
  let range = z.number().int();
  if (options.min !== undefined) range = range.min(options.min);
  if (options.max !== undefined) range = range.max(options.max);
  const parsed = z
    .string()
    .regex(DECIMAL_INTEGER, 'Expected a whole number')
    .transform(Number)
    .pipe(range);
  // `.default()` on a pipeline takes its INPUT type: an absent parameter is replaced by the string form of
  // the default, which then goes through the same checks (a plain ZodDefault — cheaper than z.preprocess).
  return options.default === undefined ? parsed : parsed.default(String(options.default));
}

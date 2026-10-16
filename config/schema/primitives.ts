/**
 * Primitive schemas — Config spec §7.10 (plus `booleanSchema` / `numberSchema`,
 * see the note below).
 *
 * Env vars are ALWAYS strings, and coercion happens in the schema, never in the
 * loader (§5.1). `z.coerce.boolean()` is a trap ("false" → true), so consumers
 * must use `booleanSchema`; `z.coerce.number()` turns "" into 0, so use
 * `numberSchema` for plain numbers. Both are additions to the §7.10 list.
 */
import { z, type ZodTypeAny } from 'zod';

export const portSchema = z.coerce.number().int().min(1).max(65535);

const DURATION_RE = /^(\d+)(ms|s|m|h|d)$/;
const DURATION_UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};
/**
 * Accepts "900s", "30d", "2h", "1500ms", etc. Always normalizes to a plain number
 * of SECONDS for the consuming module — never a string downstream.
 */
export const durationSchema = z
  .string()
  .regex(DURATION_RE, 'expected a duration like "900s", "30d", "2h"')
  .transform((s) => {
    const [, num, unit] = s.match(DURATION_RE)!;
    return (Number(num) * DURATION_UNIT_MS[unit]) / 1000;
  });

const MIME_RE = /^[a-z]+\/[a-z0-9.+-]+$/i;
export const mimeSchema = z
  .string()
  .regex(MIME_RE, 'expected a MIME type like "image/jpeg"');

/** §7.5 — shape only; secret-ness is declared via `RegisterOptions.secretPaths`, never inferred. */
export const secretValueSchema = z.string().min(1);

/**
 * §7.8 — the ONLY place comma-separated values become arrays.
 * Deviation from the literal one-liner: an entirely empty string is an empty
 * list (not `['']`), so `LOGGING__REDACT__PATHS=` means "none". `a,,b` still
 * yields an empty element and fails the item schema visibly.
 */
export const csvArray = <T extends ZodTypeAny>(item: T) =>
  z
    .string()
    .transform((s) =>
      s.trim() === '' ? [] : s.split(',').map((x) => x.trim()),
    )
    .pipe(z.array(item));

/** Strict env-friendly boolean: true|false|1|0 (case-insensitive) or a real boolean. */
export const booleanSchema = z.preprocess(
  (v) => {
    if (typeof v !== 'string') return v;
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0') return false;
    return v;
  },
  z.boolean({ invalid_type_error: 'expected a boolean (true|false|1|0)' }),
);

/** Number from an env string; empty string is NOT 0. */
export const numberSchema = z.preprocess(
  (v) =>
    typeof v === 'string' ? (v.trim() === '' ? Number.NaN : Number(v)) : v,
  z.number({ invalid_type_error: 'expected a number' }),
);

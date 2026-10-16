/**
 * Small Zod helpers shared by this module's two Config namespaces (`security`, `tokens`).
 * Built only from Config's own public primitives — no new env-parsing convention.
 */
import { z, type ZodTypeAny } from 'zod';

/**
 * `FOO=` (an empty string in a `.env` file) means "not set" for an OPTIONAL value.
 * Without this, `SECURITY__HEADERS__CSP__REPORT_URI=` would fail `.url()` validation.
 */
export const optionalString = (inner: ZodTypeAny = z.string()) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), inner.optional());

/**
 * A whole JSON array carried in ONE env var (Config §7.6 — `TOKENS__PROFILES='[{…}]'`).
 * Config hands the raw string to the schema untouched; parsing it is the owning schema's
 * job. A parse failure returns the raw string so Zod reports "expected a JSON array"
 * (never the parser's message, which can quote the offending text — and that text can be a
 * secret).
 */
export const jsonArray = <T extends ZodTypeAny>(item: T) =>
  z.preprocess(
    (v) => {
      if (typeof v !== 'string') return v;
      const s = v.trim();
      if (s === '') return [];
      try {
        return JSON.parse(s) as unknown;
      } catch {
        return v;
      }
    },
    z.array(item, { invalid_type_error: 'expected a JSON array' }),
  );

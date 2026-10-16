/**
 * `EnvelopeDraft` — what a handler returns when it wants to say something the interceptor cannot
 * infer from a bare value: pagination meta, extra meta, or partial failures.
 *
 * ── Deviation E-A1 (the important one) ─────────────────────────────────────────────────────────
 * Spec §4.4 has `wrapInEnvelope()` recognise "a value already wrapped by the domain
 * (`{ data, meta?, errors? }`)" STRUCTURALLY. That heuristic misfires on perfectly legitimate
 * payloads: a handler that returns `{ data: [...], total: 3 }`, or any DTO with a field named
 * `data`, would be silently re-interpreted as an envelope, its sibling fields dropped and the
 * client's payload corrupted — with no error, on a production endpoint nobody re-reads.
 *
 * Recognition is therefore EXPLICIT: only objects minted by this module's builders carry the
 * brand below. Anything else — however much it resembles an envelope — is ordinary `data`. The
 * brand is a `Symbol` key, so it is invisible to `JSON.stringify`, `Object.keys` and spreads and
 * can never leak onto the wire. (A plain `Symbol`, not `Symbol.for`: governing principle #22.)
 */
import type { ApiResponseMeta, PartialFailure } from './envelope.port';

export const ENVELOPE_DRAFT: unique symbol = Symbol('api-infrastructure.envelope-draft');

export interface EnvelopeDraft<T = unknown> {
  readonly data: T;
  readonly meta: Readonly<ApiResponseMeta>;
  readonly errors?: readonly PartialFailure[];
  readonly [ENVELOPE_DRAFT]: true;
}

export function makeDraft<T>(
  data: T,
  meta: ApiResponseMeta | undefined,
  errors?: readonly PartialFailure[],
): EnvelopeDraft<T> {
  const draft: Record<PropertyKey, unknown> = {
    data,
    meta: Object.freeze({ ...(meta ?? {}) }),
  };
  if (errors !== undefined && errors.length > 0) draft.errors = Object.freeze([...errors]);
  Object.defineProperty(draft, ENVELOPE_DRAFT, { value: true, enumerable: false });
  return Object.freeze(draft) as unknown as EnvelopeDraft<T>;
}

export function isEnvelopeDraft(value: unknown): value is EnvelopeDraft {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[ENVELOPE_DRAFT] === true
  );
}

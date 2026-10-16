/**
 * `wrapInEnvelope()` — the one function that turns a handler's return value into the wire
 * envelope — API Infrastructure spec §4.4. Internal: only `EnvelopeInterceptor` calls it; a domain
 * uses the builders (E-A11).
 *
 * Recognises two shapes (the spec's three, with the structural one replaced — E-A1):
 *   1. an `EnvelopeDraft` minted by a builder → its `meta` is merged under the interceptor's;
 *   2. anything else → the value IS `data` (`undefined` becomes `null`: §4.1 "data is present on
 *      every successful response, even when null").
 *
 * Never mutates its input. Returns fresh objects.
 *
 * Reserved meta keys (E-A5). §4.4 says domain meta is "merged over" the interceptor's. For
 * `timestamp`, `apiVersion` and `correlationId` that is the wrong precedence: `meta.correlationId`
 * must equal the `x-correlation-id` header and the id on every log line ("one identifier, one
 * carrier", spec §14 #2), so a handler cannot override it — and a domain-supplied `timestamp`
 * would make clients' clock-skew checks meaningless. Those three always come from the
 * interceptor; every other key is the domain's. `__proto__`-style keys are never copied.
 */
import { isEnvelopeDraft } from './envelope-draft';
import type { ApiResponse, ApiResponseMeta } from './envelope.port';

const RESERVED_META_KEYS: ReadonlySet<string> = new Set(['timestamp', 'apiVersion', 'correlationId']);
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function mergeMeta(base: ApiResponseMeta, domain: Readonly<ApiResponseMeta>): ApiResponseMeta {
  const merged: ApiResponseMeta = { ...base };
  for (const key of Object.keys(domain)) {
    if (RESERVED_META_KEYS.has(key) || UNSAFE_KEYS.has(key)) continue;
    merged[key] = domain[key];
  }
  return merged;
}

export function wrapInEnvelope(result: unknown, baseMeta: ApiResponseMeta): ApiResponse {
  if (isEnvelopeDraft(result)) {
    const wrapped: ApiResponse = {
      data: result.data === undefined ? null : result.data,
      meta: mergeMeta(baseMeta, result.meta),
    };
    if (result.errors !== undefined && result.errors.length > 0) {
      wrapped.errors = [...result.errors];
    }
    return wrapped;
  }
  return { data: result === undefined ? null : result, meta: baseMeta };
}

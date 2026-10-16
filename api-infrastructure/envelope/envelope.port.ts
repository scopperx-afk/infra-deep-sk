/**
 * The success-response wire contract — API Infrastructure spec §4.1.
 *
 * Fixed: `data` is present on every successful response (even `null`); `meta` is present on every
 * successful response; `errors` is OMITTED entirely when empty and present only on partial
 * failures (§4.4). An absent field is omitted, never emitted as `null` (mirrors Logger spec §11).
 *
 * Deviation E-A16: §4.1 types `timestamp` and `apiVersion` as required, yet Config §13.20 lets an
 * operator switch either off (`api.envelope.includeTimestamp/includeApiVersion`). A type that says
 * "always present" while a config key can remove it is a lie the compiler then believes — so both
 * are optional here, and `correlationId` already was.
 */
import type { OffsetPaginationMeta, PaginationMeta } from '../pagination/pagination.port';

export interface PartialFailure {
  /** Position of the failing item in the request's input array, when applicable. */
  index?: number;
  /** Domain-defined, stable error code. */
  code: string;
  message: string;
  details?: unknown;
}

export interface ApiResponseMeta {
  /** ISO-8601 UTC — set by the interceptor (unless `api.envelope.includeTimestamp=false`). */
  timestamp?: string;
  /** The API version serving this response — e.g. `"v1"`. */
  apiVersion?: string;
  /** From Tracing's `getTraceContext()?.correlationId` — omitted when there is none. */
  correlationId?: string;
  /** Present only on paginated responses (§5). */
  pagination?: PaginationMeta | OffsetPaginationMeta;
  /** Domain-extensible — any additional metadata the handler attached. */
  [key: string]: unknown;
}

export interface ApiResponse<T = unknown> {
  data: T;
  meta: ApiResponseMeta;
  errors?: PartialFailure[];
}

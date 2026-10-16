/**
 * The wire contract — Errors spec §5. Fixed by the architecture document
 * (§3.8): exactly these four fields, forever (§16, §21 Anti-Pattern #7 — no
 * `correlationId` alongside `traceId`; that already travels on HTTP's own
 * response header).
 */
export interface ErrorResponseBody {
  code: string;
  message: string;
  details?: unknown;
  /** Omitted, never a literal `"undefined"`, whenever `getTraceContext()` has none (§5, §20). */
  traceId?: string;
}

export type { FieldError } from './app-error';

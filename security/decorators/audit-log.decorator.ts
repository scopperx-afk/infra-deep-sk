/**
 * `@AuditLog()` — Security spec §17.1. Opt-in, per-route, for genuinely security-relevant
 * actions (an admin action, a role change) — never a blanket wrapper around every 401/403:
 * Errors' `GlobalExceptionFilter` already logs each caught rejection once (Errors §11).
 */
import { SetMetadata, type ExecutionContext } from '@nestjs/common';

export interface AuditMetadata {
  readonly action: string;
  readonly resource?: string;
  /** Extra fields merged into the audit entry. A throwing extractor never breaks the request. */
  readonly extractDetails?: (ctx: ExecutionContext) => Record<string, unknown>;
}

export const AUDIT_KEY = 'security:audit:metadata';
export const AuditLog = (meta: AuditMetadata): MethodDecorator => SetMetadata(AUDIT_KEY, meta);

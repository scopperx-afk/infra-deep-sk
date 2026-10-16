/**
 * `AuditLogInterceptor` — Security spec §17.1. Registered once via `APP_INTERCEPTOR`.
 *
 * For a handler marked `@AuditLog(meta)`: exactly ONE `logger.audit(...)` per invocation —
 * on success and on failure (§24). Writes to Logger's `audit` level; a compliance audit
 * TABLE is the separate, not-yet-built Audit module's job.
 *
 * ── SPEC-ERRATA E-S19 ────────────────────────────────────────────────────────────────
 *  1. The sketch injects `LOGGER_RUNTIME` typed `LoggerRuntime`; that interface has no
 *     `audit()` (it is `setLevel/getHealth/getMetricsSnapshot`). `audit()` is on `ILogger`
 *     (`LOGGER_SERVICE`), which is what is injected here.
 *  2. The sketch's `if (!user) return;` silently drops the audit entry for an anonymous
 *     caller — so an `@AuditLog()` on a `@Public()` route (password-reset request, login
 *     attempt) would audit NOTHING while the §24 contract says "exactly one call per
 *     invocation". The entry is written with no `principal` instead: a security-relevant
 *     action by an unauthenticated caller is exactly what an audit trail must show.
 *  3. The failure entry carries `{ name, message, status }`, not `String(error)` — the latter
 *     is an unbounded, possibly sensitive string (a database error quoting a row).
 *
 * A throwing `extractDetails` never breaks the request, and `meta` fields cannot be
 * overridden by extractor output (`action/resource/status/principal` are written last).
 */
import {
  HttpException,
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs';
import { LOGGER_SERVICE, type ILogger } from '../../logger';
import { AUDIT_KEY, type AuditMetadata } from '../decorators/audit-log.decorator';
import type { AuthPrincipal } from '../principal/auth-principal.port';

const MAX_ERROR_MESSAGE_CHARS = 300;

function summarizeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message.slice(0, MAX_ERROR_MESSAGE_CHARS),
      ...(error instanceof HttpException ? { status: error.getStatus() } : {}),
    };
  }
  return { name: 'NonError' };
}

@Injectable()
export class AuditLogInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    @Inject(LOGGER_SERVICE) private readonly logger: ILogger,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.get<AuditMetadata | undefined>(AUDIT_KEY, ctx.getHandler());
    if (!meta) return next.handle();

    const user =
      ctx.getType() === 'http'
        ? (ctx.switchToHttp().getRequest<{ user?: AuthPrincipal }>().user as AuthPrincipal | undefined)
        : undefined;

    return next.handle().pipe(
      tap({
        next: () => this.record(meta, ctx, user, 'success'),
        error: (error: unknown) => this.record(meta, ctx, user, 'failure', error),
      }),
    );
  }

  private record(
    meta: AuditMetadata,
    ctx: ExecutionContext,
    user: AuthPrincipal | undefined,
    status: 'success' | 'failure',
    error?: unknown,
  ): void {
    let extra: Record<string, unknown> = {};
    try {
      extra = meta.extractDetails?.(ctx) ?? {};
    } catch {
      /* a throwing extractor never breaks the request */
    }
    try {
      this.logger.audit(`audit.${meta.action}`, {
        ...extra,
        action: meta.action,
        resource: meta.resource,
        status,
        ...(user ? { principal: { id: user.id, profile: user.profile } } : {}),
        ...(status === 'failure' ? { error: summarizeError(error) } : {}),
      });
    } catch {
      /* the audit write must never turn a handled request into a failure */
    }
  }
}

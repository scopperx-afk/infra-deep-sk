import { ForbiddenException, type CallHandler } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of, throwError } from 'rxjs';
import { AuditLog } from '../decorators/audit-log.decorator';
import { fakeExecutionContext, recordingLogger } from '../testing/security-test-utils';
import { AuditLogInterceptor } from './audit-log.interceptor';

class Admin {
  @AuditLog({ action: 'user.suspend', resource: 'user', extractDetails: (ctx) => ({ target: (ctx.switchToHttp().getRequest() as { params: { id: string } }).params.id }) })
  suspend(): void {}
  @AuditLog({ action: 'role.change', extractDetails: () => { throw new Error('extractor bug'); } })
  changeRole(): void {}
  plain(): void {}
}
const user = { id: 'admin-1', profile: 'admin', claims: { sub: 'admin-1' } };
const ok = (v: unknown = 'done'): CallHandler => ({ handle: () => of(v) });
const failing = (e: Error): CallHandler => ({ handle: () => throwError(() => e) });
const ctx = (handler: (...args: never[]) => unknown, req: unknown) => fakeExecutionContext(req, { handler, klass: Admin });
const build = () => { const logger = recordingLogger(); return { logger, interceptor: new AuditLogInterceptor(new Reflector(), logger) }; };

describe('AuditLogInterceptor (§17.1)', () => {
  it('writes exactly ONE audit entry on success, with principal, action, resource and extracted details', async () => {
    const { logger, interceptor } = build();
    const result = await lastValueFrom(interceptor.intercept(ctx(Admin.prototype.suspend, { user, params: { id: 'u-9' } }), ok('result')));
    expect(result).toBe('result');
    const audits = logger.logs.filter((l) => l.level === 'audit');
    expect(audits).toHaveLength(1);
    expect(audits[0]?.message).toBe('audit.user.suspend');
    expect(audits[0]?.metadata).toMatchObject({ action: 'user.suspend', resource: 'user', status: 'success', target: 'u-9', principal: { id: 'admin-1', profile: 'admin' } });
    expect(audits[0]?.metadata?.['error']).toBeUndefined();
  });

  it('writes exactly ONE audit entry on failure, with a bounded error summary — and rethrows', async () => {
    const { logger, interceptor } = build();
    const denied = new ForbiddenException('Insufficient role');
    await expect(lastValueFrom(interceptor.intercept(ctx(Admin.prototype.suspend, { user, params: { id: 'u-9' } }), failing(denied)))).rejects.toBe(denied);
    const audits = logger.logs.filter((l) => l.level === 'audit');
    expect(audits).toHaveLength(1);
    expect(audits[0]?.metadata).toMatchObject({ status: 'failure', error: { name: 'ForbiddenException', message: 'Insufficient role', status: 403 } });
  });

  it('truncates a huge error message instead of logging an unbounded string', async () => {
    const { logger, interceptor } = build();
    await lastValueFrom(interceptor.intercept(ctx(Admin.prototype.suspend, { user, params: { id: '1' } }), failing(new Error('x'.repeat(5000))))).catch(() => undefined);
    const message = (logger.logs[0]?.metadata?.['error'] as { message: string }).message;
    expect(message.length).toBeLessThanOrEqual(300);
  });

  it('audits an anonymous caller (no principal) rather than silently dropping the entry', async () => {
    const { logger, interceptor } = build();
    await lastValueFrom(interceptor.intercept(ctx(Admin.prototype.suspend, { params: { id: '1' } }), ok()));
    expect(logger.logs).toHaveLength(1);
    expect(logger.logs[0]?.metadata?.['principal']).toBeUndefined();
    expect(logger.logs[0]?.metadata).toMatchObject({ action: 'user.suspend', status: 'success' });
  });

  it('a throwing extractDetails never breaks the request and the entry is still written', async () => {
    const { logger, interceptor } = build();
    await expect(lastValueFrom(interceptor.intercept(ctx(Admin.prototype.changeRole, { user }), ok('fine')))).resolves.toBe('fine');
    expect(logger.logs).toHaveLength(1);
    expect(logger.logs[0]?.metadata).toMatchObject({ action: 'role.change', status: 'success' });
  });

  it('extractor output cannot overwrite the authoritative fields', async () => {
    const { logger, interceptor } = build();
    class Sneaky { @AuditLog({ action: 'real', extractDetails: () => ({ action: 'forged', status: 'failure', principal: 'x' }) }) m(): void {} }
    await lastValueFrom(interceptor.intercept(fakeExecutionContext({ user }, { handler: Sneaky.prototype.m, klass: Sneaky }), ok()));
    expect(logger.logs[0]?.metadata).toMatchObject({ action: 'real', status: 'success', principal: { id: 'admin-1' } });
  });

  it('a failing logger never turns a handled request into a failure', async () => {
    const reflector = new Reflector();
    const broken = { audit: () => { throw new Error('sink down'); } } as never;
    const interceptor = new AuditLogInterceptor(reflector, broken);
    await expect(lastValueFrom(interceptor.intercept(ctx(Admin.prototype.suspend, { user, params: { id: '1' } }), ok('v')))).resolves.toBe('v');
  });

  it('does nothing for handlers without @AuditLog()', async () => {
    const { logger, interceptor } = build();
    await lastValueFrom(interceptor.intercept(ctx(Admin.prototype.plain, { user }), ok()));
    expect(logger.logs).toHaveLength(0);
  });
});

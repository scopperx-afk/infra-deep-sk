import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { AuthPrincipal } from '../principal/auth-principal.port';
import { fakeExecutionContext } from '../testing/security-test-utils';
import { AbstractRoleGuard } from './abstract-role.guard';

/** A concrete guard of the kind a DOMAIN would write: requirements come from a lookup, membership from principal.roles/permissions. */
class TestGuard extends AbstractRoleGuard {
  constructor(private readonly roles?: string[], private readonly permissions?: string[]) {
    super();
  }
  protected getRequiredRoles(_ctx: ExecutionContext): string[] | undefined { return this.roles; }
  protected getRequiredPermissions(_ctx: ExecutionContext): string[] | undefined { return this.permissions; }
  protected userHasRole(user: AuthPrincipal, role: string): boolean { return user.roles?.includes(role) ?? false; }
  protected userHasPermission(user: AuthPrincipal, permission: string): boolean { return user.permissions?.includes(permission) ?? false; }
}

const principal = (roles: string[], permissions: string[]): AuthPrincipal => ({
  id: 'u1', profile: 'admin', claims: { sub: 'u1' }, roles, permissions,
});
const ctxFor = (user?: AuthPrincipal) => fakeExecutionContext({ user });

describe('AbstractRoleGuard (§6.1)', () => {
  it('no requirements → allowed, even with no user (the route did not ask for authorization)', () => {
    expect(new TestGuard().canActivate(ctxFor())).toBe(true);
    expect(new TestGuard([], []).canActivate(ctxFor())).toBe(true);
  });

  it('roles are OR: either role passes, neither fails', () => {
    const guard = new TestGuard(['a', 'b']);
    expect(guard.canActivate(ctxFor(principal(['a'], [])))).toBe(true);
    expect(guard.canActivate(ctxFor(principal(['b'], [])))).toBe(true);
    expect(() => guard.canActivate(ctxFor(principal(['c'], [])))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctxFor(principal(['c'], [])))).toThrow('Insufficient role');
  });

  it('permissions are AND: all required, one missing fails', () => {
    const guard = new TestGuard(undefined, ['x', 'y']);
    expect(guard.canActivate(ctxFor(principal([], ['x', 'y'])))).toBe(true);
    expect(() => guard.canActivate(ctxFor(principal([], ['x'])))).toThrow('Insufficient permission');
  });

  it('role a + permissions x,y passes; role a + permission x alone fails (AND); role c + permissions x,y fails (OR)', () => {
    const guard = new TestGuard(['a', 'b'], ['x', 'y']);
    expect(guard.canActivate(ctxFor(principal(['a'], ['x', 'y'])))).toBe(true);
    expect(() => guard.canActivate(ctxFor(principal(['a'], ['x'])))).toThrow('Insufficient permission');
    expect(() => guard.canActivate(ctxFor(principal(['c'], ['x', 'y'])))).toThrow('Insufficient role');
  });

  it('throws 401 when a requirement exists but no principal does (AuthGuard did not run)', () => {
    expect(() => new TestGuard(['a']).canActivate(ctxFor())).toThrow(UnauthorizedException);
  });

  it('a requirement hook returning a non-array is a bug, not "no requirement"', () => {
    const guard = new TestGuard('admin' as never);
    expect(() => guard.canActivate(ctxFor(principal(['admin'], [])))).toThrow(TypeError);
  });

  it('a throwing membership hook propagates (no swallow-into-allow)', () => {
    class Boom extends TestGuard {
      protected override userHasRole(): boolean { throw new Error('lookup failed'); }
    }
    expect(() => new Boom(['a']).canActivate(ctxFor(principal(['a'], [])))).toThrow('lookup failed');
  });
});

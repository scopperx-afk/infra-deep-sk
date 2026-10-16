/**
 * `AbstractRoleGuard` — Security spec §6.1. Roles are OR ("either `admin` or `moderator`"),
 * permissions are AND ("both `users.view` and `users.suspend`") — the split matches how each
 * concept is naturally read.
 *
 * This module never ships a concrete `AdminOnlyGuard` or `@Roles('admin')`: which claim
 * carries "admin" is domain logic ("infrastructure provides the HOW, the domain owns the
 * WHAT"). Applied per-route via `@UseGuards()` — never globally.
 *
 * Fail-closed details beyond the sketch: a hook that returns a non-array is treated as an
 * empty requirement only when it is `undefined` (a bad type throws, it is not "no
 * requirement"), and a throwing `userHasRole`/`userHasPermission` propagates (500) rather
 * than being swallowed into an allow.
 */
import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { AuthPrincipal } from '../principal/auth-principal.port';

@Injectable()
export abstract class AbstractRoleGuard implements CanActivate {
  /** OR — the user needs at least one. `undefined`/empty = no role requirement. */
  protected abstract getRequiredRoles(ctx: ExecutionContext): string[] | undefined;
  /** AND — the user needs all of them. `undefined`/empty = no permission requirement. */
  protected abstract getRequiredPermissions(ctx: ExecutionContext): string[] | undefined;
  protected abstract userHasRole(user: AuthPrincipal, role: string): boolean;
  protected abstract userHasPermission(user: AuthPrincipal, permission: string): boolean;

  canActivate(ctx: ExecutionContext): boolean {
    const roles = this.getRequiredRoles(ctx);
    const permissions = this.getRequiredPermissions(ctx);
    if ((roles !== undefined && !Array.isArray(roles)) || (permissions !== undefined && !Array.isArray(permissions))) {
      throw new TypeError('AbstractRoleGuard: getRequiredRoles/getRequiredPermissions must return an array or undefined');
    }
    const noRoles = !roles || roles.length === 0;
    const noPermissions = !permissions || permissions.length === 0;
    if (noRoles && noPermissions) return true;

    const { user } = ctx.switchToHttp().getRequest<{ user?: AuthPrincipal }>();
    if (!user) throw new UnauthorizedException(); // AuthGuard (§5) must have run first

    const rolesOk = noRoles || roles.some((r) => this.userHasRole(user, r));
    const permissionsOk = noPermissions || permissions.every((p) => this.userHasPermission(user, p));
    if (!rolesOk) throw new ForbiddenException('Insufficient role');
    if (!permissionsOk) throw new ForbiddenException('Insufficient permission');
    return true;
  }
}

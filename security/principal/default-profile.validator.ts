/**
 * `DefaultProfileValidator` — the fallback for a profile with no registered validator.
 *
 * Performs only the minimum safe check — `claims.sub` is a non-empty string — with no
 * database access and no roles/permissions (`undefined`, i.e. "no role system"). The
 * "WARN once per profile so a missing registration is discoverable" behaviour lives in
 * `AuthGuard` (it owns the logger and knows when the fallback is taken); this class is
 * stateless and no-arg-constructible, which is how Realtime's handshake (`new
 * DefaultProfileValidator()`, realtime spec §4.2) uses it.
 */
import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '../../config';
import type { JwtClaims } from '../token/token.types';
import type { AuthPrincipal } from './auth-principal.port';
import type { ProfileValidator } from './profile-validator.port';

export class DefaultProfileValidator implements ProfileValidator {
  async validate(claims: JwtClaims, _config: ConfigService, profileName?: string): Promise<AuthPrincipal> {
    if (typeof claims.sub !== 'string' || claims.sub === '') {
      throw new UnauthorizedException('Invalid or expired token');
    }
    return Object.freeze({ id: claims.sub, profile: profileName ?? 'default', claims });
  }
}

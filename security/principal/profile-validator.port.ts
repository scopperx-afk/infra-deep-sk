/**
 * `ProfileValidator` — the account-status hook, Security spec §5.3.
 *
 * Security verifies that a token is AUTHENTIC; whether the ACCOUNT behind it is still
 * allowed to act (deleted, suspended, banned, pending approval…) is domain knowledge
 * Security cannot have (Layer 1 cannot import the domain). The domain registers one
 * validator per `tokens.profiles[].name` through `SecurityModule.forRoot({ profileValidators })`.
 */
import type { ConfigService } from '../../config';
import type { JwtClaims } from '../token/token.types';
import type { AuthPrincipal } from './auth-principal.port';

export interface ProfileValidator {
  /**
   * Given verified claims, resolves the full `AuthPrincipal` (§5.2).
   * Throws `UnauthorizedException` when the account is invalid.
   * Runs on EVERY request — implementations MUST cache aggressively; the cache itself lives
   * in the domain (or behind `CacheInvalidationBus`, §20), never inside this module.
   *
   * `profileName` (SPEC-ERRATA E-S16 — additive third parameter): the name of the profile
   * whose secret verified the token. `AuthPrincipal.profile` must equal it; a validator
   * registered under one profile name already knows it, but `DefaultProfileValidator` serves
   * ANY profile and needs it. `AuthGuard` rejects a principal whose `id`/`profile` disagree
   * with the verified token.
   */
  validate(claims: JwtClaims, config: ConfigService, profileName?: string): Promise<AuthPrincipal>;
}

export type ProfileValidatorRegistry = Readonly<Record<string, ProfileValidator>>;

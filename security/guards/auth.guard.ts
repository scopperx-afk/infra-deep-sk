/**
 * `AuthGuard` — Security spec §5.1. Registered globally via `APP_GUARD`.
 *
 * Flow: `@Public()` short-circuit → bearer token → `verifyAgainstAnyProfile()` (HS256 only,
 * every `tokens.profiles` entry tried by SIGNATURE, never by unverified claims) → the
 * profile's `ProfileValidator` (account status, roles/permissions) → `req.user`.
 *
 * Failure policy:
 *  - missing / malformed / invalid / expired token → ONE generic 401 ("Missing bearer
 *    token" vs "Invalid or expired token" only distinguishes absent from present; the real
 *    reason — bad signature, wrong issuer, expiry … — is logged at DEBUG and never sent, so
 *    the response is not an oracle);
 *  - a validator that throws `UnauthorizedException` (suspended account…) is passed through;
 *  - a validator that throws ANYTHING ELSE (database down) propagates — the request FAILS
 *    CLOSED as a 5xx via Errors; an outage must not silently authenticate nor be disguised
 *    as a bad token.
 *
 * Non-HTTP execution contexts (a WebSocket gateway, an RPC handler) are NOT this guard's —
 * Realtime authenticates at handshake with the same verification (`createTokenVerifier`,
 * realtime spec §4.1–4.2) and "has no `@Public()`-equivalent". Returning `true` there is not
 * fail-open: there is no HTTP request to authenticate, and `APP_GUARD` would otherwise
 * reject every socket message.
 */
import {
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { CONFIG_SERVICE, type ConfigService } from '../../config';
import { LOGGER_SERVICE, type ILogger } from '../../logger';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import type { AuthPrincipal } from '../principal/auth-principal.port';
import { DefaultProfileValidator } from '../principal/default-profile.validator';
import type { ProfileValidator, ProfileValidatorRegistry } from '../principal/profile-validator.port';
import { PROFILE_VALIDATORS, SECURITY_CLOCK } from '../security.tokens';
import { extractBearerToken } from '../token/bearer.util';
import { DEFAULT_CLOCK_TOLERANCE_SECONDS, verifyAgainstAnyProfile } from '../token/jwt.util';
import { ALLOWED_ALGORITHMS, type TokenProfile } from '../token/token.types';
import type { Clock } from '../util/clock';

type AuthenticatedRequest = Request & { user?: AuthPrincipal };

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly defaultValidator = new DefaultProfileValidator();
  private readonly warnedProfiles = new Set<string>();

  constructor(
    @Inject(CONFIG_SERVICE) private readonly config: ConfigService,
    @Inject(PROFILE_VALIDATORS) private readonly validators: ProfileValidatorRegistry,
    @Inject(SECURITY_CLOCK) private readonly clock: Clock,
    @Inject(LOGGER_SERVICE) private readonly logger: ILogger,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true; // see file header
    if (this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()])) {
      return true; // @Public()
    }

    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = extractBearerToken(req.headers);
    if (token === undefined) throw new UnauthorizedException('Missing bearer token');

    const profiles = this.config.get<readonly TokenProfile[]>('tokens.profiles');
    const result = verifyAgainstAnyProfile(token, profiles, {
      algorithms: ALLOWED_ALGORITHMS,
      clockToleranceSeconds: DEFAULT_CLOCK_TOLERANCE_SECONDS,
      clock: this.clock,
    });
    if (!result.profile) {
      this.logger.debug('auth.token_rejected', { reason: result.failure });
      throw new UnauthorizedException('Invalid or expired token');
    }

    const { profile, claims } = result;
    const principal = await this.resolveValidator(profile.name).validate(claims, this.config, profile.name);
    if (principal.id !== claims.sub || principal.profile !== profile.name) {
      // A programming error in a domain validator — never let it mint an identity that the
      // token did not carry (id !== sub would let one account act as another).
      this.logger.error('auth.validator_contract_violation', undefined, {
        profile: profile.name,
        expectedProfile: profile.name,
        returnedProfile: principal.profile,
        idMatchesSub: principal.id === claims.sub,
      });
      throw new Error(`ProfileValidator for "${profile.name}" returned a principal that does not match the verified token`);
    }
    req.user = principal;
    return true;
  }

  private resolveValidator(profileName: string): ProfileValidator {
    const registered = Object.prototype.hasOwnProperty.call(this.validators, profileName)
      ? this.validators[profileName]
      : undefined;
    if (registered) return registered;
    if (!this.warnedProfiles.has(profileName)) {
      this.warnedProfiles.add(profileName);
      this.logger.warn('auth.default_profile_validator', {
        profile: profileName,
        message: `No ProfileValidator registered for profile "${profileName}"; only the minimum check (non-empty sub) is applied — account status is NOT verified`,
      });
    }
    return this.defaultValidator;
  }
}

import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Public } from '../decorators/public.decorator';
import type { AuthPrincipal } from '../principal/auth-principal.port';
import type { ProfileValidator } from '../principal/profile-validator.port';
import type { JwtClaims } from '../token/token.types';
import {
  SECRET_ADMIN,
  SECRET_DEFAULT,
  SECRET_REFRESH,
  TEST_CLOCK,
  TEST_PROFILES,
  fakeConfigService,
  fakeExecutionContext,
  recordingLogger,
  signTestJwt,
  validClaims,
} from '../testing/security-test-utils';
import { AuthGuard } from './auth.guard';

class Routes {
  @Public()
  open(): void {}
  closed(): void {}
}

const config = fakeConfigService({ tokens: { profiles: TEST_PROFILES } });

function build(validators: Record<string, ProfileValidator> = {}) {
  const logger = recordingLogger();
  const guard = new AuthGuard(config, validators, TEST_CLOCK, logger, new Reflector());
  return { guard, logger };
}
const request = (token?: string, headers: Record<string, string> = {}) => ({
  headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
  user: undefined as AuthPrincipal | undefined,
  query: {} as Record<string, string>,
});
const ctx = (req: unknown, handler: (...args: never[]) => unknown = Routes.prototype.closed, type = 'http') =>
  fakeExecutionContext(req, { handler, klass: Routes, type });

describe('AuthGuard (§5.1)', () => {
  it('resolves req.user as an AuthPrincipal for a valid token (default validator)', async () => {
    const { guard } = build();
    const req = request(signTestJwt(validClaims(), SECRET_DEFAULT));
    await expect(guard.canActivate(ctx(req))).resolves.toBe(true);
    expect(req.user).toEqual({ id: 'user-1', profile: 'default', claims: expect.objectContaining({ sub: 'user-1' }) });
    expect(req.user?.roles).toBeUndefined();
  });

  it('REGRESSION: a token for the second profile in tokens.profiles verifies', async () => {
    const { guard } = build();
    const req = request(signTestJwt(validClaims({ iss: 'admin-api', aud: 'admin', sub: 'admin-7' }), SECRET_ADMIN));
    await guard.canActivate(ctx(req));
    expect(req.user?.profile).toBe('admin');
    expect(req.user?.id).toBe('admin-7');
  });

  it('a @Public() route proceeds with no token at all', async () => {
    const { guard } = build();
    await expect(guard.canActivate(ctx(request(), Routes.prototype.open))).resolves.toBe(true);
  });

  it('throws 401 BEFORE the handler for a missing token', async () => {
    const { guard } = build();
    await expect(guard.canActivate(ctx(request()))).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(guard.canActivate(ctx(request()))).rejects.toThrow('Missing bearer token');
  });

  it('throws one generic 401 for every kind of bad token — the response is not an oracle', async () => {
    const { guard, logger } = build();
    const bad = [
      'garbage.token.here',
      signTestJwt(validClaims({ exp: 1 }), SECRET_DEFAULT), // expired
      signTestJwt(validClaims(), 'x'.repeat(48)), // wrong secret
      signTestJwt(validClaims(), SECRET_REFRESH), // refresh secret
      signTestJwt(validClaims(), SECRET_DEFAULT, { alg: 'none' }),
      signTestJwt(validClaims({ aud: 'other' }), SECRET_DEFAULT),
    ];
    for (const token of bad) {
      const error = await guard.canActivate(ctx(request(token))).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnauthorizedException);
      expect((error as UnauthorizedException).message).toBe('Invalid or expired token');
    }
    // the real reason is logged at DEBUG, never the token itself
    expect(logger.logs.filter((l) => l.message === 'auth.token_rejected')).toHaveLength(bad.length);
    expect(JSON.stringify(logger.logs)).not.toContain('garbage.token.here');
  });

  it('only reads the Authorization header — a token in the query string is ignored', async () => {
    const { guard } = build();
    const req = request();
    req.query['access_token'] = signTestJwt(validClaims(), SECRET_DEFAULT);
    await expect(guard.canActivate(ctx(req))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  describe('ProfileValidator (§5.3)', () => {
    it('uses the validator registered for the verified profile and sets its principal', async () => {
      const validate = jest.fn(async (claims: JwtClaims, _config: unknown, profileName?: string): Promise<AuthPrincipal> => ({
        id: claims.sub,
        profile: profileName ?? 'unknown',
        claims,
        roles: ['admin'],
        permissions: ['users.view'],
      }));
      const { guard } = build({ admin: { validate } });
      const req = request(signTestJwt(validClaims({ iss: 'admin-api', aud: 'admin' }), SECRET_ADMIN));
      await guard.canActivate(ctx(req));
      expect(validate).toHaveBeenCalledTimes(1);
      expect(req.user?.roles).toEqual(['admin']);
    });

    it('a suspended/banned/deleted account throws via its validator, verified per profile', async () => {
      const suspended: ProfileValidator = { validate: async () => { throw new UnauthorizedException('Account suspended'); } };
      const { guard } = build({ default: suspended });
      await expect(guard.canActivate(ctx(request(signTestJwt(validClaims(), SECRET_DEFAULT))))).rejects.toThrow('Account suspended');
      // the OTHER profile (no validator for it) is unaffected
      const adminReq = request(signTestJwt(validClaims({ iss: 'admin-api', aud: 'admin' }), SECRET_ADMIN));
      await expect(guard.canActivate(ctx(adminReq))).resolves.toBe(true);
    });

    it('falls back to DefaultProfileValidator and logs WARN exactly once per profile', async () => {
      const { guard, logger } = build();
      for (let i = 0; i < 3; i++) await guard.canActivate(ctx(request(signTestJwt(validClaims(), SECRET_DEFAULT))));
      await guard.canActivate(ctx(request(signTestJwt(validClaims({ iss: 'admin-api', aud: 'admin' }), SECRET_ADMIN))));
      const warns = logger.logs.filter((l) => l.level === 'warn' && l.message === 'auth.default_profile_validator');
      expect(warns.map((w) => w.metadata?.['profile'])).toEqual(['default', 'admin']);
    });

    it('a non-401 validator failure (database down) propagates — the request fails CLOSED, not as a bad token', async () => {
      const outage = new Error('db unreachable');
      const { guard } = build({ default: { validate: async () => { throw outage; } } });
      await expect(guard.canActivate(ctx(request(signTestJwt(validClaims(), SECRET_DEFAULT))))).rejects.toBe(outage);
    });

    it('REJECTS a validator that returns a principal not matching the verified token (id !== sub, wrong profile)', async () => {
      const wrongId: ProfileValidator = { validate: async (claims) => ({ id: 'someone-else', profile: 'default', claims }) };
      const wrongProfile: ProfileValidator = { validate: async (claims) => ({ id: claims.sub, profile: 'admin', claims }) };
      const token = signTestJwt(validClaims(), SECRET_DEFAULT);
      const a = build({ default: wrongId });
      await expect(a.guard.canActivate(ctx(request(token)))).rejects.toThrow('does not match the verified token');
      const b = build({ default: wrongProfile });
      await expect(b.guard.canActivate(ctx(request(token)))).rejects.toThrow('does not match the verified token');
      expect(a.logger.logs.some((l) => l.level === 'error' && l.message === 'auth.validator_contract_violation')).toBe(true);
    });

    it('does not treat a prototype key as a registered validator', async () => {
      const profiles = [{ name: 'constructor', secretRef: SECRET_DEFAULT }];
      const guard = new AuthGuard(fakeConfigService({ tokens: { profiles } }), {}, TEST_CLOCK, recordingLogger(), new Reflector());
      const req = request(signTestJwt({ sub: 'u', exp: 1_800_000_900 }, SECRET_DEFAULT));
      await expect(guard.canActivate(ctx(req))).resolves.toBe(true);
      expect(req.user?.profile).toBe('constructor');
    });
  });

  it('does not apply to non-HTTP contexts (Realtime authenticates at handshake with the same verification)', async () => {
    const { guard } = build();
    await expect(guard.canActivate(ctx({}, Routes.prototype.closed, 'ws'))).resolves.toBe(true);
  });

  it('ForbiddenException is not what a bad token produces (401 vs 403 stay distinct)', async () => {
    const { guard } = build();
    await expect(guard.canActivate(ctx(request('a.b.c')))).rejects.not.toBeInstanceOf(ForbiddenException);
  });
});

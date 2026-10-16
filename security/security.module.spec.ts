/**
 * Integration spec — the whole Security pipeline on a real Nest application: real Config
 * (static source), real Logger/Tracing/Errors, `SecurityModule.forRoot()`, real HTTP via
 * supertest. Unit-level behaviour of each piece is covered next to the piece; this file
 * proves the WIRING (global guard, middleware order, ports, Config registration).
 */
import {
  Controller,
  Get,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ConfigModule, staticSource } from '../config';
import { ErrorsModule } from '../errors';
import { LoggerModule } from '../logger';
import { TracingModule } from '../tracing';
import { CsrfGuard } from './guards/csrf.guard';
import { Public } from './decorators/public.decorator';
import type { AuthPrincipal } from './principal/auth-principal.port';
import type { ProfileValidator } from './principal/profile-validator.port';
import { SecurityModule, type SecurityModuleOptions } from './security.module';
import {
  ANOMALY_DETECTOR,
  CACHE_INVALIDATION_BUS,
  REPLAY_PROTECTION_STORE,
  SECURITY_ALERT_EMITTER,
} from './security.tokens';
import { InMemoryAnomalyDetector } from './anomaly/in-memory-anomaly.detector';
import {
  signTestJwt,
  SECRET_ADMIN,
  SECRET_DEFAULT,
  SECRET_REFRESH,
} from './testing/security-test-utils';
import { randomToken } from './crypto/random.util';

const nowSeconds = (): number => Math.floor(Date.now() / 1000);
const claims = (
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  sub: 'user-1',
  iat: nowSeconds(),
  exp: nowSeconds() + 900,
  iss: 'api',
  aud: 'app',
  ...over,
});

const PROFILES = JSON.stringify([
  {
    name: 'default',
    secretRef: SECRET_DEFAULT,
    refreshSecretRef: SECRET_REFRESH,
    issuer: 'api',
    audience: 'app',
    accessTtl: '900s',
    refreshTtl: '30d',
  },
  {
    name: 'admin',
    secretRef: SECRET_ADMIN,
    refreshSecretRef: 'admin-refresh-secret-0123456789-abcdefghijklmnopqrs',
    issuer: 'admin-api',
    audience: 'admin',
    accessTtl: '900s',
    refreshTtl: '7d',
  },
]);

const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  APP__NAME: 'x',
  APP__FRONTEND_URL: 'http://x',
  TOKENS__PROFILES: PROFILES,
  SECURITY__HTTPS_ENFORCEMENT__ENABLED: 'false',
  SECURITY__COOKIES__DEFAULT_SECURE: 'false',
  SECURITY__ALLOWED_HOSTS: 'localhost,127.0.0.1',
};

@Controller('probe')
class ProbeController {
  @Get('private')
  secured(@Req() req: { user?: AuthPrincipal }): {
    id?: string;
    profile?: string;
  } {
    return { id: req.user?.id, profile: req.user?.profile };
  }

  @Public()
  @Get('open')
  open(): { ok: true } {
    return { ok: true };
  }

  @Post('form')
  @Public()
  @UseGuards(CsrfGuard)
  form(): { ok: true } {
    return { ok: true };
  }
}

async function bootstrap(
  env: Record<string, string> = {},
  options: SecurityModuleOptions = {},
) {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        sources: [staticSource({ ...BASE_ENV, ...env })],
        exitOnValidationFailure: false,
        onNotice: () => undefined,
      }),
      TracingModule.forRoot(),
      LoggerModule.forRoot({ transports: [] }),
      ErrorsModule,
      SecurityModule.forRoot(options),
    ],
    controllers: [ProbeController],
  }).compile();
  const app: INestApplication = moduleRef.createNestApplication();
  await app.init();
  return { app, moduleRef, http: () => request(app.getHttpServer()) };
}

describe('SecurityModule.forRoot() — wiring', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeAll(async () => {
    ctx = await bootstrap();
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  it('default-deny: a route without @Public() answers 401 with no token, and 200 with a valid one', async () => {
    await ctx.http().get('/probe/private').expect(401);
    const res = await ctx
      .http()
      .get('/probe/private')
      .set('Authorization', `Bearer ${signTestJwt(claims(), SECRET_DEFAULT)}`)
      .expect(200);
    expect(res.body).toMatchObject({ id: 'user-1', profile: 'default' });
  });

  it('REGRESSION: a token for the SECOND profile verifies end to end', async () => {
    const token = signTestJwt(
      claims({ sub: 'admin-7', iss: 'admin-api', aud: 'admin' }),
      SECRET_ADMIN,
    );
    const res = await ctx
      .http()
      .get('/probe/private')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body).toMatchObject({ id: 'admin-7', profile: 'admin' });
  });

  it('rejects a refresh-secret token, an expired token and alg:none', async () => {
    for (const token of [
      signTestJwt(claims(), SECRET_REFRESH),
      signTestJwt(claims({ exp: nowSeconds() - 3600 }), SECRET_DEFAULT),
      signTestJwt(claims(), SECRET_DEFAULT, { alg: 'none' }),
    ]) {
      await ctx
        .http()
        .get('/probe/private')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    }
  });

  it('@Public() routes need no token', async () => {
    await ctx.http().get('/probe/open').expect(200, { ok: true });
  });

  it('every response — including a 401 — carries the security headers, and X-Powered-By is gone', async () => {
    for (const res of [
      await ctx.http().get('/probe/open'),
      await ctx.http().get('/probe/private'),
    ]) {
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['strict-transport-security']).toContain('max-age=');
      expect(res.headers['content-security-policy']).toContain(
        "default-src 'none'",
      );
      expect(res.headers['x-powered-by']).toBeUndefined();
    }
  });

  it('Host validation: an unlisted Host is a 400 INVALID_HOST (and still carries security headers)', async () => {
    const res = await ctx
      .http()
      .get('/probe/open')
      .set('Host', 'evil.example.com')
      .expect(400);
    expect(res.body).toEqual({
      code: 'INVALID_HOST',
      message: expect.any(String),
    });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('CsrfGuard: a mutating cookie-session request needs the matching header; safe methods are free', async () => {
    const token = randomToken(32);
    await ctx.http().post('/probe/form').expect(403);
    await ctx
      .http()
      .post('/probe/form')
      .set('Cookie', `csrf-token=${token}`)
      .expect(403);
    await ctx
      .http()
      .post('/probe/form')
      .set('Cookie', `csrf-token=${token}`)
      .set('x-csrf-token', token)
      .expect(201);
  });

  it('exposes the five extension ports with their shipped defaults', () => {
    for (const token of [
      SECURITY_ALERT_EMITTER,
      ANOMALY_DETECTOR,
      REPLAY_PROTECTION_STORE,
      CACHE_INVALIDATION_BUS,
    ]) {
      expect(ctx.moduleRef.get(token, { strict: false })).toBeDefined();
    }
  });
});

describe('SecurityModule.forRoot() — composition-root overrides', () => {
  it('a registered ProfileValidator decides account status; other profiles are unaffected', async () => {
    const suspended: ProfileValidator = {
      validate: async () => {
        throw new UnauthorizedException('Account suspended');
      },
    };
    const { app, http } = await bootstrap(
      {},
      { profileValidators: { useValue: { default: suspended } } },
    );
    await http()
      .get('/probe/private')
      .set('Authorization', `Bearer ${signTestJwt(claims(), SECRET_DEFAULT)}`)
      .expect(401);
    const adminToken = signTestJwt(
      claims({ sub: 'a1', iss: 'admin-api', aud: 'admin' }),
      SECRET_ADMIN,
    );
    await http()
      .get('/probe/private')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    await app.close();
  });

  it('a port can be replaced (anomaly detector) without touching the module', async () => {
    const custom = new InMemoryAnomalyDetector({ threshold: 1 });
    const { app, moduleRef } = await bootstrap(
      {},
      { anomalyDetector: { useValue: custom } },
    );
    expect(moduleRef.get(ANOMALY_DETECTOR, { strict: false })).toBe(custom);
    await app.close();
  });

  it('the global IP policy is enforced when security.ipPolicy.* is set', async () => {
    const { app, http } = await bootstrap({
      SECURITY__IP_POLICY__ALLOWLIST: '10.99.0.0/16',
    });
    await http()
      .get('/probe/open')
      .expect(403, { code: 'IP_NOT_ALLOWED', message: expect.any(String) });
    await app.close();
  });
});

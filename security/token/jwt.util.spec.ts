import { createHmac } from 'node:crypto';
import { extractBearerToken } from './bearer.util';
import { verifyAgainstAnyProfile } from './jwt.util';
import { createTokenVerifier } from './token-verifier.factory';
import { ALLOWED_ALGORITHMS } from './token.types';
import {
  SECRET_ADMIN,
  SECRET_DEFAULT,
  SECRET_REFRESH,
  TEST_CLOCK,
  TEST_NOW_SECONDS,
  TEST_PROFILES,
  fakeConfigService,
  signTestJwt,
  validClaims,
} from '../testing/security-test-utils';

const verify = (token: string, profiles = TEST_PROFILES, opts: Record<string, unknown> = {}) =>
  verifyAgainstAnyProfile(token, profiles, { algorithms: ALLOWED_ALGORITHMS, clock: TEST_CLOCK, ...opts });
const b64u = (v: unknown): string => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

describe('verifyAgainstAnyProfile (§5.1)', () => {
  it('verifies a token for the first profile', () => {
    const r = verify(signTestJwt(validClaims(), SECRET_DEFAULT));
    expect(r.profile?.name).toBe('default');
    expect(r.claims?.sub).toBe('user-1');
  });

  it('REGRESSION: a token for the SECOND profile verifies (iteration does not stop at index 0)', () => {
    const r = verify(signTestJwt(validClaims({ iss: 'admin-api', aud: 'admin' }), SECRET_ADMIN));
    expect(r.profile?.name).toBe('admin');
  });

  it('selects the profile by SIGNATURE, never by unverified claims', () => {
    // claims claim to be admin's issuer/audience, but are signed with the default secret
    const r = verify(signTestJwt(validClaims({ iss: 'admin-api', aud: 'admin' }), SECRET_DEFAULT));
    expect(r.profile).toBeUndefined();
    expect(r.failure).toBe('issuer_mismatch');
  });

  it('a refresh-secret-signed token is not an access token', () => {
    expect(verify(signTestJwt(validClaims(), SECRET_REFRESH)).failure).toBe('bad_signature');
  });

  describe('algorithm confusion', () => {
    it('rejects alg:none (with and without a fake signature)', () => {
      const none = { alg: 'none', typ: 'JWT' };
      expect(verify(`${b64u(none)}.${b64u(validClaims())}.`).profile).toBeUndefined();
      expect(verify(`${b64u(none)}.${b64u(validClaims())}.${b64u('x')}`).failure).toBe('algorithm_not_allowed');
    });
    it.each(['HS384', 'HS512', 'RS256', 'ES256', 'PS256', 'hs256', 'None'])('rejects alg %s', (alg) => {
      expect(verify(signTestJwt(validClaims(), SECRET_DEFAULT, { alg })).failure).toBe('algorithm_not_allowed');
    });
    it('rejects a missing alg and a crit header; honours the explicit allow-list even for HS256', () => {
      expect(verify(signTestJwt(validClaims(), SECRET_DEFAULT, { typ: 'JWT' })).failure).toBe('algorithm_not_allowed');
      expect(verify(signTestJwt(validClaims(), SECRET_DEFAULT, { alg: 'HS256', crit: ['x'], x: 1 })).failure).toBe('malformed');
      expect(verify(signTestJwt(validClaims(), SECRET_DEFAULT), TEST_PROFILES, { algorithms: ['RS256'] }).failure).toBe('algorithm_not_allowed');
    });
  });

  describe('claims', () => {
    it('requires a numeric exp, a non-empty string sub', () => {
      expect(verify(signTestJwt(validClaims({ exp: undefined }), SECRET_DEFAULT)).failure).toBe('invalid_claims');
      expect(verify(signTestJwt(validClaims({ exp: '9999999999' }), SECRET_DEFAULT)).failure).toBe('invalid_claims');
      expect(verify(signTestJwt(validClaims({ sub: undefined }), SECRET_DEFAULT)).failure).toBe('invalid_claims');
      expect(verify(signTestJwt(validClaims({ sub: '' }), SECRET_DEFAULT)).failure).toBe('invalid_claims');
      expect(verify(signTestJwt(validClaims({ sub: 123 }), SECRET_DEFAULT)).failure).toBe('invalid_claims');
    });
    it('rejects expired tokens but allows 30 s of clock skew', () => {
      expect(verify(signTestJwt(validClaims({ exp: TEST_NOW_SECONDS - 60 }), SECRET_DEFAULT)).failure).toBe('expired');
      expect(verify(signTestJwt(validClaims({ exp: TEST_NOW_SECONDS - 10 }), SECRET_DEFAULT)).profile).toBeDefined();
    });
    it('rejects not-yet-valid (nbf) and future-issued (iat) tokens beyond the skew', () => {
      expect(verify(signTestJwt(validClaims({ nbf: TEST_NOW_SECONDS + 600 }), SECRET_DEFAULT)).failure).toBe('not_yet_valid');
      expect(verify(signTestJwt(validClaims({ iat: TEST_NOW_SECONDS + 600 }), SECRET_DEFAULT)).failure).toBe('invalid_claims');
    });
    it('enforces the profile issuer and audience (string or array)', () => {
      expect(verify(signTestJwt(validClaims({ iss: 'evil' }), SECRET_DEFAULT)).failure).toBe('issuer_mismatch');
      expect(verify(signTestJwt(validClaims({ aud: 'other' }), SECRET_DEFAULT)).failure).toBe('audience_mismatch');
      expect(verify(signTestJwt(validClaims({ aud: ['x', 'app'] }), SECRET_DEFAULT)).profile).toBeDefined();
    });
    it('returns frozen claims', () => {
      expect(Object.isFrozen(verify(signTestJwt(validClaims(), SECRET_DEFAULT)).claims)).toBe(true);
    });
  });

  describe('structure & hostile input', () => {
    it('rejects tampered payloads, bad signature length and non-object payloads', () => {
      const [h, , s] = signTestJwt(validClaims(), SECRET_DEFAULT).split('.') as [string, string, string];
      expect(verify(`${h}.${b64u(validClaims({ sub: 'admin' }))}.${s}`).failure).toBe('bad_signature');
      expect(verify(`${b64u({ alg: 'HS256' })}.${b64u(validClaims())}.${b64u('short')}`).failure).toBe('bad_signature');
      const input = `${b64u({ alg: 'HS256' })}.${b64u('[1]')}`;
      expect(verify(`${input}.${createHmac('sha256', SECRET_DEFAULT).update(input).digest('base64url')}`).failure).toBe('invalid_claims');
    });
    it('never throws on garbage and bounds token size', () => {
      for (const t of ['', 'abc', 'a.b', 'a.b.c.d', 'a+b.c/d.e=f', 'a'.repeat(9000), undefined as never, 12 as never]) {
        expect(verify(t).profile).toBeUndefined();
        expect(verify(t).failure).toBeDefined();
      }
    });
    it('fails with no_profiles for an empty profile list, and skips a profile whose secret is too short', () => {
      expect(verify(signTestJwt(validClaims(), SECRET_DEFAULT), []).failure).toBe('no_profiles');
      expect(verify(signTestJwt(validClaims(), ''), [{ name: 'x', secretRef: '' }]).profile).toBeUndefined();
      expect(verify(signTestJwt(validClaims(), 'short'), [{ name: 'x', secretRef: 'short' }]).profile).toBeUndefined();
    });
  });
});

describe('extractBearerToken', () => {
  it('extracts only a well-formed single Bearer JWT from the Authorization header', () => {
    expect(extractBearerToken({ authorization: 'Bearer aaa.bbb.ccc' })).toBe('aaa.bbb.ccc');
    expect(extractBearerToken({ authorization: 'bearer aaa.bbb.ccc' })).toBe('aaa.bbb.ccc');
    expect(extractBearerToken({ authorization: 'Basic aaa.bbb.ccc' })).toBeUndefined();
    expect(extractBearerToken({ authorization: ['Bearer a.b.c', 'Bearer a.b.c'] })).toBeUndefined();
    expect(extractBearerToken({ authorization: 'Bearer  a.b.c' })).toBeUndefined();
    expect(extractBearerToken({ authorization: 'Bearer a.b.c ' })).toBeUndefined();
    expect(extractBearerToken({ authorization: 'Bearer a.b.c\r\nX: 1' })).toBeUndefined();
    expect(extractBearerToken({ authorization: `Bearer ${'a'.repeat(9000)}.b.c` })).toBeUndefined();
    expect(extractBearerToken({})).toBeUndefined();
  });
});

describe('createTokenVerifier (Realtime TokenVerifier contract)', () => {
  const config = fakeConfigService({ tokens: { profiles: TEST_PROFILES } });
  it('returns { profile, claims } on success and null on any failure', () => {
    const verifier = createTokenVerifier(config, { clock: TEST_CLOCK });
    expect(verifier.verify(signTestJwt(validClaims(), SECRET_DEFAULT))?.profile.name).toBe('default');
    expect(verifier.verify('junk')).toBeNull();
    expect(verifier.verify(signTestJwt(validClaims(), SECRET_REFRESH))).toBeNull();
  });
  it('NEVER throws — even when tokens.profiles cannot be read', () => {
    const broken = { get: () => { throw new Error('boom'); } } as never;
    expect(createTokenVerifier(broken).verify('a.b.c')).toBeNull();
  });
});

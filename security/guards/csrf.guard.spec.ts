import { ForbiddenException } from '@nestjs/common';
import { randomToken } from '../crypto/random.util';
import { defaultSecurityConfig, fakeConfigService, fakeExecutionContext } from '../testing/security-test-utils';
import { CsrfGuard } from './csrf.guard';

const guardFor = (csrf: Record<string, unknown> = {}) =>
  new CsrfGuard(
    fakeConfigService(
      { security: defaultSecurityConfig({ csrf: { enabled: true, cookieName: 'csrf-token', headerName: 'x-csrf-token', ...csrf } }) },
      'production',
    ),
  );
const req = (method: string, cookie: string | undefined, header: string | undefined, extra: Record<string, unknown> = {}) => ({
  method,
  headers: { ...(cookie !== undefined ? { cookie: `csrf-token=${cookie}` } : {}), ...(header !== undefined ? { 'x-csrf-token': header } : {}) },
  ...extra,
});

describe('CsrfGuard (§12.1) — double-submit cookie', () => {
  const token = randomToken(32);

  it('passes when cookie and header carry the same token', () => {
    expect(guardFor().canActivate(fakeExecutionContext(req('POST', token, token)))).toBe(true);
  });

  it('a cookie-session request MISSING the matching header is rejected (403)', () => {
    const guard = guardFor();
    expect(() => guard.canActivate(fakeExecutionContext(req('POST', token, undefined)))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(fakeExecutionContext(req('POST', token, randomToken(32))))).toThrow('Invalid or missing CSRF token');
  });

  it('rejects a missing cookie, an empty pair, and a token this module did not issue', () => {
    const guard = guardFor();
    expect(() => guard.canActivate(fakeExecutionContext(req('DELETE', undefined, token)))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(fakeExecutionContext(req('POST', '', '')))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(fakeExecutionContext(req('PUT', 'attacker-chosen', 'attacker-chosen')))).toThrow(ForbiddenException);
  });

  it('does not check safe methods (GET/HEAD/OPTIONS)', () => {
    const guard = guardFor();
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) {
      expect(guard.canActivate(fakeExecutionContext(req(method, undefined, undefined)))).toBe(true);
    }
  });

  it('works without cookie-parser (reads the Cookie header), and uses req.cookies when a parser ran', () => {
    const guard = guardFor();
    expect(guard.canActivate(fakeExecutionContext({ method: 'POST', headers: { 'x-csrf-token': token }, cookies: { 'csrf-token': token } }))).toBe(true);
    expect(guard.canActivate(fakeExecutionContext({ method: 'POST', headers: { cookie: `a=1; csrf-token=${token}; b=2`, 'x-csrf-token': token } }))).toBe(true);
  });

  it('the first cookie of a name wins — a later duplicate cannot override it', () => {
    const attacker = randomToken(32);
    const request = { method: 'POST', headers: { cookie: `csrf-token=${token}; csrf-token=${attacker}`, 'x-csrf-token': attacker } };
    expect(() => guardFor().canActivate(fakeExecutionContext(request))).toThrow(ForbiddenException);
  });

  it('honours configured cookie/header names and the enabled switch', () => {
    const custom = guardFor({ cookieName: 'xsrf', headerName: 'x-xsrf' });
    expect(custom.canActivate(fakeExecutionContext({ method: 'POST', headers: { cookie: `xsrf=${token}`, 'x-xsrf': token } }))).toBe(true);
    expect(guardFor({ enabled: false }).canActivate(fakeExecutionContext(req('POST', undefined, undefined)))).toBe(true);
  });
});

import { ConnectAttemptTimeoutError } from './connect-with-retry';
import { isTransientNetworkError } from './transient-network-error';

const withCode = (code: unknown, extra: object = {}): Error => Object.assign(new Error('x'), { code }, extra);

describe('isTransientNetworkError', () => {
  it.each(['ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND'])(
    'treats %s as transient',
    (code) => expect(isTransientNetworkError(withCode(code))).toBe(true),
  );

  it("treats this module's own attempt timeout as transient", () => {
    expect(isTransientNetworkError(new ConnectAttemptTimeoutError(100))).toBe(true);
  });

  it('does NOT treat credential/permission/driver errors as transient', () => {
    for (const code of ['EACCES', 'EPERM', 'P1000', 'WRONGPASS', '28P01', 'ERR_TLS_CERT_ALTNAME_INVALID', 18]) {
      expect(isTransientNetworkError(withCode(code))).toBe(false);
    }
    expect(isTransientNetworkError(new Error('authentication failed'))).toBe(false);
  });

  it("sees through Node's AggregateError (happy-eyeballs) and `.cause` chains, but only a few levels deep", () => {
    expect(isTransientNetworkError(new AggregateError([withCode('ECONNREFUSED'), withCode('ECONNREFUSED')]))).toBe(true);
    expect(isTransientNetworkError(new Error('wrapper', { cause: withCode('ETIMEDOUT') }))).toBe(true);
    expect(isTransientNetworkError(new Error('a', { cause: new Error('b', { cause: new Error('c', { cause: withCode('ECONNRESET') }) }) }))).toBe(true);
    const tooDeep = new Error('1', { cause: new Error('2', { cause: new Error('3', { cause: new Error('4', { cause: new Error('5', { cause: withCode('ECONNRESET') }) }) }) }) });
    expect(isTransientNetworkError(tooDeep)).toBe(false);
  });

  it('is total: odd inputs and cyclic causes never throw or loop', () => {
    for (const v of [undefined, null, 0, '', 'ECONNREFUSED', {}, [], () => undefined]) expect(isTransientNetworkError(v)).toBe(false);
    const a: { cause?: unknown } = {};
    a.cause = a;
    expect(isTransientNetworkError(a)).toBe(false);
  });
});

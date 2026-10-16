import { Test } from '@nestjs/testing';
import { ConfigModule, staticSource } from '../../config';
import { httpConfigSchema } from '../config/http.schema';
import { getRequestContext } from '../context/request-context.store';
import { parseAcceptLanguage, RequestContextMiddleware } from './request-context.middleware';

const BASE_ENV = {
  NODE_ENV: 'test',
  APP__NAME: 'x',
  APP__FRONTEND_URL: 'http://x',
  HTTP__CORS__ORIGINS: 'http://allowed.example.com',
};

describe('parseAcceptLanguage() (§9, RFC 7231 §5.3.1)', () => {
  it('returns the single tag when only one is given', () => {
    expect(parseAcceptLanguage('en-US')).toBe('en-US');
  });

  it('picks the highest-q tag among several', () => {
    expect(parseAcceptLanguage('en-US,en;q=0.9,fr;q=0.8')).toBe('en-US'); // en-US has implicit q=1
    expect(parseAcceptLanguage('fr;q=0.5,de;q=0.9,en;q=0.7')).toBe('de');
  });

  it('ignores the wildcard "*" entry rather than returning it as a locale', () => {
    expect(parseAcceptLanguage('*')).toBeUndefined();
    expect(parseAcceptLanguage('*, fr;q=0.8')).toBe('fr');
  });

  it('degrades a malformed q value to the default (1) rather than throwing', () => {
    expect(parseAcceptLanguage('en;q=not-a-number')).toBe('en');
    expect(() => parseAcceptLanguage('en;q=not-a-number')).not.toThrow();
  });

  it('returns undefined for an empty or absent header', () => {
    expect(parseAcceptLanguage(undefined)).toBeUndefined();
    expect(parseAcceptLanguage('')).toBeUndefined();
  });

  it('an out-of-range q value (outside 0..1) degrades to the default (1), not the invalid number', () => {
    // en;q=5 is invalid → treated as q=1 (same as no q at all) → still beats fr's valid q=0.5.
    expect(parseAcceptLanguage('en;q=5,fr;q=0.5')).toBe('en');
  });
});

describe('RequestContextMiddleware (§9, §3 step 2)', () => {
  async function buildMiddleware(env: Record<string, string> = {}): Promise<RequestContextMiddleware> {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          sources: [staticSource({ ...BASE_ENV, ...env })],
          exitOnValidationFailure: false,
          onNotice: () => undefined,
        }),
        ConfigModule.forFeature('http', httpConfigSchema),
      ],
      providers: [RequestContextMiddleware],
    }).compile();
    return moduleRef.get(RequestContextMiddleware);
  }

  const fakeReq = (overrides: Partial<{ headers: Record<string, string>; query: Record<string, unknown> }> = {}) => ({
    headers: overrides.headers ?? {},
    query: overrides.query ?? {},
  });

  it('an explicit ?locale= query param wins over Accept-Language entirely', async () => {
    const mw = await buildMiddleware();
    let captured: unknown;
    mw.use(
      fakeReq({ query: { locale: 'fr-CA' }, headers: { 'accept-language': 'en-US' } }) as never,
      {} as never,
      () => {
        captured = getRequestContext();
      },
    );
    expect(captured).toEqual({ locale: 'fr-CA' });
  });

  it('falls back to parsed Accept-Language when no query override is given', async () => {
    const mw = await buildMiddleware();
    let captured: unknown;
    mw.use(fakeReq({ headers: { 'accept-language': 'de;q=0.9,en;q=0.5' } }) as never, {} as never, () => {
      captured = getRequestContext();
    });
    expect(captured).toEqual({ locale: 'de' });
  });

  it('reads clientVersion off the CONFIGURED header name (default x-client-version)', async () => {
    const mw = await buildMiddleware();
    let captured: unknown;
    mw.use(fakeReq({ headers: { 'x-client-version': '2.3.1' } }) as never, {} as never, () => {
      captured = getRequestContext();
    });
    expect(captured).toEqual({ clientVersion: '2.3.1' });
  });

  it('respects a project-configured clientVersionHeader name', async () => {
    const mw = await buildMiddleware({ HTTP__CLIENT_VERSION_HEADER: 'x-app-version' });
    let captured: unknown;
    mw.use(fakeReq({ headers: { 'x-app-version': '9.9.9', 'x-client-version': 'should-be-ignored' } }) as never, {} as never, () => {
      captured = getRequestContext();
    });
    expect(captured).toEqual({ clientVersion: '9.9.9' });
  });

  it('produces an empty context (no crash) when nothing is present at all', async () => {
    const mw = await buildMiddleware();
    let captured: unknown;
    mw.use(fakeReq() as never, {} as never, () => {
      captured = getRequestContext();
    });
    expect(captured).toEqual({});
  });

  it('calls next() exactly once, synchronously reachable', async () => {
    const mw = await buildMiddleware();
    const next = jest.fn();
    mw.use(fakeReq() as never, {} as never, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

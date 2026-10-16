/**
 * Test helpers for Security's own specs (and for any module that wants to unit-test code
 * guarded by `AuthGuard`). No `jest` dependency — recording fakes, so the same helpers work
 * under any runner. Nothing here is exported from `security/index.ts`.
 */
import { createHmac } from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '../../config';
import type { ILogger } from '../../logger';
import type { TokenProfile } from '../token/token.types';

export const TEST_NOW_SECONDS = 1_800_000_000;
export const TEST_CLOCK = { nowMs: (): number => TEST_NOW_SECONDS * 1000 };

export const SECRET_DEFAULT = 'default-access-secret-0123456789-abcdefghijklmnop';
export const SECRET_ADMIN = 'admin-access-secret-0123456789-abcdefghijklmnopqrs';
export const SECRET_REFRESH = 'refresh-secret-0123456789-abcdefghijklmnopqrstuvw';

export const TEST_PROFILES: readonly TokenProfile[] = Object.freeze([
  { name: 'default', secretRef: SECRET_DEFAULT, issuer: 'api', audience: 'app', accessTtl: 900 },
  { name: 'admin', secretRef: SECRET_ADMIN, issuer: 'admin-api', audience: 'admin', accessTtl: 900 },
]);

const b64u = (value: unknown): string =>
  Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

/** Signs an HS256 JWT. `header` can be overridden to build `alg: none` / wrong-alg attack fixtures. */
export function signTestJwt(
  payload: Record<string, unknown>,
  secret: string,
  header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' },
): string {
  const input = `${b64u(header)}.${b64u(payload)}`;
  return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
}

export const validClaims = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  sub: 'user-1',
  iat: TEST_NOW_SECONDS,
  exp: TEST_NOW_SECONDS + 900,
  iss: 'api',
  aud: 'app',
  ...overrides,
});

/** A ConfigService stand-in over a plain map: `get('a.b')` and `getNamespace('a')`. */
export function fakeConfigService(
  values: Record<string, unknown>,
  environment: 'development' | 'staging' | 'production' | 'test' = 'test',
): ConfigService {
  const resolve = (path: string): unknown =>
    path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], values);
  return {
    get: (path: string, defaultValue?: unknown) => {
      const value = resolve(path);
      return value === undefined ? defaultValue : value;
    },
    has: (path: string) => resolve(path) !== undefined,
    getNamespace: (namespace: string) => values[namespace],
    isProduction: () => environment === 'production',
    getEnvironment: () => environment,
  } as unknown as ConfigService;
}

/** Defaults of `securityConfigSchema` (strict, production-shaped) — spread overrides on top. */
export function defaultSecurityConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    trustProxy: false,
    httpsEnforcement: { enabled: true, redirectStatus: 308 },
    hsts: { maxAge: 63_072_000, includeSubDomains: true, preload: false },
    headers: {
      frameOptions: 'DENY',
      referrerPolicy: 'strict-origin-when-cross-origin',
      permissionsPolicy: 'camera=(), microphone=(), geolocation=(), payment=()',
      coop: 'same-origin',
      coep: 'require-corp',
      corp: 'same-origin',
      csp: {
        enabled: true,
        reportOnly: false,
        reportUri: undefined,
        useNonce: false,
        upgradeInsecureRequests: false,
        defaultSrc: ["'none'"],
        scriptSrc: [],
        styleSrc: [],
        imgSrc: [],
        fontSrc: [],
        connectSrc: [],
        frameSrc: [],
        objectSrc: [],
        baseUri: ["'none'"],
        formAction: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    cookies: { defaultSameSite: 'lax', defaultSecure: true },
    csrf: { enabled: true, cookieName: 'csrf-token', headerName: 'x-csrf-token' },
    injection: { maxJsonDepth: 20, redosTimeoutMs: 100, stripPrototypeKeys: true },
    allowedHosts: [],
    ipPolicy: { allowlist: [], blocklist: [] },
    clamav: { host: undefined, port: 3310, timeoutMs: 30_000, failOpen: false },
    webhookSigning: { secret: undefined, toleranceSeconds: 300 },
    crypto: { currentKeyId: undefined, currentKeyRef: undefined, retiredKeys: [] },
    ...overrides,
  };
}

export interface RecordedLog {
  readonly level: 'trace' | 'debug' | 'info' | 'audit' | 'warn' | 'error' | 'fatal';
  readonly message: string;
  readonly metadata?: Record<string, unknown> | undefined;
  readonly error?: unknown;
}

/** An `ILogger` that records every call. */
export function recordingLogger(): ILogger & { readonly logs: RecordedLog[] } {
  const logs: RecordedLog[] = [];
  const plain = (level: RecordedLog['level']) => (message: string, metadata?: Record<string, unknown>) => {
    logs.push({ level, message, metadata });
  };
  const withError = (level: RecordedLog['level']) => (message: string, error?: unknown, metadata?: Record<string, unknown>) => {
    logs.push({ level, message, error, metadata });
  };
  const logger = {
    logs,
    trace: plain('trace'),
    debug: plain('debug'),
    info: plain('info'),
    audit: plain('audit'),
    warn: plain('warn'),
    error: withError('error'),
    fatal: withError('fatal'),
    child: () => logger,
  };
  return logger as unknown as ILogger & { readonly logs: RecordedLog[] };
}

export interface FakeContextOptions {
  readonly type?: string;
  readonly handler?: (...args: never[]) => unknown;
  readonly klass?: new (...args: never[]) => unknown;
}

export function fakeExecutionContext(req: unknown, options: FakeContextOptions = {}): ExecutionContext {
  const handler = options.handler ?? function handler(): void {};
  const klass = options.klass ?? class FakeController {};
  return {
    getType: () => options.type ?? 'http',
    getHandler: () => handler,
    getClass: () => klass,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

export interface FakeResponse {
  statusCode: number | undefined;
  body: unknown;
  headersSent: boolean;
  readonly headers: Record<string, string>;
  readonly removed: string[];
  readonly cookies: Array<{ name: string; value: string; options: Record<string, unknown> }>;
  readonly cleared: Array<{ name: string; options: Record<string, unknown> }>;
  redirected?: { status: number; url: string };
  readonly locals: Record<string, unknown>;
  status(code: number): FakeResponse;
  json(body: unknown): FakeResponse;
  redirect(status: number, url: string): void;
  setHeader(name: string, value: string): FakeResponse;
  removeHeader(name: string): void;
  cookie(name: string, value: string, options?: Record<string, unknown>): FakeResponse;
  clearCookie(name: string, options?: Record<string, unknown>): FakeResponse;
}

export function fakeResponse(): FakeResponse {
  const res: FakeResponse = {
    statusCode: undefined,
    body: undefined,
    headersSent: false,
    headers: {},
    removed: [],
    cookies: [],
    cleared: [],
    locals: {},
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(body) {
      res.body = body;
      res.headersSent = true;
      return res;
    },
    redirect(status, url) {
      res.redirected = { status, url };
      res.headersSent = true;
    },
    setHeader(name, value) {
      res.headers[name] = value;
      return res;
    },
    removeHeader(name) {
      res.removed.push(name);
    },
    cookie(name, value, options = {}) {
      res.cookies.push({ name, value, options });
      return res;
    },
    clearCookie(name, options = {}) {
      res.cleared.push({ name, options });
      return res;
    },
  };
  return res;
}

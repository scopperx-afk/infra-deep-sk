/**
 * Regression tests for the Logger review findings (L-01 … L-14). Each `describe` names the
 * finding; every test here FAILS on the pre-review code and passes on the fixed code.
 */
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Writable } from 'node:stream';
import type { LogEntry, LogLevel } from './logger.port';
import { LoggerServiceImpl } from './logger.service';
import { LoggerObservation } from './observation/logger.observation';
import { LogRedactor } from './redaction/log-redactor';
import { LogSampler } from './sampling/log-sampler';
import { buildLogEntry } from './serialization/entry-builder';
import { serializeError } from './serialization/error-serializer';
import { ConsoleTransport } from './transports/console/console.transport';
import { FileTransport } from './transports/file/file.transport';
import { SentryTransport } from './transports/sentry/sentry.transport';
import { TransportDispatcher } from './transports/transport-dispatcher';
import type { LogTransport } from './transports/transport.interface';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function memTransport(name = 'mem') {
  const entries: LogEntry[] = [];
  const t: LogTransport = {
    name,
    write: (e) => void entries.push(e),
    health: () => ({ healthy: true }),
    close: async () => undefined,
  };
  return { t, entries };
}

function makeLogger(opts: { level?: LogLevel; transport?: LogTransport; extraRedact?: string[]; limit?: number; policy?: 'truncate' | 'reject' } = {}) {
  const mem = memTransport();
  const obs = new LoggerObservation();
  const d = new TransportDispatcher({ transport: opts.transport ?? mem.t, critical: false }, obs);
  const logger = new LoggerServiceImpl({
    dispatchers: [d],
    identity: { service: 'svc', environment: 'test' },
    redactor: new LogRedactor(opts.extraRedact),
    sampler: new LogSampler({ trace: 1, debug: 1, info: 1 }),
    limit: { sizeLimitBytes: opts.limit ?? 16384, sizeLimitPolicy: opts.policy ?? 'truncate' },
    observation: obs,
    levelHolder: { current: opts.level ?? 'info' },
    getTraceContext: () => ({ correlationId: 'real-cid' }),
  });
  return { logger, entries: mem.entries, obs, d };
}

const baseArgs = {
  level: 'info' as const,
  message: 'hi',
  staticContext: {},
  identity: { service: 'svc' },
  trace: { correlationId: 'real-cid' },
  logContext: undefined,
  redactor: new LogRedactor(),
  limit: { sizeLimitBytes: 16384, sizeLimitPolicy: 'truncate' as const },
  now: () => '2026-01-01T00:00:00.000Z',
};

describe('L-01 — caller metadata can never replace an owned field', () => {
  it('keeps `level`, `message`, `timestamp`, `correlationId`, `service` and files the caller values under meta.*', () => {
    const e = buildLogEntry({
      ...baseArgs,
      metadata: { level: 3, message: 'spoofed', timestamp: 'x', correlationId: 'attacker', service: 'evil', orderId: 'o-1' },
    });
    expect(e.level).toBe('info');
    expect(e.message).toBe('hi');
    expect(e.timestamp).toBe('2026-01-01T00:00:00.000Z');
    expect(e.correlationId).toBe('real-cid');
    expect(e.service).toBe('svc');
    expect(e['meta.level']).toBe(3);
    expect(e['meta.correlationId']).toBe('attacker');
    expect(e.orderId).toBe('o-1'); // non-colliding keys are untouched
  });

  it('`userId` in metadata stays top-level when nothing owns it, and is filed under meta.userId only on a real collision', () => {
    const free = buildLogEntry({ ...baseArgs, metadata: { userId: 'from-caller' } });
    expect(free.userId).toBe('from-caller');
    const owned = buildLogEntry({ ...baseArgs, logContext: { userId: 'from-auth' } as never, metadata: { userId: 'from-caller' } });
    expect(owned.userId).toBe('from-auth');
    expect(owned['meta.userId']).toBe('from-caller');
  });

  it('trace identifiers are never caller-writable, even when no trace context exists', () => {
    const e = buildLogEntry({ ...baseArgs, trace: undefined, metadata: { traceId: 'forged', correlationId: 'forged' } });
    expect(e.traceId).toBeUndefined();
    expect(e.correlationId).toBeUndefined();
    expect(e['meta.traceId']).toBe('forged');
  });

  it('`error` is owned only when an error argument is present', () => {
    const withErr = buildLogEntry({ ...baseArgs, level: 'error', rawError: new Error('real'), metadata: { error: 'caller text' } });
    expect((withErr.error as { message: string }).message).toBe('real');
    expect(withErr['meta.error']).toBe('caller text');
    const without = buildLogEntry({ ...baseArgs, metadata: { error: 'caller text' } });
    expect(without.error).toBe('caller text');
  });

  it('child-logger bindings cannot shadow owned fields either, and `__proto__` never re-parents the entry', () => {
    const e = buildLogEntry({ ...baseArgs, staticContext: { level: 'fatal', note: 'n' } as never, metadata: JSON.parse('{"__proto__":{"polluted":1},"a":1}') });
    expect(e.level).toBe('info');
    expect(e['meta.level']).toBe('fatal');
    expect(Object.getPrototypeOf(e)).toBe(Object.prototype);
    expect((e as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('end-to-end: `{ level: 3 }` is written (not lost) and the Console transport stays healthy', () => {
    const out: string[] = [];
    const sink = new Writable({ write(c, _e, cb) { out.push(String(c)); cb(); } });
    const ct = new ConsoleTransport({ mode: 'json', stdout: sink, stderr: sink });
    const { logger, d } = makeLogger({ transport: ct });
    logger.info('user leveled up', { level: 3, userId: 'u1' });
    expect(out).toHaveLength(1);
    const line = JSON.parse(out[0]);
    expect(line.level).toBe('info');
    expect(line['meta.level']).toBe(3);
    expect(d.health()).toEqual({ healthy: true });
  });
});

describe('L-02 — a logging call never throws into business code', () => {
  it.each([
    ['lazy metadata callback throws', (l: LoggerServiceImpl) => l.info('x', () => { throw new Error('lazy boom'); })],
    ['metadata getter throws', (l: LoggerServiceImpl) => l.info('x', { get a() { throw new Error('getter'); } } as never)],
    ['metadata is a hostile Proxy', (l: LoggerServiceImpl) => l.info('x', new Proxy({}, { ownKeys() { throw new Error('proxy'); } }) as never)],
    ['error.message getter throws', (l: LoggerServiceImpl) => l.error('x', Object.defineProperty(new Error('e'), 'message', { get() { throw new Error('msg'); } }))],
  ])('%s', (_label, call) => {
    const { logger, entries, obs } = makeLogger();
    expect(() => call(logger)).not.toThrow();
    expect(entries.length).toBeGreaterThanOrEqual(1); // a line was still emitted…
    expect(entries[0].message).toBe('x');
    // …and where building failed outright it is flagged + counted instead of vanishing
    const snap = obs.getMetricsSnapshot();
    if (entries[0].logBuildError) {
      expect(snap.logsDroppedByReason.some((r) => r.reason === 'internal_error')).toBe(true);
    }
  });

  it('the degraded line carries message, identity and the REAL correlation id, never the offending metadata', () => {
    const { logger, entries } = makeLogger();
    logger.info('checkout failed', () => { throw new Error('boom'); });
    expect(entries[0]).toMatchObject({ level: 'info', message: 'checkout failed', service: 'svc', correlationId: 'real-cid' });
    expect(String(entries[0].logBuildError)).toContain('boom');
  });
});

describe('L-03 — audit records are never disabled by the level threshold', () => {
  it.each(['warn', 'error', 'fatal'] as LogLevel[])('level=%s still emits audit()', (level) => {
    const { logger, entries } = makeLogger({ level });
    logger.audit('patient record exported', { by: 'u1' });
    expect(entries.map((e) => e.message)).toContain('patient record exported');
  });
  it('ordinary levels are still filtered', () => {
    const { logger, entries } = makeLogger({ level: 'warn' });
    logger.info('nope');
    logger.warn('yes');
    expect(entries.map((e) => e.message)).toEqual(['yes']);
  });
});

describe('L-04/L-05 — redaction covers class instances, errors, spellings and free text', () => {
  const r = new LogRedactor();
  const leaks = (v: unknown, secret: string) => JSON.stringify(r.redact(v)).includes(secret);

  it('walks class instances (DTOs / entities)', () => {
    class Dto { constructor(public email: string, public password: string) {} }
    class Ent { token = 'ent-secret-1'; constructor(public id: number) {} }
    expect(leaks({ dto: new Dto('a@b.c', 'hunter2') }, 'hunter2')).toBe(false);
    expect(leaks({ ent: new Ent(1) }, 'ent-secret-1')).toBe(false);
    expect((r.redact({ dto: new Dto('a@b.c', 'x') }) as { dto: { email: string } }).dto.email).toBe('a@b.c');
  });

  it('redacts credentials carried by an Error placed in metadata (AxiosError.config.headers)', () => {
    class HttpFail extends Error { config = { headers: { Authorization: 'Bearer JWT-IN-PROP' } }; }
    expect(leaks({ err: new HttpFail('upstream') }, 'JWT-IN-PROP')).toBe(false);
  });

  it.each(['api_key', 'x-api-key', 'apiKey', 'API_KEY', 'private_key', 'cardNumber', 'access_token', 'otp', 'pin', 'ssn', 'cvv'])('key %s is redacted', (k) => {
    expect(r.redact({ [k]: 'SECRET-VALUE' })).toEqual({ [k]: '[REDACTED]' });
  });

  it.each(['shipping', 'mapping', 'classNames', 'footprint', 'spinner', 'username', 'email'])('short names do not over-match: %s', (k) => {
    expect(r.redact({ [k]: 'keep' })).toEqual({ [k]: 'keep' });
  });

  it('redacts Bearer credentials, URL credentials and quoted-JSON secrets in free text', () => {
    expect(r.redactText('Authorization: Bearer abc.def.ghi')).not.toContain('abc.def.ghi');
    expect(r.redactText('sent Bearer abcdefgh12345 to upstream')).not.toContain('abcdefgh12345');
    expect(r.redactText('connect postgres://dbuser:DB-PASS@db:5432/app failed')).not.toContain('DB-PASS');
    expect(r.redactText('{"password":"p4ss","user":"u"}')).not.toContain('p4ss');
    expect(r.redactText('GET /cb?access_token=QS-TOKEN-1&ok=1')).not.toContain('QS-TOKEN-1');
    expect(r.redactText('connection to database refused')).toBe('connection to database refused');
  });

  it('redacts string VALUES under innocent keys, and the log message itself', () => {
    expect(leaks({ callback: 'https://x/cb?access_token=QS-2' }, 'QS-2')).toBe(false);
    const e = buildLogEntry({ ...baseArgs, message: 'login failed password=MSG-SECRET' });
    expect(e.message).not.toContain('MSG-SECRET');
  });

  it('survives hostile / exotic values without throwing', () => {
    const cyc: Record<string, unknown> = { a: 1 };
    class Node1 { next: unknown; } const n = new Node1(); n.next = n;
    cyc.self = cyc;
    const exotic = {
      big: 10n, fn: () => 1, sym: Symbol('s'), map: new Map([['password', 'p'], ['k', 'v']]), set: new Set([1, 2]),
      buf: Buffer.from('secret-bytes'), url: new URL('https://u:pw@h/p'), date: new Date(0),
      getter: { get boom(): never { throw new Error('x'); } }, cyc, n,
      json: { toJSON: () => ({ token: 't', ok: 1 }) },
    };
    expect(() => r.redact(exotic)).not.toThrow();
    const out = JSON.stringify(r.redact(exotic)); // must itself be JSON-serializable now
    expect(out).not.toContain('secret-bytes');
    expect(out).not.toContain('"pw"');
    expect(out).toContain('[CIRCULAR]');
  });

  it('replaces EventEmitters (sockets, ClientRequest, streams) by a placeholder', () => {
    class FakeRequest extends EventEmitter { headers = { authorization: 'Bearer X' }; }
    expect(r.redact({ req: new FakeRequest() })).toEqual({ req: '[FakeRequest]' });
  });

  it('is bounded: huge arrays, wide objects, long strings and big graphs are cut with a marker', () => {
    const wide = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`k${i}`, i]));
    const o = r.redact({ arr: Array.from({ length: 5000 }, (_, i) => i), wide, s: 'x'.repeat(100_000) }) as never as { arr: unknown[]; wide: Record<string, unknown>; s: string };
    expect(o.arr.length).toBeLessThanOrEqual(201);
    expect(Object.keys(o.wide).length).toBeLessThanOrEqual(201);
    expect(o.s.length).toBeLessThan(9_000);
    let tree: unknown = 1; for (let i = 0; i < 5; i++) tree = Array.from({ length: 20 }, () => tree);
    expect(JSON.stringify(r.redact(tree)).length).toBeLessThan(200_000);
  });
});

describe('L-06 — `truncate` keeps what fits and names what it omitted', () => {
  it('preserves small identifying fields when one big field overflows the limit', () => {
    const e = buildLogEntry({ ...baseArgs, limit: { sizeLimitBytes: 2048, sizeLimitPolicy: 'truncate' }, metadata: { orderId: 'ord-42', patientRef: 'p-7', payload: 'x'.repeat(5000) } });
    expect(e.orderId).toBe('ord-42');
    expect(e.patientRef).toBe('p-7');
    expect(e.payload).toBeUndefined();
    expect(e.metadataTruncated).toBe(true);
    expect(e.metadataOmittedKeys).toEqual(['payload']);
  });
});

describe('L-07 — error serialization is total and bounded', () => {
  it('a thrown plain object is rendered as JSON, not "[object Object]"', () => {
    const out = serializeError({ code: 'E_X', password: 'p' }, new LogRedactor());
    expect(out.message).toContain('E_X');
    expect(out.message).not.toContain('"p"');
  });
  it('unreadable message/stack getters do not throw', () => {
    const err = Object.defineProperty(new Error('e'), 'stack', { get() { throw new Error('s'); } });
    expect(() => serializeError(err, new LogRedactor())).not.toThrow();
  });
  it('caps an enormous message', () => {
    expect(serializeError(new Error('m'.repeat(200_000)), new LogRedactor()).message.length).toBeLessThan(9_000);
  });
});

describe('L-08/L-09/L-10 — dispatcher: stalled writes, close() hang, blind metrics', () => {
  it('close() returns promptly when the budget is already spent and the transport is stuck', async () => {
    const obs = new LoggerObservation();
    const stuck: LogTransport = { name: 'stuck', write: () => new Promise<void>(() => undefined), health: () => ({ healthy: true }), close: () => new Promise<void>(() => undefined) };
    const d = new TransportDispatcher({ transport: stuck, critical: false }, obs, 100, 0);
    d.dispatch('info', { timestamp: 't', level: 'info', message: 'a' });
    const t0 = Date.now();
    await Promise.race([d.close(50), sleep(2000).then(() => { throw new Error('close() hung'); })]);
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('a write that never settles is abandoned: the queue keeps moving and health() reports the stall', async () => {
    const obs = new LoggerObservation();
    const seen: string[] = [];
    let first = true;
    const t: LogTransport = {
      name: 'flaky',
      write: (e) => { seen.push(e.message); if (first) { first = false; return new Promise<void>(() => undefined); } return Promise.resolve(); },
      health: () => ({ healthy: true }), close: async () => undefined,
    };
    const d = new TransportDispatcher({ transport: t, critical: false }, obs, 100, 40);
    d.dispatch('info', { timestamp: 't', level: 'info', message: 'first' });
    d.dispatch('info', { timestamp: 't', level: 'info', message: 'second' });
    await sleep(15);
    expect(seen).toEqual(['first']);
    await sleep(80);
    expect(seen).toEqual(['first', 'second']); // freed after the timeout
    expect(obs.getMetricsSnapshot().transportErrorsTotal).toBe(1);
  });

  it('health() reports a stalled transport even though the transport itself says healthy', async () => {
    const obs = new LoggerObservation();
    const t: LogTransport = { name: 's', write: () => new Promise<void>(() => undefined), health: () => ({ healthy: true }), close: async () => undefined };
    const d = new TransportDispatcher({ transport: t, critical: false }, obs, 10, 30);
    d.dispatch('info', { timestamp: 't', level: 'info', message: 'x' });
    await sleep(70);
    expect(d.health()).toMatchObject({ healthy: false });
  });

  it('a transport that swallows its own failure (Console) is counted in transportErrorsTotal and reported on stderr when critical', () => {
    const spy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const obs = new LoggerObservation();
      // a bare stream-like (not a real Writable): a real one is destroyed by the first failure and
      // later writes then "succeed" silently — this keeps failing on every call
      const broken = { write: () => { throw new Error('EPIPE'); } } as unknown as NodeJS.WritableStream;
      const ct = new ConsoleTransport({ mode: 'json', stdout: broken, stderr: broken });
      const d = new TransportDispatcher({ transport: ct, critical: true }, obs);
      d.dispatch('info', { timestamp: 't', level: 'info', message: 'lost line' });
      d.dispatch('info', { timestamp: 't', level: 'info', message: 'lost line 2' });
      expect(obs.getMetricsSnapshot().transportErrorsTotal).toBe(2);
      const emergency = spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('critical log transport'));
      expect(emergency).toHaveLength(1); // rate-limited, not a flood
      expect(emergency[0]).toContain('lost line');
    } finally { spy.mockRestore(); }
  });

  it('lines arriving after close() are counted as transport_closed drops, not silently ignored', async () => {
    const obs = new LoggerObservation();
    const m = memTransport();
    const d = new TransportDispatcher({ transport: m.t, critical: false }, obs);
    await d.close(50);
    d.dispatch('info', { timestamp: 't', level: 'info', message: 'late' });
    expect(m.entries).toHaveLength(0);
    expect(obs.getMetricsSnapshot().logsDroppedByReason).toEqual([expect.objectContaining({ reason: 'transport_closed', count: 1 })]);
  });
});

describe('L-11 — Console pretty mode no longer loses a line to JSON.stringify', () => {
  it('falls back to a minimal line when the entry cannot be stringified', () => {
    const out: string[] = [];
    const sink = new Writable({ write(c, _e, cb) { out.push(String(c)); cb(); } });
    const ct = new ConsoleTransport({ mode: 'pretty', stdout: sink, stderr: sink });
    const circular: Record<string, unknown> = {}; circular.me = circular;
    ct.write({ timestamp: 't', level: 'info', message: 'still here', bad: circular } as LogEntry);
    expect(out.join('')).toContain('still here');
    expect(ct.health()).toEqual({ healthy: true });
  });
});

describe('L-12 — FileTransport recovers instead of dying permanently', () => {
  const mk = (m: string): LogEntry => ({ timestamp: '2026-01-01T00:00:00.000Z', level: 'info', message: m });
  it('re-opens the stream after a transient error', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logfix-'));
    const ft = new FileTransport({ appPath: path.join(dir, 'app.log'), errorPath: path.join(dir, 'error.log'), maxSizeBytes: 1e6, maxFiles: 3, compress: false, datePattern: 'none' });
    await ft.write(mk('before'));
    // (ft as any) reaches the private RotatingFile on purpose — simulating ENOSPC mid-run
    const appFile = (ft as unknown as { appFile: { stream: fs.WriteStream; brokenAt: number } }).appFile;
    appFile.stream.emit('error', new Error('ENOSPC'));
    appFile.brokenAt = Date.now() - 60_000; // the recovery interval has elapsed
    await ft.write(mk('after'));
    await ft.write(mk('after-2'));
    await ft.close();
    const lines = fs.readFileSync(path.join(dir, 'app.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).message);
    expect(lines).toEqual(['before', 'after', 'after-2']);
  });

  it('a failed rotation (rename error) still leaves a usable stream behind', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logfix-'));
    const ft = new FileTransport({ appPath: path.join(dir, 'app.log'), errorPath: path.join(dir, 'error.log'), maxSizeBytes: 200, maxFiles: 3, compress: false, datePattern: 'none' });
    // the real `fs` module object (the `import * as fs` namespace above is a frozen copy)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const spy = jest.spyOn(require('node:fs'), 'renameSync').mockImplementationOnce(() => { throw new Error('EBUSY'); });
    try {
      for (let i = 0; i < 6; i++) await ft.write(mk('line-' + i + 'x'.repeat(60)));
      await ft.write(mk('final'));
      await ft.close();
    } finally { spy.mockRestore(); }
    const all = fs.readdirSync(dir).filter((f) => f.startsWith('app.log')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
    expect(all).toContain('final'); // pre-fix: "write after end" → file logging dead for good
  });
});

describe('L-13 — Sentry init is explicit and conservative', () => {
  it('passes sendDefaultPii:false, skipOpenTelemetrySetup:true and drops integrations the app already owns', async () => {
    const init = jest.fn();
    const fakeSdk = { init, withScope: jest.fn(), captureException: jest.fn(), captureMessage: jest.fn(), addBreadcrumb: jest.fn(), close: jest.fn() };
    const t = await SentryTransport.create({ dsn: 'https://k@o0.ingest.sentry.io/1', environment: 'test', tracesSampleRate: 0.1 }, undefined, async () => fakeSdk);
    expect(t).toBeDefined();
    const opts = init.mock.calls[0][0];
    expect(opts.sendDefaultPii).toBe(false);
    expect(opts.skipOpenTelemetrySetup).toBe(true);
    const kept = opts.integrations([{ name: 'Http' }, { name: 'OnUncaughtException' }, { name: 'Console' }, { name: 'LocalVariablesAsync' }, { name: 'Dedupe' }, { name: 'LinkedErrors' }]).map((i: { name: string }) => i.name);
    expect(kept).toEqual(['Dedupe', 'LinkedErrors']);
  });

  it('create() never throws: a missing SDK / failing init reports via onFailure and returns undefined', async () => {
    const onFailure = jest.fn();
    const t = await SentryTransport.create({ dsn: 'x', environment: 'e', tracesSampleRate: 0 }, onFailure, async () => { throw new Error('Cannot find module'); });
    expect(t).toBeUndefined();
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('ERROR/FATAL become events (with a reconstructed Error); other levels become breadcrumbs', async () => {
    const scope = { setLevel: jest.fn(), setTag: jest.fn(), setUser: jest.fn() };
    const fakeSdk = { init: jest.fn(), withScope: jest.fn((fn: (s: typeof scope) => void) => fn(scope)), captureException: jest.fn(), captureMessage: jest.fn(), addBreadcrumb: jest.fn(), close: jest.fn() };
    const t = (await SentryTransport.create({ dsn: 'x', environment: 'e', tracesSampleRate: 0 }, undefined, async () => fakeSdk))!;
    t.write({ timestamp: 't', level: 'info', message: 'crumb', correlationId: 'c1' });
    t.write({ timestamp: 't', level: 'error', message: 'boom', correlationId: 'c1', error: { name: 'DbError', message: 'down', stack: 'DbError: down\n at x' } });
    expect(fakeSdk.addBreadcrumb).toHaveBeenCalledTimes(1);
    expect(fakeSdk.captureException).toHaveBeenCalledTimes(1);
    expect((fakeSdk.captureException.mock.calls[0][0] as Error).name).toBe('DbError');
    expect(scope.setTag).toHaveBeenCalledWith('correlationId', 'c1');
  });
});

describe('L-14 — Nest-style non-string messages are rendered, not "[object Object]"', () => {
  it('log({a:1}) and nestWarn(Error) keep their content', () => {
    const { logger, entries } = makeLogger();
    logger.log({ a: 1 } as never);
    logger.nestWarn(new Error('careful'));
    expect(entries[0].message).toBe('{"a":1}');
    expect(entries[1].message).toBe('careful');
  });
});

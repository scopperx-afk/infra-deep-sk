import type { LogEntry, LogLevel } from './logger.port';
import { LoggerObservation } from './observation/logger.observation';
import { LogRedactor } from './redaction/log-redactor';
import { forceLog } from './sampling/log-sampler';
import { LogSampler } from './sampling/log-sampler';
import type { ServiceIdentity } from './serialization/entry-builder';
import { LoggerServiceImpl, type LevelHolder } from './logger.service';
import type { TransportDispatcher } from './transports/transport-dispatcher';

class FakeDispatcher {
  readonly calls: Array<{ level: LogLevel; entry: LogEntry }> = [];
  dispatch(level: LogLevel, entry: LogEntry): void {
    this.calls.push({ level, entry });
  }
}
const asDispatcher = (f: FakeDispatcher): TransportDispatcher =>
  f as unknown as TransportDispatcher;

function build(
  overrides: {
    level?: LogLevel;
    identity?: ServiceIdentity;
    trace?: () => ReturnType<() => undefined>;
  } = {},
) {
  const dispatcher = new FakeDispatcher();
  const observation = new LoggerObservation();
  const levelHolder: LevelHolder = { current: overrides.level ?? 'info' };
  const service = new LoggerServiceImpl({
    dispatchers: [asDispatcher(dispatcher)],
    identity: overrides.identity ?? {},
    redactor: new LogRedactor(),
    sampler: new LogSampler({ trace: 1, debug: 1, info: 1 }),
    limit: { sizeLimitBytes: 16 * 1024, sizeLimitPolicy: 'truncate' },
    observation,
    levelHolder,
    getTraceContext: () => undefined,
  });
  return { service, dispatcher, observation, levelHolder };
}

describe('LoggerServiceImpl — level filtering (§5)', () => {
  it('a level below the current minimum is not dispatched at all', () => {
    const { service, dispatcher } = build({ level: 'info' });
    service.debug('should be filtered');
    expect(dispatcher.calls).toHaveLength(0);
  });

  it('a level at or above the minimum is dispatched', () => {
    const { service, dispatcher } = build({ level: 'info' });
    service.info('kept');
    service.warn('also kept');
    expect(dispatcher.calls.map((c) => c.level)).toEqual(['info', 'warn']);
  });

  it('setLevel() takes effect immediately for subsequent calls', () => {
    const { service, dispatcher } = build({ level: 'warn' });
    service.info('filtered');
    service.setLevel('info');
    service.info('now kept');
    expect(dispatcher.calls).toHaveLength(1);
    expect(dispatcher.calls[0].entry.message).toBe('now kept');
  });
});

describe('LoggerServiceImpl — lazy metadata evaluation timing (§10)', () => {
  it('never evaluates the callback when the level is filtered out', () => {
    const { service } = build({ level: 'warn' });
    const md = jest.fn(() => ({ expensive: true }));
    service.info('x', md);
    expect(md).not.toHaveBeenCalled();
  });

  it('never evaluates the callback when sampling drops the line', () => {
    const dispatcher = new FakeDispatcher();
    const service = new LoggerServiceImpl({
      dispatchers: [asDispatcher(dispatcher)],
      identity: {},
      redactor: new LogRedactor(),
      sampler: new LogSampler({ trace: 0, debug: 1, info: 1 }),
      limit: { sizeLimitBytes: 1024, sizeLimitPolicy: 'truncate' },
      observation: new LoggerObservation(),
      levelHolder: { current: 'trace' },
      getTraceContext: () => undefined,
    });
    const md = jest.fn(() => ({ expensive: true }));
    service.trace('x', md);
    expect(md).not.toHaveBeenCalled();
    expect(dispatcher.calls).toHaveLength(0);
  });

  it('evaluates the callback exactly once when the line survives both checks', () => {
    const { service, dispatcher } = build({ level: 'info' });
    const md = jest.fn(() => ({ computed: 42 }));
    service.info('x', md);
    expect(md).toHaveBeenCalledTimes(1);
    expect(dispatcher.calls[0].entry.computed).toBe(42);
  });

  it('forceLog() on a plain object still bypasses sampling as expected through the real ILogger call', () => {
    const dispatcher = new FakeDispatcher();
    const service = new LoggerServiceImpl({
      dispatchers: [asDispatcher(dispatcher)],
      identity: {},
      redactor: new LogRedactor(),
      sampler: new LogSampler({ trace: 0, debug: 0, info: 0 }),
      limit: { sizeLimitBytes: 1024, sizeLimitPolicy: 'truncate' },
      observation: new LoggerObservation(),
      levelHolder: { current: 'trace' },
      getTraceContext: () => undefined,
    });
    service.trace('forced through', forceLog({ reason: 'important' }));
    expect(dispatcher.calls).toHaveLength(1);
    expect(dispatcher.calls[0].entry.reason).toBe('important');
  });
});

describe('LoggerServiceImpl — child loggers (§7)', () => {
  it('child() merges static context without mutating the parent', () => {
    const { service, dispatcher } = build();
    const child = service.child({ module: 'posts' });
    child.info('x');
    expect(dispatcher.calls[0].entry.module).toBe('posts');
    service.info('y');
    expect(dispatcher.calls[1].entry.module).toBeUndefined(); // parent unaffected
  });

  it('nested child() calls compound bindings, later keys winning on conflict', () => {
    const { service, dispatcher } = build();
    const grandchild = service
      .child({ module: 'posts' })
      .child({ operation: 'create' })
      .child({ module: 'posts-v2' });
    grandchild.info('x');
    expect(dispatcher.calls[0].entry).toMatchObject({
      module: 'posts-v2',
      operation: 'create',
    });
  });

  it('setLevel() on the ROOT affects an ALREADY-CREATED child — the shared LevelHolder guarantee (§5, §38)', () => {
    const { service, dispatcher } = build({ level: 'warn' });
    const child = service.child({ module: 'posts' }); // created while level is 'warn'
    child.info('filtered for now');
    expect(dispatcher.calls).toHaveLength(0);

    service.setLevel('info'); // changed on the ROOT, after the child already exists
    child.info('now visible');
    expect(dispatcher.calls).toHaveLength(1);
    expect(dispatcher.calls[0].entry.message).toBe('now visible');
  });

  it('setLevel() called ON a child also affects the root and every sibling (same shared holder, either direction)', () => {
    const { service, dispatcher } = build({ level: 'warn' });
    const child = service.child({ module: 'a' });
    (child as unknown as LoggerServiceImpl).setLevel('debug'); // white-box: child also implements LoggerRuntime
    service.debug('now visible via root');
    expect(dispatcher.calls).toHaveLength(1);
  });
});

describe('LoggerServiceImpl — error()/fatal() (§6)', () => {
  it('passes the raw error through to entry building, serialized', () => {
    const { service, dispatcher } = build();
    service.error('failed', new Error('boom'));
    expect(dispatcher.calls[0].entry.error).toMatchObject({
      name: 'Error',
      message: 'boom',
    });
  });

  it('fatal() without an error argument still logs, with no error field', () => {
    const { service, dispatcher } = build();
    service.fatal('shutting down');
    expect(dispatcher.calls[0].entry.error).toBeUndefined();
  });
});

describe('LoggerServiceImpl — identity and trace context threading', () => {
  it('includes service identity fields on every entry', () => {
    const { service, dispatcher } = build({
      identity: {
        service: 'svc',
        environment: 'production',
        instanceId: 'i-1',
      },
    });
    service.info('x');
    expect(dispatcher.calls[0].entry).toMatchObject({
      service: 'svc',
      environment: 'production',
      instanceId: 'i-1',
    });
  });

  it('reads trace context via the injected getTraceContext function, not a hardcoded import', () => {
    const dispatcher = new FakeDispatcher();
    const service = new LoggerServiceImpl({
      dispatchers: [asDispatcher(dispatcher)],
      identity: {},
      redactor: new LogRedactor(),
      sampler: new LogSampler({ trace: 1, debug: 1, info: 1 }),
      limit: { sizeLimitBytes: 1024, sizeLimitPolicy: 'truncate' },
      observation: new LoggerObservation(),
      levelHolder: { current: 'info' },
      getTraceContext: () => ({ correlationId: 'c-xyz', traceId: 't-xyz' }),
    });
    service.info('x');
    expect(dispatcher.calls[0].entry).toMatchObject({
      correlationId: 'c-xyz',
      traceId: 't-xyz',
    });
  });
});

describe('LoggerServiceImpl — getHealth()/getMetricsSnapshot() (§25, §26)', () => {
  it('getMetricsSnapshot() reflects logs actually recorded', () => {
    const { service } = build();
    service.info('a');
    service.warn('b');
    const snap = service.getMetricsSnapshot();
    expect(snap.logsTotal).toBe(2);
    expect(snap.logsByLevel.info).toBe(1);
    expect(snap.logsByLevel.warn).toBe(1);
  });
});

describe('LoggerServiceImpl — NestJS LoggerService compatibility (§29)', () => {
  it('log() maps to info(), treating a trailing string as Nest "context"', () => {
    const { service, dispatcher } = build();
    service.log('starting up', 'AppModule');
    expect(dispatcher.calls[0].level).toBe('info');
    expect(dispatcher.calls[0].entry.message).toBe('starting up');
    expect(dispatcher.calls[0].entry.nestContext).toBe('AppModule');
  });

  it('verbose() maps to trace()', () => {
    const { service, dispatcher } = build({ level: 'trace' });
    service.verbose('detail');
    expect(dispatcher.calls[0].level).toBe('trace');
  });

  it('nestError() with a single trailing string treats it as context, not a stack', () => {
    const { service, dispatcher } = build();
    service.nestError('failed', 'AppModule');
    expect(dispatcher.calls[0].entry.nestContext).toBe('AppModule');
    expect(dispatcher.calls[0].entry.error).toBeUndefined();
  });

  it('nestError() with a multi-line first argument treats it as a stack trace', () => {
    const { service, dispatcher } = build();
    service.nestError(
      'failed',
      'Error: failed\n    at Function.foo (/app.js:1:1)',
      'AppModule',
    );
    expect(dispatcher.calls[0].entry.error).toMatchObject({
      name: 'NestError',
    });
    expect(dispatcher.calls[0].entry.error?.stack).toContain('at Function.foo');
    expect(dispatcher.calls[0].entry.nestContext).toBe('AppModule');
  });

  it('nestError() with no optional params at all just logs the message', () => {
    const { service, dispatcher } = build();
    service.nestError('failed alone');
    expect(dispatcher.calls[0].entry.message).toBe('failed alone');
    expect(dispatcher.calls[0].entry.error).toBeUndefined();
    expect(dispatcher.calls[0].entry.nestContext).toBeUndefined();
  });
});

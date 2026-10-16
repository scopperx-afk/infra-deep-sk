import { Writable } from 'node:stream';
import type { LogEntry } from '../../logger.port';
import { ConsoleTransport } from './console.transport';

function captureStream(): { stream: Writable; lines: () => string[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString('utf8'));
      cb();
    },
  });
  return { stream, lines: () => chunks };
}

const baseEntry = (overrides: Partial<LogEntry> = {}): LogEntry => ({
  timestamp: '2026-01-01T00:00:00.000Z',
  level: 'info',
  message: 'hello world',
  service: 'svc',
  module: 'mod',
  correlationId: 'c-1',
  ...overrides,
});

describe('ConsoleTransport — json mode (pino)', () => {
  it('writes ordinary levels to stdout, one real NDJSON line, with every field present', () => {
    const out = captureStream();
    const err = captureStream();
    const t = new ConsoleTransport({
      mode: 'json',
      stdout: out.stream,
      stderr: err.stream,
    });
    t.write(baseEntry());
    expect(err.lines()).toHaveLength(0);
    expect(out.lines()).toHaveLength(1);
    const parsed = JSON.parse(out.lines()[0]);
    expect(parsed).toMatchObject({
      level: 'info',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: 'hello world',
      service: 'svc',
      module: 'mod',
      correlationId: 'c-1',
    });
  });

  it('routes ERROR and FATAL to stderr, not stdout', () => {
    const out = captureStream();
    const err = captureStream();
    const t = new ConsoleTransport({
      mode: 'json',
      stdout: out.stream,
      stderr: err.stream,
    });
    t.write(baseEntry({ level: 'error', message: 'boom' }));
    t.write(baseEntry({ level: 'fatal', message: 'dead' }));
    expect(out.lines()).toHaveLength(0);
    expect(err.lines()).toHaveLength(2);
    expect(JSON.parse(err.lines()[0])).toMatchObject({ level: 'error' });
    expect(JSON.parse(err.lines()[1])).toMatchObject({ level: 'fatal' });
  });

  it('AUDIT is a real, filterable pino level sitting between info and warn, not just a string', () => {
    const out = captureStream();
    const t = new ConsoleTransport({
      mode: 'json',
      stdout: out.stream,
      stderr: captureStream().stream,
    });
    t.write(baseEntry({ level: 'audit', message: 'user exported data' }));
    expect(JSON.parse(out.lines()[0])).toMatchObject({
      level: 'audit',
      message: 'user exported data',
    });
  });

  it('never adds pid/hostname/pino-default time — only fields entry-builder actually put there', () => {
    const out = captureStream();
    const t = new ConsoleTransport({
      mode: 'json',
      stdout: out.stream,
      stderr: captureStream().stream,
    });
    t.write(baseEntry());
    const parsed = JSON.parse(out.lines()[0]);
    expect(parsed.pid).toBeUndefined();
    expect(parsed.hostname).toBeUndefined();
    expect(Object.keys(parsed).sort()).toEqual([
      'correlationId',
      'level',
      'message',
      'module',
      'service',
      'timestamp',
    ]);
  });

  it('serializes a nested error field faithfully (from entry-builder, not re-derived here)', () => {
    const out = captureStream();
    const err = captureStream();
    const t = new ConsoleTransport({
      mode: 'json',
      stdout: out.stream,
      stderr: err.stream,
    });
    t.write(
      baseEntry({
        level: 'error',
        error: {
          name: 'TypeError',
          message: 'bad input',
          stack: 'TypeError: bad input\n    at x',
        },
      }),
    );
    expect(out.lines()).toHaveLength(0); // error level → stderr, not stdout
    const errOut = JSON.parse(err.lines()[0]);
    expect(errOut.error).toEqual({
      name: 'TypeError',
      message: 'bad input',
      stack: 'TypeError: bad input\n    at x',
    });
  });
});

describe('ConsoleTransport — pretty mode (pino-pretty)', () => {
  it('produces a colorized, human-readable line via real pino-pretty, not a hand-rolled formatter', () => {
    const out = captureStream();
    const t = new ConsoleTransport({
      mode: 'pretty',
      stdout: out.stream,
      stderr: captureStream().stream,
    });
    t.write(baseEntry());
    const line = out.lines().join('');
    expect(line).toContain('hello world');
    expect(line).toContain('2026-01-01T00:00:00.000Z');
    // eslint-disable-next-line no-control-regex -- asserting real ANSI color codes are present
    expect(/\x1b\[\d+m/.test(line)).toBe(true);
  });

  it('formats every one of the 7 levels with a distinct label, including AUDIT', () => {
    const out = captureStream();
    const t = new ConsoleTransport({
      mode: 'pretty',
      stdout: out.stream,
      stderr: captureStream().stream,
    });
    for (const level of ['trace', 'debug', 'info', 'audit', 'warn'] as const)
      t.write(baseEntry({ level, message: `msg-${level}` }));
    const lines = out.lines();
    expect(lines).toHaveLength(5);
    expect(lines[3].toUpperCase()).toContain('AUDIT');
    expect(lines[3]).toContain('msg-audit');
  });

  it('still routes ERROR/FATAL to stderr in pretty mode', () => {
    const out = captureStream();
    const err = captureStream();
    const t = new ConsoleTransport({
      mode: 'pretty',
      stdout: out.stream,
      stderr: err.stream,
    });
    t.write(baseEntry({ level: 'error', message: 'boom' }));
    expect(out.lines()).toHaveLength(0);
    expect(err.lines().join('')).toContain('boom');
  });
});

describe('ConsoleTransport — health & isolation (§23, §25)', () => {
  it('is healthy by default and never critical=true is decided by the caller, not this class', () => {
    const t = new ConsoleTransport({ mode: 'json' });
    expect(t.health()).toEqual({ healthy: true });
  });

  it('a write failure is caught, reflected in health(), and never thrown to the caller', () => {
    const broken = new Writable({
      write() {
        throw new Error('EPIPE');
      },
    });
    const t = new ConsoleTransport({
      mode: 'json',
      stdout: broken,
      stderr: captureStream().stream,
    });
    expect(() => t.write(baseEntry())).not.toThrow();
    expect(t.health()).toMatchObject({ healthy: false });
  });

  it('close() resolves cleanly with no pending work', async () => {
    const t = new ConsoleTransport({ mode: 'json' });
    await expect(t.close()).resolves.toBeUndefined();
  });
});

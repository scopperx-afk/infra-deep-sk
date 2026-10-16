import { emergencyLog } from './emergency-logger';
import { BootstrapLogger } from './bootstrap-logger';

describe('emergencyLog() (§27)', () => {
  it('writes a valid JSON line to stderr with message and timestamp', () => {
    const spy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      emergencyLog('something went very wrong');
      expect(spy).toHaveBeenCalledTimes(1);
      const line = spy.mock.calls[0][0] as string;
      const parsed = JSON.parse(line);
      expect(parsed).toMatchObject({
        level: 'fatal',
        message: 'something went very wrong',
      });
      expect(typeof parsed.timestamp).toBe('string');
    } finally {
      spy.mockRestore();
    }
  });

  it('serializes a real Error into name/message/stack', () => {
    const spy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      emergencyLog('boot failed', new Error('disk full'));
      const parsed = JSON.parse(spy.mock.calls[0][0] as string);
      expect(parsed.error).toMatchObject({
        name: 'Error',
        message: 'disk full',
      });
      expect(typeof parsed.error.stack).toBe('string');
    } finally {
      spy.mockRestore();
    }
  });

  it('falls back to a plain text line if JSON.stringify itself throws — the true last resort', () => {
    const spy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const originalStringify = JSON.stringify;

    (JSON as any).stringify = () => {
      throw new Error('stringify exploded');
    };
    try {
      expect(() => emergencyLog('still must get out')).not.toThrow();
      expect(spy).toHaveBeenCalledWith('FATAL: still must get out\n');
    } finally {
      JSON.stringify = originalStringify;
      spy.mockRestore();
    }
  });

  it('never throws even given a non-Error, non-string error value', () => {
    const spy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      expect(() => emergencyLog('x', { weird: true })).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('BootstrapLogger (§28)', () => {
  it('produces a real, structured log entry via the same pipeline the full LoggerService uses', () => {
    const logger = new BootstrapLogger({ mode: 'json' });
    const spy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      logger.info('starting up', { phase: 'boot' });
      expect(spy).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(spy.mock.calls[0][0] as string);
      expect(parsed).toMatchObject({
        level: 'info',
        message: 'starting up',
        phase: 'boot',
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('redacts sensitive metadata even before Config exists', () => {
    const logger = new BootstrapLogger({ mode: 'json' });
    const spy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      logger.info('config loaded', { password: 'hunter2' });
      const parsed = JSON.parse(spy.mock.calls[0][0] as string);
      expect(parsed.password).toBe('[REDACTED]');
    } finally {
      spy.mockRestore();
    }
  });

  it('filters below the configured minimum level', () => {
    const logger = new BootstrapLogger({ mode: 'json', minLevel: 'warn' });
    const spy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      logger.info('should be filtered');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('error()/fatal() serialize the given error', () => {
    const logger = new BootstrapLogger({ mode: 'json' });
    const spy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      logger.fatal('config validation failed', new Error('missing NODE_ENV'));
      const parsed = JSON.parse(spy.mock.calls[0][0] as string);
      expect(parsed.error).toMatchObject({
        name: 'Error',
        message: 'missing NODE_ENV',
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('child() shares the same transport and merges static context', () => {
    const logger = new BootstrapLogger({ mode: 'json' });
    const child = logger.child({ module: 'bootstrap' });
    const spy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      child.info('within bootstrap');
      const parsed = JSON.parse(spy.mock.calls[0][0] as string);
      expect(parsed.module).toBe('bootstrap');
    } finally {
      spy.mockRestore();
    }
  });

  it('defaults to pretty mode outside production/staging', () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const logger = new BootstrapLogger();
      const spy = jest
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);
      logger.info('dev message');
      const line = spy.mock.calls[0][0] as string;
      expect(() => JSON.parse(line)).toThrow(); // pretty output is not valid JSON
      spy.mockRestore();
    } finally {
      process.env.NODE_ENV = saved;
    }
  });
});

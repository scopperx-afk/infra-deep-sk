import { Inject, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { LOGGER_SERVICE } from '../logger.tokens';
import type { ILogger } from '../logger.port';
import { InjectLogger } from './inject-logger.decorator';
import { LogMethod } from './log-method.decorator';

function fakeLogger(): ILogger & {
  calls: Array<{ fn: string; args: unknown[] }>;
} {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const self = {
    calls,
    trace: (...a: unknown[]) => calls.push({ fn: 'trace', args: a }),
    debug: (...a: unknown[]) => calls.push({ fn: 'debug', args: a }),
    info: (...a: unknown[]) => calls.push({ fn: 'info', args: a }),
    audit: (...a: unknown[]) => calls.push({ fn: 'audit', args: a }),
    warn: (...a: unknown[]) => calls.push({ fn: 'warn', args: a }),
    error: (...a: unknown[]) => calls.push({ fn: 'error', args: a }),
    fatal: (...a: unknown[]) => calls.push({ fn: 'fatal', args: a }),
    child: () => self,
  } as unknown as ILogger & { calls: typeof calls };
  return self;
}

describe('@InjectLogger() (§32)', () => {
  it('resolves LOGGER_SERVICE through real Nest DI — an end-to-end proof it is Inject(LOGGER_SERVICE), not a second mechanism', async () => {
    const sentinel = { marker: 'this-is-the-logger' };

    @Injectable()
    class Consumer {
      constructor(@InjectLogger() public readonly logger: ILogger) {}
    }

    @Module({
      providers: [Consumer, { provide: LOGGER_SERVICE, useValue: sentinel }],
    })
    class TestModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [TestModule],
    }).compile();
    const consumer = moduleRef.get(Consumer);
    expect(consumer.logger).toBe(sentinel);
    await moduleRef.close();
  });
});

describe('@LogMethod() (§32)', () => {
  class Service {
    logger = fakeLogger();

    @LogMethod()
    syncOk(x: number): number {
      return x * 2;
    }

    @LogMethod()
    syncThrows(): never {
      throw new Error('sync fail');
    }

    @LogMethod()
    async asyncOk(x: number): Promise<number> {
      await Promise.resolve();
      return x + 1;
    }

    @LogMethod()
    async asyncThrows(): Promise<never> {
      await Promise.resolve();
      throw new Error('async fail');
    }

    @LogMethod({ operation: 'customOp' })
    withCustomName(): string {
      return 'ok';
    }

    @LogMethod({ loggerProperty: 'altLogger' })
    withAltLoggerProperty(): string {
      return 'ok';
    }

    altLogger = fakeLogger();

    noLoggerAtAll(): string {
      return 'passthrough';
    }
  }

  it('records start and completion for a synchronous method, via a CHILD logger bound to the operation', () => {
    const s = new Service();
    const result = s.syncOk(21);
    expect(result).toBe(42);
    const fns = s.logger.calls.map((c) => c.fn);
    expect(fns).toEqual(['debug', 'debug']); // started, completed
    expect(s.logger.calls[0].args[0]).toBe('syncOk started');
    expect(s.logger.calls[1].args[0]).toBe('syncOk completed');
  });

  it('records failure via error(), with the durationMs metadata, and re-throws unchanged', () => {
    const s = new Service();
    expect(() => s.syncThrows()).toThrow('sync fail');
    expect(s.logger.calls.map((c) => c.fn)).toEqual(['debug', 'error']);
    expect(s.logger.calls[1].args[0]).toBe('syncThrows failed');
    expect(s.logger.calls[1].args[1]).toBeInstanceOf(Error);
  });

  it('awaits an async method before logging completion, and returns its resolved value', async () => {
    const s = new Service();
    const result = await s.asyncOk(1);
    expect(result).toBe(2);
    expect(s.logger.calls.map((c) => c.fn)).toEqual(['debug', 'debug']);
    expect(s.logger.calls[1].args[0]).toBe('asyncOk completed');
  });

  it('logs an async rejection as error() and rejects with the original error unchanged', async () => {
    const s = new Service();
    await expect(s.asyncThrows()).rejects.toThrow('async fail');
    expect(s.logger.calls.map((c) => c.fn)).toEqual(['debug', 'error']);
  });

  it('uses a custom operation name when given, instead of the method name', () => {
    const s = new Service();
    s.withCustomName();
    expect(s.logger.calls[0].args[0]).toBe('customOp started');
  });

  it('reads the logger off a custom property name when configured', () => {
    const s = new Service();
    s.withAltLoggerProperty();
    expect(s.altLogger.calls).toHaveLength(2);
    expect(s.logger.calls).toHaveLength(0); // the default 'logger' property was never touched
  });

  it('calls straight through with no decoration at all when the instance has no logger property (never breaks the method)', () => {
    const s = new Service();
    expect(s.noLoggerAtAll()).toBe('passthrough');
  });
});

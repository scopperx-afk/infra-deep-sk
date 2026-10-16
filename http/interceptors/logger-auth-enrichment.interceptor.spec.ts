import { of } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigModule, staticSource } from '../../config';
import { TracingModule } from '../../tracing';
import { LoggerModule, LOGGER_SERVICE, withLogContext, type ILogger, type LogEntry, type LoggerExtraTransport } from '../../logger';
import { LoggerAuthEnrichmentInterceptor } from './logger-auth-enrichment.interceptor';

const BASE_ENV = { NODE_ENV: 'test', APP__NAME: 'x', APP__FRONTEND_URL: 'http://x' };

class FakeTransport implements LoggerExtraTransport {
  readonly name = 'fake';
  readonly entries: LogEntry[] = [];
  write(entry: LogEntry): void {
    this.entries.push(entry);
  }
  health() {
    return { healthy: true };
  }
  async close(): Promise<void> {}
}

function fakeContext(user?: { id?: string | number; sub?: string | number }): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => ({ user }) }) } as unknown as ExecutionContext;
}
const fakeHandler = (): CallHandler => ({ handle: () => of({ ok: true }) });

async function buildLogger(): Promise<{ logger: ILogger; fake: FakeTransport }> {
  const fake = new FakeTransport();
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ sources: [staticSource(BASE_ENV)], exitOnValidationFailure: false, onNotice: () => undefined }),
      TracingModule.forRoot(),
      LoggerModule.forRoot({ transports: [fake] }),
    ],
  }).compile();
  return { logger: moduleRef.get<ILogger>(LOGGER_SERVICE), fake };
}

describe('LoggerAuthEnrichmentInterceptor (§3 step 6a, §13)', () => {
  it('enriches LogContext.userId from req.user.id — observable on the next log line written', async () => {
    const { logger, fake } = await buildLogger();
    const interceptor = new LoggerAuthEnrichmentInterceptor();
    await withLogContext({}, async () => {
      await new Promise<void>((resolve) => {
        interceptor.intercept(fakeContext({ id: 'u-42' }), fakeHandler()).subscribe(() => resolve());
      });
      logger.info('after auth');
    });
    expect(fake.entries[0]?.userId).toBe('u-42');
  });

  it('falls back to the JWT-standard "sub" claim when "id" is absent', async () => {
    const { logger, fake } = await buildLogger();
    const interceptor = new LoggerAuthEnrichmentInterceptor();
    await withLogContext({}, async () => {
      await new Promise<void>((resolve) => {
        interceptor.intercept(fakeContext({ sub: 'u-sub-1' }), fakeHandler()).subscribe(() => resolve());
      });
      logger.info('after auth');
    });
    expect(fake.entries[0]?.userId).toBe('u-sub-1');
  });

  it('prefers "id" over "sub" when both are present', async () => {
    const { logger, fake } = await buildLogger();
    const interceptor = new LoggerAuthEnrichmentInterceptor();
    await withLogContext({}, async () => {
      await new Promise<void>((resolve) => {
        interceptor.intercept(fakeContext({ id: 'u-id-1', sub: 'u-sub-1' }), fakeHandler()).subscribe(() => resolve());
      });
      logger.info('after auth');
    });
    expect(fake.entries[0]?.userId).toBe('u-id-1');
  });

  it('coerces a numeric id to a string (userId is typed string)', async () => {
    const { logger, fake } = await buildLogger();
    const interceptor = new LoggerAuthEnrichmentInterceptor();
    await withLogContext({}, async () => {
      await new Promise<void>((resolve) => {
        interceptor.intercept(fakeContext({ id: 12345 }), fakeHandler()).subscribe(() => resolve());
      });
      logger.info('after auth');
    });
    expect(fake.entries[0]?.userId).toBe('12345');
  });

  it('is a safe no-op when req.user is absent entirely (no Security built yet) — never throws, no userId added', async () => {
    const { logger, fake } = await buildLogger();
    const interceptor = new LoggerAuthEnrichmentInterceptor();
    await expect(
      withLogContext({}, async () => {
        await new Promise<void>((resolve) => {
          interceptor.intercept(fakeContext(undefined), fakeHandler()).subscribe(() => resolve());
        });
        logger.info('after auth');
      }),
    ).resolves.not.toThrow();
    expect('userId' in fake.entries[0]).toBe(false);
  });

  it('still calls next.handle() and passes through its result unchanged', (done) => {
    const interceptor = new LoggerAuthEnrichmentInterceptor();
    interceptor.intercept(fakeContext({ id: 'u-1' }), fakeHandler()).subscribe((value) => {
      expect(value).toEqual({ ok: true });
      done();
    });
  });
});

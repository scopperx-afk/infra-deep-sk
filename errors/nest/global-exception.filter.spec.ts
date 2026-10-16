import type { ArgumentsHost } from '@nestjs/common';
import type { ILogger } from '../../logger';
import type { ErrorMapper, MappedError } from '../mapping/error-mapper.port';
import type { ErrorsMetricsCollector } from '../metrics/errors.metrics';
import { GlobalExceptionFilter } from './global-exception.filter';

function fakeHost(res: { status: jest.Mock }): ArgumentsHost {
  return {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => ({}),
      getNext: () => undefined,
    }),
  } as unknown as ArgumentsHost;
}

describe('GlobalExceptionFilter (§8)', () => {
  const mapped: MappedError = {
    status: 404,
    body: { code: 'NOT_FOUND', message: 'not found' },
    category: 'domain',
  };

  it('calls the mapper once, writes status+json on the response, logs by OUTCOME (404 → INFO, not ERROR), and records the metric — in that data flow', () => {
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const mapper: ErrorMapper = { mapToErrorResponse: jest.fn(() => mapped) };
    const logger: ILogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() } as unknown as ILogger;
    const metrics: ErrorsMetricsCollector = {
      record: jest.fn(),
      getMetricsSnapshot: jest.fn(),
    };

    const filter = new GlobalExceptionFilter(mapper, logger, metrics);
    const exception = new Error('boom');
    filter.catch(exception, fakeHost({ status }));

    expect(mapper.mapToErrorResponse).toHaveBeenCalledWith(exception);
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(mapped.body);
    expect(logger.error).not.toHaveBeenCalled(); // a client error is not an error-level event
    expect(logger.info).toHaveBeenCalledWith('Request rejected', {
      code: 'NOT_FOUND',
      status: 404,
      errorName: 'Error',
    });
    expect(metrics.record).toHaveBeenCalledWith('domain', 404, 'NOT_FOUND');
  });

  it('logs and records even when the exception has no message of its own (a thrown non-Error)', () => {
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const mapper: ErrorMapper = {
      mapToErrorResponse: jest.fn(() => ({
        status: 500,
        body: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
        category: 'unknown' as const,
      })),
    };
    const logger: ILogger = { error: jest.fn() } as unknown as ILogger;
    const metrics: ErrorsMetricsCollector = {
      record: jest.fn(),
      getMetricsSnapshot: jest.fn(),
    };

    const filter = new GlobalExceptionFilter(mapper, logger, metrics);
    filter.catch('a plain string throw', fakeHost({ status }));

    expect(logger.error).toHaveBeenCalledWith(
      'Unhandled exception',
      'a plain string throw',
      { code: 'INTERNAL_ERROR', status: 500 },
    );
    expect(metrics.record).toHaveBeenCalledWith(
      'unknown',
      500,
      'INTERNAL_ERROR',
    );
    expect(status).toHaveBeenCalledWith(500);
  });
});
